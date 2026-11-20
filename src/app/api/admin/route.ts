// Administrator API: operational metrics, staffing, wards, programme defaults, access log.
// Deliberately returns NO clinical record content (notes, readings, summaries).
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit, HttpError, requireUser, route } from "@/lib/auth";
import { aiProvider } from "@/lib/ai";
import { loadLimits } from "@/lib/alerts";
import { ensureSeeded } from "@/lib/seed";
import { advanceSimulation } from "@/lib/simulator";
import { computeStatus } from "@/lib/status";
import { simDto } from "@/lib/views";
import { THRESHOLD_VITALS, type MonitoringState, type ThresholdVital } from "@/lib/types";

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export const GET = route(async () => {
  const user = await requireUser("admin:view");
  await ensureSeeded();
  const sim = await advanceSimulation();
  const now = new Date();
  const [wards, patients, alerts, symptoms, users, logs, limits] = await Promise.all([
    prisma.ward.findMany({ orderBy: { name: "asc" } }),
    prisma.patient.findMany({ include: { devices: true } }),
    prisma.alert.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.symptom.groupBy({ by: ["patientId"], where: { reviewedAt: null }, _count: true }),
    prisma.user.findMany({ orderBy: { createdAt: "asc" } }),
    prisma.auditLog.findMany({ orderBy: { createdAt: "desc" }, take: 80 }),
    loadLimits(),
  ]);
  const active = alerts.filter((a) => a.status !== "RESOLVED");
  const sym = new Map(symptoms.map((s) => [s.patientId, s._count]));
  const states: Record<string, number> = {};
  let monitored = 0;
  const stateOf = new Map<string, MonitoringState>();
  for (const p of patients) {
    const st = computeStatus({ ...p, activeAlerts: active.filter((a) => a.patientId === p.id), unreviewedSymptoms: sym.get(p.id) ?? 0 }, sim, now);
    states[st.state] = (states[st.state] ?? 0) + 1;
    stateOf.set(p.id, st.state);
    if (st.state !== "DEVICE_DISCONNECTED" && st.state !== "NO_RECENT_DATA") monitored++;
  }
  const capacity = wards.reduce((a, w) => a + w.capacity, 0);
  // Response times are computed from stored alert records (system auto-clears excluded).
  const acked = alerts.filter((a) => a.acknowledgedAt && a.acknowledgedById && a.acknowledgedById !== "system");
  const resolved = alerts.filter((a) => a.resolvedAt && a.resolvedById && a.resolvedById !== "system");
  const day = new Date(now.getTime() - 24 * 3600_000);
  const byKind: Record<string, number> = {};
  for (const a of alerts.filter((x) => x.createdAt >= day)) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;

  const clinicians = users.filter((u) => u.role === "DOCTOR" || u.role === "NURSE");
  return {
    me: user,
    sim: simDto(sim),
    now,
    aiProvider: aiProvider(),
    kpis: {
      admitted: patients.length,
      activeBeds: patients.length,
      capacity,
      available: Math.max(0, capacity - patients.length),
      monitored,
      activeAlerts: active.length,
      criticalAlerts: active.filter((a) => a.severity === "CRITICAL").length,
      overdueCheckIns: patients.filter((p) => p.nextCheckInDueAt && p.nextCheckInDueAt < now).length,
      avgAckSeconds: avg(acked.map((a) => (a.acknowledgedAt!.getTime() - a.createdAt.getTime()) / 1000)),
      ackSample: acked.length,
      avgResolveSeconds: avg(resolved.map((a) => (a.resolvedAt!.getTime() - a.createdAt.getTime()) / 1000)),
      resolveSample: resolved.length,
      alerts24h: alerts.filter((a) => a.createdAt >= day).length,
    },
    states,
    alertsByKind: byKind,
    wards: wards.map((w) => ({ id: w.id, name: w.name, capacity: w.capacity, occupied: patients.filter((p) => p.wardId === w.id).length })),
    clinicians: clinicians.map((c) => {
      const mine = patients.filter((p) => p.doctorId === c.id || p.nurseId === c.id);
      return { id: c.id, name: c.name, role: c.role, title: c.title, patients: mine.map((p) => ({ id: p.id, name: p.name, room: p.room, state: stateOf.get(p.id) })), openAlerts: active.filter((a) => mine.some((p) => p.id === a.patientId)).length };
    }),
    patients: patients.map((p) => ({ id: p.id, name: p.name, room: p.room, mrn: p.mrn, wardId: p.wardId, doctorId: p.doctorId, nurseId: p.nurseId, state: stateOf.get(p.id) })),
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role, title: u.title })),
    defaults: limits.defaults,
    logs: logs.map((l) => ({ id: l.id, at: l.createdAt, who: l.userName, role: l.userRole, action: l.action, detail: l.detail, patientId: l.patientId })),
  };
});

const nn = z.number().finite().nullable();
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("addClinician"), name: z.string().trim().min(2).max(80), role: z.enum(["DOCTOR", "NURSE"]), title: z.string().trim().max(80).default("") }),
  z.object({ action: z.literal("addWard"), name: z.string().trim().min(2).max(80), capacity: z.number().int().min(1).max(200) }),
  z.object({ action: z.literal("setWardCapacity"), wardId: z.string(), capacity: z.number().int().min(1).max(200) }),
  z.object({ action: z.literal("setDefault"), vital: z.enum(Object.keys(THRESHOLD_VITALS) as [ThresholdVital, ...ThresholdVital[]]), critLow: nn, warnLow: nn, warnHigh: nn, critHigh: nn }),
  z.object({ action: z.literal("assign"), patientId: z.string(), doctorId: z.string().optional(), nurseId: z.string().optional() }),
]);

export const POST = route(async (req) => {
  const user = await requireUser("admin:manage");
  const cmd = schema.parse(await req.json());
  switch (cmd.action) {
    case "addClinician": {
      const slug = cmd.name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
      const u = await prisma.user.create({ data: { name: cmd.name, role: cmd.role, title: cmd.title || (cmd.role === "DOCTOR" ? "Doctor" : "Virtual ward nurse"), email: `${slug}.${Date.now().toString(36)}@demo.remote-inpatient.ai` } });
      await audit(user, "CLINICIAN_ADDED", { detail: `${u.name} (${u.role.toLowerCase()})` });
      return { ok: true, id: u.id };
    }
    case "addWard": {
      const w = await prisma.ward.create({ data: { name: cmd.name, capacity: cmd.capacity } });
      await audit(user, "WARD_ADDED", { detail: `${w.name} — ${w.capacity} virtual beds` });
      return { ok: true, id: w.id };
    }
    case "setWardCapacity": {
      const w = await prisma.ward.findUnique({ where: { id: cmd.wardId }, include: { _count: { select: { patients: true } } } });
      if (!w) throw new HttpError(404, "Ward not found");
      if (cmd.capacity < w._count.patients) throw new HttpError(400, `Capacity cannot be lower than the ${w._count.patients} patients currently admitted`);
      await prisma.ward.update({ where: { id: w.id }, data: { capacity: cmd.capacity } });
      await audit(user, "WARD_UPDATED", { detail: `${w.name} capacity ${w.capacity} → ${cmd.capacity}` });
      return { ok: true };
    }
    case "setDefault": {
      const l = { critLow: cmd.critLow, warnLow: cmd.warnLow, warnHigh: cmd.warnHigh, critHigh: cmd.critHigh };
      const seq = [l.critLow, l.warnLow, l.warnHigh, l.critHigh].filter((x): x is number => x != null);
      if (seq.length === 0) throw new HttpError(400, "Set at least one limit");
      if (seq.some((x, i) => i > 0 && x <= seq[i - 1])) throw new HttpError(400, "Limits must increase: critical low < review low < review high < critical high");
      const row = await prisma.threshold.findFirst({ where: { patientId: null, vital: cmd.vital } });
      if (row) await prisma.threshold.update({ where: { id: row.id }, data: { ...l, updatedBy: user.name } });
      else await prisma.threshold.create({ data: { patientId: null, vital: cmd.vital, ...l, updatedBy: user.name } });
      await audit(user, "DEFAULT_LIMITS_CONFIGURED", { detail: `${THRESHOLD_VITALS[cmd.vital].label}: ${JSON.stringify(l)}` });
      return { ok: true };
    }
    case "assign": {
      const p = await prisma.patient.findUnique({ where: { id: cmd.patientId } });
      if (!p) throw new HttpError(404, "Patient not found");
      const check = async (id: string | undefined, role: string) => {
        if (!id) return;
        const u = await prisma.user.findUnique({ where: { id } });
        if (!u || u.role !== role) throw new HttpError(400, `Selected user is not a ${role.toLowerCase()}`);
      };
      await check(cmd.doctorId, "DOCTOR");
      await check(cmd.nurseId, "NURSE");
      await prisma.patient.update({ where: { id: p.id }, data: { ...(cmd.doctorId ? { doctorId: cmd.doctorId } : {}), ...(cmd.nurseId ? { nurseId: cmd.nurseId } : {}) } });
      await audit(user, "ASSIGNMENT_CHANGED", { patientId: p.id, detail: `Care team updated for ${p.room}` });
      return { ok: true };
    }
  }
});
