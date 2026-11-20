// All write actions on a patient record. Each branch checks role permission AND
// patient-level access on the server before touching data, then writes an audit entry.
import { z } from "zod";
import { prisma, withLock } from "@/lib/db";
import { audit, HttpError, requirePatientAccess, requireUser, route } from "@/lib/auth";
import { evaluateReadings, loadAlertContext, loadLimits, raiseAlert } from "@/lib/alerts";
import { generatePatientSummary } from "@/lib/ai";
import { patientScope } from "@/lib/permissions";
import { setPatientDevices, UNITS } from "@/lib/simulator";
import { DEFAULT_LIMITS, SOURCE_LABEL, THRESHOLD_VITALS, type LatestMap, type ThresholdVital, type VitalType } from "@/lib/types";

const RANGE: Record<VitalType, [number, number]> = {
  HR: [20, 250],
  SPO2: [50, 100],
  BP: [50, 260],
  TEMP: [30, 43],
  RR: [4, 60],
  GLUCOSE: [20, 600],
  WEIGHT: [20, 300],
};
const readingSchema = z
  .object({
    type: z.enum(["HR", "SPO2", "BP", "TEMP", "RR", "GLUCOSE", "WEIGHT"]),
    value: z.number().finite(),
    value2: z.number().finite().min(30).max(160).optional(),
  })
  .refine((r) => r.value >= RANGE[r.type][0] && r.value <= RANGE[r.type][1], { message: "value is outside the range this form accepts" })
  .refine((r) => r.type !== "BP" || r.value2 != null, { message: "diastolic value is required for blood pressure" });

const CHECKIN_INTERVAL_MS = 4 * 3600_000;
const nullableNum = z.number().finite().nullable();

export const POST = route<{ id: string; action: string }>(async (req, { id, action }) => {
  const session = await requireUser(); // 401 before anything else is revealed
  if (!patientScope(session, id)) throw new HttpError(403, "You do not have access to this patient record");
  const body = await req.json().catch(() => ({}));
  const exists = await prisma.patient.findUnique({ where: { id } });
  if (!exists) throw new HttpError(404, "Patient not found");
  const now = new Date();

  switch (action) {
    case "readings": {
      const { user } = await requirePatientAccess(id, "reading:submit");
      const input = z.object({ readings: z.array(readingSchema).min(1).max(8), comment: z.string().max(500).optional() }).parse(body);
      const source = user.role === "PATIENT" ? "PATIENT_REPORTED" : user.role === "CAREGIVER" ? "CAREGIVER_REPORTED" : "CLINICIAN_ENTERED";
      return withLock(async () => {
        const p = await prisma.patient.findUniqueOrThrow({ where: { id } });
        await prisma.reading.createMany({
          data: input.readings.map((r) => ({ patientId: id, type: r.type, value: r.value, value2: r.value2 ?? null, unit: UNITS[r.type], source, takenAt: now })),
        });
        const latest: LatestMap = JSON.parse(p.latestJson || "{}");
        for (const r of input.readings) latest[r.type] = { v: r.value, v2: r.value2 ?? null, t: now.toISOString(), src: source };
        await prisma.patient.update({
          where: { id },
          data: {
            latestJson: JSON.stringify(latest),
            lastReadingAt: now,
            lastContactAt: now,
            // A submitted observation set counts as the scheduled check-in.
            ...(p.nextCheckInDueAt ? { nextCheckInDueAt: new Date(now.getTime() + CHECKIN_INTERVAL_MS) } : {}),
          },
        });
        const limits = await loadLimits();
        const ctx = await loadAlertContext(prisma, now);
        const raised = await evaluateReadings(prisma, id, input.readings, limits.forPatient(id), ctx.active, ctx.recentlyResolved, now, SOURCE_LABEL[source]);
        await audit(user, "READINGS_SUBMITTED", {
          patientId: id,
          detail: `${SOURCE_LABEL[source]}: ${input.readings.map((r) => `${r.type} ${r.value}${r.value2 != null ? `/${r.value2}` : ""}`).join(", ")}${input.comment ? ` — "${input.comment}"` : ""}`,
        });
        return { ok: true, alertsRaised: raised.length };
      });
    }

    case "symptoms": {
      const { user } = await requirePatientAccess(id, "symptom:submit");
      const input = z.object({ text: z.string().trim().min(3).max(600), severity: z.enum(["MILD", "MODERATE", "SEVERE"]) }).parse(body);
      const s = await prisma.symptom.create({ data: { patientId: id, text: input.text, severity: input.severity, reportedById: user.id, reportedBy: `${user.name} (${user.role.toLowerCase()})` } });
      if (input.severity !== "MILD") {
        const ctx = await loadAlertContext(prisma, now);
        await raiseAlert(
          prisma,
          id,
          { kind: "SYMPTOM", vital: null, severity: "WARNING", title: `${input.severity === "SEVERE" ? "Severe" : "Moderate"} symptom reported by ${user.role.toLowerCase()}`, message: `"${input.text}" — requires clinician review.` },
          ctx.active,
          ctx.recentlyResolved,
          now,
        );
      }
      await audit(user, "SYMPTOM_REPORTED", { patientId: id, detail: `${input.severity}: ${input.text}` });
      return { ok: true, id: s.id };
    }

    case "symptom-review": {
      const { user } = await requirePatientAccess(id, "symptom:review");
      const { symptomId } = z.object({ symptomId: z.string() }).parse(body);
      const s = await prisma.symptom.findFirst({ where: { id: symptomId, patientId: id } });
      if (!s) throw new HttpError(404, "Symptom not found");
      await prisma.symptom.update({ where: { id: s.id }, data: { reviewedAt: now, reviewedById: user.id } });
      await audit(user, "SYMPTOM_REVIEWED", { patientId: id, detail: s.text });
      return { ok: true };
    }

    case "notes": {
      const input = z.object({ kind: z.enum(["NOTE", "OBSERVATION", "CHECKIN", "ASSESSMENT"]), body: z.string().trim().min(3).max(4000) }).parse(body);
      const perm = input.kind === "ASSESSMENT" ? "assessment:complete" : input.kind === "CHECKIN" ? "checkin:record" : "note:create";
      const { user, scope } = await requirePatientAccess(id, perm);
      if (scope !== "clinical") throw new HttpError(403, "Only the clinical team can write to the clinical record");
      await prisma.note.create({ data: { patientId: id, authorId: user.id, authorName: user.name, authorRole: user.role, kind: input.kind, body: input.body } });
      if (input.kind === "ASSESSMENT") {
        await prisma.patient.update({ where: { id }, data: { awaitingAssessment: false, lastContactAt: now } });
        await prisma.task.updateMany({ where: { patientId: id, status: "OPEN", title: { contains: "admission assessment" } }, data: { status: "DONE", completedAt: now, completedBy: user.name } });
      }
      if (input.kind === "CHECKIN") {
        await prisma.patient.update({ where: { id }, data: { lastContactAt: now, ...(exists.nextCheckInDueAt ? { nextCheckInDueAt: new Date(now.getTime() + CHECKIN_INTERVAL_MS) } : {}) } });
      }
      await audit(user, input.kind === "ASSESSMENT" ? "ASSESSMENT_RECORDED" : input.kind === "CHECKIN" ? "CHECKIN_RECORDED" : "NOTE_ADDED", { patientId: id, detail: input.body.slice(0, 160) });
      return { ok: true };
    }

    case "tasks": {
      const { user } = await requirePatientAccess(id, "task:create");
      const input = z.object({ title: z.string().trim().min(3).max(200), assigneeRole: z.enum(["NURSE", "DOCTOR", "CAREGIVER", "PATIENT"]), dueInMinutes: z.number().int().min(5).max(7 * 24 * 60).optional() }).parse(body);
      await prisma.task.create({
        data: { patientId: id, title: input.title, assigneeRole: input.assigneeRole, dueAt: input.dueInMinutes ? new Date(now.getTime() + input.dueInMinutes * 60_000) : null, createdById: user.id, createdByName: user.name },
      });
      await audit(user, "TASK_CREATED", { patientId: id, detail: `${input.title} → ${input.assigneeRole.toLowerCase()}` });
      return { ok: true };
    }

    case "messages": {
      const { user } = await requirePatientAccess(id, "message:send");
      const input = z.object({ body: z.string().trim().min(1).max(1500) }).parse(body);
      await prisma.message.create({ data: { patientId: id, senderId: user.id, senderName: user.name, senderRole: user.role, body: input.body } });
      if (user.role === "DOCTOR" || user.role === "NURSE") await prisma.patient.update({ where: { id }, data: { lastContactAt: now } });
      await audit(user, "MESSAGE_SENT", { patientId: id, detail: "Secure message sent" });
      return { ok: true };
    }

    case "summary": {
      const { user } = await requirePatientAccess(id, "summary:generate");
      const out = await generatePatientSummary(id, user.name);
      await audit(user, "AI_SUMMARY_GENERATED", { patientId: id, detail: `Engine: ${out.engine}` });
      return out;
    }

    case "thresholds": {
      const { user } = await requirePatientAccess(id, "threshold:edit");
      const input = z
        .object({ vital: z.enum(Object.keys(THRESHOLD_VITALS) as [ThresholdVital, ...ThresholdVital[]]), reset: z.boolean().optional(), critLow: nullableNum.optional(), warnLow: nullableNum.optional(), warnHigh: nullableNum.optional(), critHigh: nullableNum.optional() })
        .parse(body);
      if (input.reset) {
        await prisma.threshold.deleteMany({ where: { patientId: id, vital: input.vital } });
        await audit(user, "LIMITS_RESET", { patientId: id, detail: `${THRESHOLD_VITALS[input.vital].label} returned to programme default` });
        return { ok: true };
      }
      const l = { critLow: input.critLow ?? null, warnLow: input.warnLow ?? null, warnHigh: input.warnHigh ?? null, critHigh: input.critHigh ?? null };
      const seq = [l.critLow, l.warnLow, l.warnHigh, l.critHigh].filter((x): x is number => x != null);
      if (seq.some((x, i) => i > 0 && x <= seq[i - 1])) throw new HttpError(400, "Limits must increase: critical low < review low < review high < critical high");
      if (seq.length === 0) throw new HttpError(400, "Set at least one limit, or reset to the programme default");
      await prisma.threshold.upsert({
        where: { patientId_vital: { patientId: id, vital: input.vital } },
        create: { patientId: id, vital: input.vital, ...l, updatedBy: user.name },
        update: { ...l, updatedBy: user.name },
      });
      await audit(user, "LIMITS_CONFIGURED", { patientId: id, detail: `${THRESHOLD_VITALS[input.vital].label}: critical low ${l.critLow ?? "—"}, review low ${l.warnLow ?? "—"}, review high ${l.warnHigh ?? "—"}, critical high ${l.critHigh ?? "—"} (default ${JSON.stringify(DEFAULT_LIMITS[input.vital])})` });
      return { ok: true };
    }

    case "consult": {
      const input = z.object({ consultId: z.string().optional(), status: z.enum(["REQUESTED", "IN_PROGRESS", "COMPLETED"]).default("REQUESTED"), reason: z.string().trim().max(400).optional() }).parse(body);
      if (input.status === "REQUESTED") {
        const { user } = await requirePatientAccess(id, "consult:request");
        const open = await prisma.consult.findFirst({ where: { patientId: id, status: { not: "COMPLETED" } } });
        if (open) throw new HttpError(409, "A consultation request is already open");
        await prisma.consult.create({ data: { patientId: id, requestedById: user.id, requestedBy: `${user.name} (${user.role.toLowerCase()})`, reason: input.reason ?? "" } });
        await prisma.task.create({ data: { patientId: id, title: `Consultation requested by ${user.name}${input.reason ? `: ${input.reason}` : ""}`, assigneeRole: "DOCTOR", dueAt: new Date(now.getTime() + 30 * 60_000), createdById: user.id, createdByName: user.name } });
        await audit(user, "CONSULT_REQUESTED", { patientId: id, detail: input.reason ?? "" });
        return { ok: true };
      }
      const { user } = await requirePatientAccess(id, "consult:manage");
      let c = input.consultId ? await prisma.consult.findFirst({ where: { id: input.consultId, patientId: id } }) : await prisma.consult.findFirst({ where: { patientId: id, status: { not: "COMPLETED" } }, orderBy: { createdAt: "desc" } });
      if (!c && input.status === "IN_PROGRESS") {
        c = await prisma.consult.create({ data: { patientId: id, requestedById: user.id, requestedBy: `${user.name} (${user.role.toLowerCase()})`, reason: input.reason ?? "Clinician-initiated" } });
      }
      if (!c) throw new HttpError(404, "No open consultation");
      await prisma.consult.update({ where: { id: c.id }, data: input.status === "IN_PROGRESS" ? { status: "IN_PROGRESS", startedAt: now } : { status: "COMPLETED", endedAt: now } });
      if (input.status === "IN_PROGRESS") await prisma.patient.update({ where: { id }, data: { lastContactAt: now } });
      if (input.status === "COMPLETED") await prisma.task.updateMany({ where: { patientId: id, status: "OPEN", title: { startsWith: "Consultation requested" } }, data: { status: "DONE", completedAt: now, completedBy: user.name } });
      await audit(user, input.status === "IN_PROGRESS" ? "CONSULT_STARTED" : "CONSULT_COMPLETED", { patientId: id });
      return { ok: true, consultId: c.id };
    }

    case "device": {
      const { user } = await requirePatientAccess(id, "device:manage");
      const input = z.object({ deviceId: z.string().optional(), status: z.enum(["CONNECTED", "DISCONNECTED"]) }).parse(body);
      if (input.deviceId && !(await prisma.device.findFirst({ where: { id: input.deviceId, patientId: id, streaming: true } }))) throw new HttpError(404, "Streaming device not found for this patient");
      await setPatientDevices(id, input.status, input.deviceId);
      await audit(user, input.status === "CONNECTED" ? "DEVICE_CONNECTED" : "DEVICE_DISCONNECTED", { patientId: id, detail: `Simulated device adapter ${input.status.toLowerCase()}` });
      return { ok: true };
    }

    case "medlog": {
      const { user } = await requirePatientAccess(id, "med:log");
      const { medicationId } = z.object({ medicationId: z.string() }).parse(body);
      const m = await prisma.medication.findFirst({ where: { id: medicationId, patientId: id } });
      if (!m) throw new HttpError(404, "Medication not found");
      await prisma.medicationLog.create({ data: { medicationId: m.id, recordedBy: `${user.name} (${user.role.toLowerCase()})` } });
      await audit(user, "MEDICATION_LOGGED", { patientId: id, detail: `${m.name} ${m.dose} recorded as taken` });
      return { ok: true };
    }

    case "ecg": {
      const { user } = await requirePatientAccess(id, "patient:clinical");
      const patch = await prisma.device.findFirst({ where: { patientId: id, deviceType: "WEARABLE_PATCH" } });
      if (!patch) throw new HttpError(400, "This patient has no ECG-capable device");
      if (patch.status !== "CONNECTED") throw new HttpError(409, "ECG device is disconnected — no signal to capture");
      const latest: LatestMap = JSON.parse(exists.latestJson || "{}");
      await prisma.ecgStrip.create({ data: { patientId: id, deviceId: patch.id, takenAt: now, heartRate: Math.round(latest.HR?.v ?? 75), irregular: exists.ecgIrregular, seed: (Math.random() * 1e9) | 0, label: `Captured by ${user.name}` } });
      await audit(user, "ECG_STRIP_CAPTURED", { patientId: id, detail: "10 s simulated strip saved" });
      return { ok: true };
    }

    default:
      throw new HttpError(404, `Unknown action "${action}"`);
  }
});
