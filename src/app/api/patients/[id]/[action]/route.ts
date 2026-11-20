// All write actions on a patient record. Each branch checks role permission AND
// patient-level access on the server before touching data, then writes an audit entry.
import { z } from "zod";
import { prisma, withLock } from "@/lib/db";
import { audit, HttpError, requirePatientAccess, requireUser, route, requireDemoMode } from "@/lib/auth";
import { evaluateReadings, loadAlertContext, loadLimits, raiseAlert, checkWeightTrend } from "@/lib/alerts";
import { generatePatientSummary } from "@/lib/ai";
import { patientScope } from "@/lib/permissions";
import { setPatientDevices, UNITS } from "@/lib/simulator";
import { DEFAULT_LIMITS, RED_FLAG_ORDER, RED_FLAGS, SOURCE_LABEL, THRESHOLD_VITALS, TRANSFER_PATHWAYS, WEARABLE_PLATFORMS, type RedFlag, type LatestMap, type ThresholdVital, type VitalType } from "@/lib/types";
import { detectRedFlags } from "@/lib/triage";
import { DEVICE_INGEST_PATH, demoHubBundle, ingestGatewayBatch, newHubToken, parseGatewayPayload } from "@/lib/gateway";
import { AMBULANCE_SERVICE, EMERGENCY_NUMBER, cancelTransfer, RECEIVING_HOSPITAL, requestTransfer, skipStage, suggestTransfer, tickChecklist, TIME_SCALE, urgentHelp } from "@/lib/transfers";
import { demoHealthAutoExportPayload, INGEST_PATH, ingestWearableBatch, newWearableToken, parseWearablePayload, type DemoScenario } from "@/lib/wearables";

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
      // Readings normally arrive from devices (home hub / monitoring devices). Patients and caregivers
      // can type them only when a clinician has switched on the manual fallback (e.g. a faulty device).
      if (user.role === "PATIENT" || user.role === "CAREGIVER") {
        const pm = await prisma.patient.findUniqueOrThrow({ where: { id }, select: { manualEntry: true } });
        if (!pm.manualEntry) throw new HttpError(403, "Readings are sent automatically by the monitoring devices. Manual entry is switched off — the care team can enable it if a device is not working.");
      }
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
        if (input.readings.some((r) => r.type === "WEIGHT") && (await checkWeightTrend(prisma, id, ctx.active, ctx.recentlyResolved, now))) raised.push(ctx.active[ctx.active.length - 1]);
        await audit(user, "READINGS_SUBMITTED", {
          patientId: id,
          detail: `${SOURCE_LABEL[source]}: ${input.readings.map((r) => `${r.type} ${r.value}${r.value2 != null ? `/${r.value2}` : ""}`).join(", ")}${input.comment ? ` — "${input.comment}"` : ""}`,
        });
        return { ok: true, alertsRaised: raised.length };
      });
    }

    case "symptoms": {
      const { user } = await requirePatientAccess(id, "symptom:submit");
      const input = z
        .object({ text: z.string().trim().min(3).max(600), severity: z.enum(["MILD", "MODERATE", "SEVERE"]), redFlags: z.array(z.enum(RED_FLAG_ORDER as [RedFlag, ...RedFlag[]])).max(8).default([]) })
        .parse(body);
      // Red flags: ticked boxes + keyword detection (EN/AR). Deterministic — never waits for AI.
      const flags = RED_FLAG_ORDER.filter((f) => input.redFlags.includes(f) || detectRedFlags(input.text).includes(f));
      const severity = flags.length ? "SEVERE" : input.severity;
      const s = await prisma.symptom.create({ data: { patientId: id, text: input.text, severity, redFlags: flags.join(","), reportedById: user.id, reportedBy: `${user.name} (${user.role.toLowerCase()})` } });
      const ctx = await loadAlertContext(prisma, now);
      if (flags.length) {
        const labels = flags.map((f) => RED_FLAGS[f].label).join("; ");
        await raiseAlert(
          prisma,
          id,
          {
            kind: "RED_FLAG",
            vital: null,
            severity: "CRITICAL",
            title: `Red-flag symptom: ${RED_FLAGS[flags[0]].label}`,
            message: `${user.name} (${user.role.toLowerCase()}) reported "${input.text}" — red flags: ${labels}. ${user.role === "NURSE" ? "" : `They were shown the emergency number (${EMERGENCY_NUMBER}) immediately. `}Contact the patient now and consider an emergency transfer (suggested pathway: ${TRANSFER_PATHWAYS[RED_FLAGS[flags[0]].pathway].label}).`,
          },
          ctx.active,
          ctx.recentlyResolved,
          now,
        );
      } else if (severity !== "MILD") {
        await raiseAlert(
          prisma,
          id,
          { kind: "SYMPTOM", vital: null, severity: "WARNING", title: `${severity === "SEVERE" ? "Severe" : "Moderate"} symptom reported by ${user.role.toLowerCase()}`, message: `"${input.text}" — requires clinician review.` },
          ctx.active,
          ctx.recentlyResolved,
          now,
        );
      }
      await audit(user, flags.length ? "RED_FLAG_REPORTED" : "SYMPTOM_REPORTED", { patientId: id, detail: `${severity}: ${input.text}${flags.length ? ` [red flags: ${flags.join(", ")}]` : ""}` });
      return {
        ok: true,
        id: s.id,
        redFlags: flags.map((f) => ({ flag: f, label: RED_FLAGS[f].label, advice: RED_FLAGS[f].advice })),
        emergencyNumber: EMERGENCY_NUMBER,
      };
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

    // --- home hub: automatic device uploads (see docs/DEVICE-GATEWAY.md) ---
    case "hub-register": {
      const { user } = await requirePatientAccess(id, "kit:manage");
      const input = z.object({ name: z.string().trim().min(2).max(80).optional(), serial: z.string().trim().min(3).max(40).optional() }).parse(body);
      const existing = await prisma.device.findFirst({ where: { patientId: id, deviceType: "HOME_HUB", status: "CONNECTED" } });
      if (existing) throw new HttpError(409, "This patient already has an active home hub — revoke it first to replace it");
      const t = newHubToken();
      const hub = await prisma.device.create({ data: { patientId: id, name: input.name ?? "Home hub", deviceType: "HOME_HUB", adapter: "GATEWAY", streaming: false, status: "CONNECTED", battery: 100, serial: input.serial ?? `HUB-${Date.now().toString(36).toUpperCase()}`, tokenHash: t.hash, tokenHint: t.hint } });
      // Pair every medical device of this patient (not wearables) with the new hub.
      const paired = await prisma.device.updateMany({ where: { patientId: id, deviceType: { notIn: ["HOME_HUB", "SMARTWATCH", "PHONE"] }, status: { not: "REVOKED" } }, data: { hubId: hub.id } });
      await audit(user, "HUB_PROVISIONED", { patientId: id, detail: `${hub.name} (${hub.serial}) — ${paired.count} device(s) paired; token …${t.hint} issued` });
      return { ok: true, hubId: hub.id, token: t.token, ingestPath: DEVICE_INGEST_PATH, paired: paired.count };
    }

    case "hub-revoke": {
      const { user } = await requirePatientAccess(id, "kit:manage");
      const hub = await prisma.device.findFirst({ where: { patientId: id, deviceType: "HOME_HUB", status: "CONNECTED" } });
      if (!hub) throw new HttpError(404, "No active home hub for this patient");
      await prisma.device.update({ where: { id: hub.id }, data: { status: "REVOKED", tokenHash: null } });
      await prisma.device.updateMany({ where: { hubId: hub.id }, data: { hubId: null } });
      await audit(user, "HUB_REVOKED", { patientId: id, detail: `${hub.name} (${hub.serial}) revoked — devices unpaired` });
      return { ok: true };
    }

    case "hub-demo": {
      const { user } = await requirePatientAccess(id, "kit:manage");
      requireDemoMode("Synthetic hub uploads");
      const { scenario } = z.object({ scenario: z.enum(["NORMAL", "HIGH"]).default("NORMAL") }).parse(body);
      const hub = await prisma.device.findFirst({ where: { patientId: id, deviceType: "HOME_HUB", status: "CONNECTED" } });
      if (!hub) throw new HttpError(404, "No active home hub for this patient — register one first");
      const out = await ingestGatewayBatch(hub, parseGatewayPayload(await demoHubBundle(id, hub.id, scenario, now)), { demo: true, now });
      await audit(user, "HUB_DEMO_SENT", { patientId: id, detail: `Synthetic ${scenario.toLowerCase()} FHIR upload sent through the real hub ingest path` });
      return out;
    }

    case "manual-entry": {
      const { user } = await requirePatientAccess(id, "kit:manage");
      const input = z.object({ enabled: z.boolean(), reason: z.string().trim().min(3, "Give a reason (e.g. which device is faulty)").max(300) }).parse(body);
      await prisma.patient.update({ where: { id }, data: { manualEntry: input.enabled } });
      await audit(user, input.enabled ? "MANUAL_ENTRY_ENABLED" : "MANUAL_ENTRY_DISABLED", { patientId: id, detail: input.reason });
      return { ok: true, manualEntry: input.enabled };
    }

    // --- emergency transfer: ambulance + direct admission (see docs/EMERGENCY-TRANSFER.md) ---
    case "transfer-suggest": {
      await requirePatientAccess(id, "transfer:request");
      const p = await prisma.patient.findUniqueOrThrow({ where: { id }, select: { address: true, accessNotes: true } });
      return { ...(await suggestTransfer(id)), pickupAddress: p.address, accessNotes: p.accessNotes, hospital: RECEIVING_HOSPITAL, ambulanceService: AMBULANCE_SERVICE, timeScale: TIME_SCALE };
    }

    case "transfer-request": {
      const { user } = await requirePatientAccess(id, "transfer:request");
      const input = z
        .object({
          priority: z.enum(["EMERGENCY", "URGENT"]),
          pathway: z.enum(["CARDIAC", "RESPIRATORY", "SEPSIS", "SURGICAL", "METABOLIC", "GENERAL_MEDICAL", "EMERGENCY_DEPT"]),
          reason: z.string().trim().min(5, "Give the crew a short reason").max(400),
          accessNotes: z.string().trim().max(300).optional(),
        })
        .parse(body);
      const t = await requestTransfer(user, id, input, now);
      return { ok: true, transferId: t.id, incidentRef: t.incidentRef };
    }

    case "transfer-advance": {
      const { user } = await requirePatientAccess(id, "transfer:manage");
      requireDemoMode("The transfer demo clock");
      await skipStage(user, id, now);
      return { ok: true };
    }

    case "transfer-cancel": {
      const { user } = await requirePatientAccess(id, "transfer:manage");
      const { reason } = z.object({ reason: z.string().trim().min(3, "Give a reason for standing the ambulance down").max(300) }).parse(body);
      await cancelTransfer(user, id, reason, now);
      return { ok: true };
    }

    case "transfer-prep": {
      const { user } = await requirePatientAccess(id, "transfer:manage");
      const { itemId, done } = z.object({ itemId: z.string(), done: z.boolean() }).parse(body);
      await tickChecklist(user, id, itemId, done, now);
      return { ok: true };
    }

    case "urgent-help": {
      const { user } = await requirePatientAccess(id, "urgent:help");
      return urgentHelp(user, id, now);
    }

    // --- smartwatch / phone links (see docs/WEARABLES.md) ---
    case "wearable-link": {
      const { user } = await requirePatientAccess(id, "device:manage");
      const input = z.object({ platform: z.enum(["APPLE_HEALTH", "HEALTH_CONNECT", "OTHER"]), label: z.string().trim().min(2).max(80).optional() }).parse(body);
      const activeLinks = await prisma.device.count({ where: { patientId: id, adapter: "WEARABLE_SYNC", status: "CONNECTED" } });
      if (activeLinks >= 5) throw new HttpError(409, "This patient already has 5 active smartwatch / phone links — revoke one first");
      const meta = WEARABLE_PLATFORMS[input.platform];
      const t = newWearableToken();
      const d = await prisma.device.create({
        data: { patientId: id, name: input.label ?? meta.defaultName, deviceType: meta.deviceType, adapter: "WEARABLE_SYNC", status: "CONNECTED", streaming: false, platform: input.platform, tokenHash: t.hash, tokenHint: t.hint, lastSeenAt: null },
      });
      await audit(user, "WEARABLE_LINKED", { patientId: id, detail: `${d.name} (${meta.label}) — device token …${t.hint} issued` });
      // The token is returned exactly once; only its hash is stored.
      return { ok: true, deviceId: d.id, name: d.name, token: t.token, ingestPath: INGEST_PATH };
    }

    case "wearable-revoke": {
      const { user } = await requirePatientAccess(id, "device:manage");
      const { deviceId } = z.object({ deviceId: z.string() }).parse(body);
      const d = await prisma.device.findFirst({ where: { id: deviceId, patientId: id, adapter: "WEARABLE_SYNC" } });
      if (!d) throw new HttpError(404, "Smartwatch / phone link not found for this patient");
      if (d.status === "REVOKED") throw new HttpError(409, "This link is already revoked");
      await prisma.device.update({ where: { id: d.id }, data: { status: "REVOKED", tokenHash: null } });
      await audit(user, "WEARABLE_REVOKED", { patientId: id, detail: `${d.name} — token …${d.tokenHint ?? ""} revoked; stored readings are kept` });
      return { ok: true };
    }

    case "wearable-demo": {
      const { user } = await requirePatientAccess(id, "device:manage");
      requireDemoMode("Synthetic wearable syncs");
      const input = z.object({ deviceId: z.string(), scenario: z.enum(["NORMAL", "LOW_SPO2", "AFIB"]).default("NORMAL") }).parse(body);
      const d = await prisma.device.findFirst({ where: { id: input.deviceId, patientId: id, adapter: "WEARABLE_SYNC" } });
      if (!d) throw new HttpError(404, "Smartwatch / phone link not found for this patient");
      if (d.status !== "CONNECTED") throw new HttpError(409, "This link is revoked");
      const out = await ingestWearableBatch(d, parseWearablePayload(demoHealthAutoExportPayload(input.scenario as DemoScenario, now)), { demo: true, now });
      await audit(user, "WEARABLE_DEMO_SENT", { patientId: id, detail: `Synthetic ${input.scenario.toLowerCase().replace("_", " ")} sync sent through the real ingest path for ${d.name}` });
      return out;
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
