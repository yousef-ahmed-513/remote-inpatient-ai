// Read models returned by the API. Field-level scoping by role happens HERE, on the server.
import type { Alert, SimState, User } from "@prisma/client";
import { prisma } from "./db";
import { audit, type SessionUser } from "./auth";
import { loadLimits } from "./alerts";
import type { PatientScope } from "./permissions";
import { advanceSimulation } from "./simulator";
import { ensureSeeded } from "./seed";
import { computeStatus } from "./status";
import { DEFAULT_LIMITS, type LatestMap, type ThresholdVital } from "./types";

export const simDto = (s: SimState) => ({
  running: s.running,
  speed: s.speed,
  tick: s.tick,
  lastTickAt: s.lastTickAt,
  pausedAt: s.pausedAt,
  seededAt: s.seededAt,
});

function userMap(users: User[]) {
  const m = new Map(users.map((u) => [u.id, u]));
  return (id: string | null | undefined) => {
    if (id === "system") return { id: "system", name: "System (automatic)", role: "SYSTEM" };
    const u = id ? m.get(id) : undefined;
    return u ? { id: u.id, name: u.name, role: u.role } : null;
  };
}

export function alertDto(a: Alert, who: ReturnType<typeof userMap>, patient?: { name: string; room: string; mrn: string }) {
  return {
    id: a.id,
    patientId: a.patientId,
    patient: patient ?? null,
    kind: a.kind,
    vital: a.vital,
    severity: a.severity,
    title: a.title,
    message: a.message,
    status: a.status,
    createdAt: a.createdAt,
    acknowledgedAt: a.acknowledgedAt,
    acknowledgedBy: who(a.acknowledgedById)?.name ?? null,
    escalatedAt: a.escalatedAt,
    escalatedBy: who(a.escalatedById)?.name ?? null,
    resolvedAt: a.resolvedAt,
    resolvedBy: who(a.resolvedById)?.name ?? null,
    resolutionNote: a.resolutionNote,
  };
}

function connectivity(devices: { streaming: boolean; status: string }[]) {
  const s = devices.filter((d) => d.streaming);
  if (s.length === 0) return "MANUAL" as const;
  const up = s.filter((d) => d.status === "CONNECTED").length;
  return up === s.length ? ("CONNECTED" as const) : up === 0 ? ("DISCONNECTED" as const) : ("PARTIAL" as const);
}

export async function wardView(user: SessionUser) {
  await ensureSeeded();
  const sim = await advanceSimulation();
  const now = new Date();
  const [patients, active, symptoms, users, wards] = await Promise.all([
    prisma.patient.findMany({ include: { devices: true, ward: true }, orderBy: { room: "asc" } }),
    prisma.alert.findMany({ where: { status: { not: "RESOLVED" } }, orderBy: { createdAt: "desc" } }),
    prisma.symptom.groupBy({ by: ["patientId"], where: { reviewedAt: null }, _count: true }),
    prisma.user.findMany(),
    prisma.ward.findMany({ orderBy: { name: "asc" } }),
  ]);
  const who = userMap(users);
  const symCount = new Map(symptoms.map((s) => [s.patientId, s._count]));

  const cards = await Promise.all(
    patients.map(async (p) => {
      const mine = active.filter((a) => a.patientId === p.id);
      const st = computeStatus({ ...p, activeAlerts: mine, unreviewedSymptoms: symCount.get(p.id) ?? 0 }, sim, now);
      const spark = await prisma.reading.findMany({
        where: { patientId: p.id, type: { in: ["HR", "SPO2"] } },
        orderBy: { takenAt: "desc" },
        take: 60,
        select: { type: true, value: true },
      });
      return {
        id: p.id,
        mrn: p.mrn,
        name: p.name,
        age: p.age,
        sex: p.sex,
        condition: p.condition,
        room: p.room,
        wardId: p.wardId,
        wardName: p.ward.name,
        doctor: who(p.doctorId),
        nurse: who(p.nurseId),
        lastContactAt: p.lastContactAt,
        lastReadingAt: p.lastReadingAt,
        nextCheckInDueAt: p.nextCheckInDueAt,
        checkInOverdue: !!p.nextCheckInDueAt && p.nextCheckInDueAt < now,
        latest: JSON.parse(p.latestJson || "{}") as LatestMap,
        connectivity: connectivity(p.devices),
        deviceCount: p.devices.length,
        state: st.state,
        stateReason: st.reason,
        openAlerts: mine.length,
        criticalAlerts: mine.filter((a) => a.severity === "CRITICAL").length,
        topAlert: mine.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "CRITICAL" ? -1 : 1))[0]?.title ?? null,
        spark: {
          HR: spark.filter((r) => r.type === "HR").map((r) => r.value).reverse(),
          SPO2: spark.filter((r) => r.type === "SPO2").map((r) => r.value).reverse(),
        },
      };
    }),
  );
  const pmap = new Map(patients.map((p) => [p.id, { name: p.name, room: p.room, mrn: p.mrn }]));
  return {
    me: user,
    sim: simDto(sim),
    now,
    wards: wards.map((w) => ({ id: w.id, name: w.name })),
    clinicians: users.filter((u) => u.role === "DOCTOR" || u.role === "NURSE").map((u) => ({ id: u.id, name: u.name, role: u.role })),
    patients: cards,
    alerts: active.map((a) => alertDto(a, who, pmap.get(a.patientId))),
  };
}

const viewLog = globalThis as unknown as { __riaViews?: Map<string, number> };
/** Access log: one "record viewed" entry per user/patient every 10 minutes (polling does not spam it). */
async function logView(user: SessionUser, patientId: string) {
  viewLog.__riaViews ??= new Map();
  const key = `${user.id}:${patientId}`;
  const last = viewLog.__riaViews.get(key) ?? 0;
  if (Date.now() - last < 10 * 60_000) return;
  viewLog.__riaViews.set(key, Date.now());
  await audit(user, "RECORD_VIEWED", { patientId, detail: "Opened patient record" });
}

function downsample<T>(xs: T[], max: number): T[] {
  if (xs.length <= max) return xs;
  const k = xs.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(xs[Math.floor(i * k)]);
  out[out.length - 1] = xs[xs.length - 1];
  return out;
}

export async function patientView(user: SessionUser, patientId: string, scope: PatientScope, windowMin: number) {
  await ensureSeeded();
  const sim = await advanceSimulation();
  const now = new Date();
  const p = await prisma.patient.findUnique({ where: { id: patientId }, include: { devices: true, ward: true } });
  if (!p) return null;
  const clinical = scope === "clinical";
  const caregiver = scope === "caregiver";
  if (clinical) await logView(user, patientId);

  const since = new Date(now.getTime() - windowMin * 60_000);
  const [users, alerts, symptoms, tasks, meds, messages, consults, limits, readings] = await Promise.all([
    prisma.user.findMany(),
    prisma.alert.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 40 }),
    prisma.symptom.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 20 }),
    prisma.task.findMany({ where: { patientId, ...(clinical ? {} : { assigneeRole: caregiver ? "CAREGIVER" : "PATIENT" }) }, orderBy: [{ status: "desc" }, { dueAt: "asc" }], take: 40 }),
    prisma.medication.findMany({ where: { patientId }, include: { logs: { orderBy: { takenAt: "desc" }, take: 1 } } }),
    prisma.message.findMany({ where: { patientId }, orderBy: { createdAt: "asc" }, take: 100 }),
    prisma.consult.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 5 }),
    loadLimits(),
    caregiver
      ? Promise.resolve([])
      : prisma.reading.findMany({ where: { patientId, takenAt: { gte: since } }, orderBy: { takenAt: "asc" }, select: { type: true, value: true, value2: true, source: true, takenAt: true } }),
  ]);
  const who = userMap(users);
  const active = alerts.filter((a) => a.status !== "RESOLVED");
  const st = computeStatus({ ...p, activeAlerts: active, unreviewedSymptoms: symptoms.filter((s) => !s.reviewedAt).length }, sim, now);

  const series: Record<string, { t: Date; v: number; v2: number | null; src: string }[]> = {};
  for (const r of readings) (series[r.type] ??= []).push({ t: r.takenAt, v: r.value, v2: r.value2, src: r.source });
  for (const k of Object.keys(series)) series[k] = downsample(series[k], 240);

  const eff = limits.forPatient(patientId);
  const overrides = await prisma.threshold.findMany({ where: { patientId } });
  const latest = JSON.parse(p.latestJson || "{}") as LatestMap;
  const patch = p.devices.find((d) => d.deviceType === "WEARABLE_PATCH");

  const base = {
    me: user,
    scope,
    sim: simDto(sim),
    now,
    patient: {
      id: p.id,
      mrn: p.mrn,
      name: p.name,
      age: p.age,
      sex: p.sex,
      condition: p.condition,
      pathway: p.pathway,
      room: p.room,
      wardName: p.ward.name,
      admittedAt: p.admittedAt,
      doctor: who(p.doctorId),
      nurse: who(p.nurseId),
      lastContactAt: p.lastContactAt,
      lastReadingAt: p.lastReadingAt,
      nextCheckInDueAt: p.nextCheckInDueAt,
      checkInOverdue: !!p.nextCheckInDueAt && p.nextCheckInDueAt < now,
      awaitingAssessment: p.awaitingAssessment,
      carePlan: JSON.parse(p.carePlan || "[]") as string[],
    },
    state: st.state,
    stateReason: st.reason,
    connectivity: connectivity(p.devices),
    latest,
    devices: p.devices.map((d) => ({ id: d.id, name: d.name, deviceType: d.deviceType, adapter: d.adapter, status: d.status, streaming: d.streaming, battery: d.battery, lastSeenAt: d.lastSeenAt })),
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, assigneeRole: t.assigneeRole, status: t.status, dueAt: t.dueAt, createdByName: t.createdByName, completedAt: t.completedAt, completedBy: t.completedBy })),
    medications: meds.map((m) => ({ id: m.id, name: m.name, dose: m.dose, schedule: m.schedule, lastTakenAt: m.logs[0]?.takenAt ?? null, lastRecordedBy: m.logs[0]?.recordedBy ?? null })),
    messages: messages.map((m) => ({ id: m.id, senderId: m.senderId, senderName: m.senderName, senderRole: m.senderRole, body: m.body, createdAt: m.createdAt })),
    consults: consults.map((c) => ({ id: c.id, status: c.status, reason: c.reason, requestedBy: c.requestedBy, createdAt: c.createdAt, startedAt: c.startedAt, endedAt: c.endedAt })),
    activeAlertCount: active.length,
  };
  if (caregiver) return base; // restricted overview: no history, symptoms, notes, alerts detail or AI

  const shared = {
    ...base,
    series,
    limits: eff,
    symptoms: symptoms.map((s) => ({ id: s.id, text: s.text, severity: s.severity, reportedBy: s.reportedBy, createdAt: s.createdAt, reviewedAt: s.reviewedAt, reviewedBy: who(s.reviewedById)?.name ?? null })),
  };
  if (!clinical) return shared; // patient: own data, no clinician notes / alert internals / AI summaries

  const [notes, summaries, strips, timeline] = await Promise.all([
    prisma.note.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.aiSummary.findMany({ where: { patientId, kind: "PATIENT" }, orderBy: { createdAt: "desc" }, take: 3 }),
    prisma.ecgStrip.findMany({ where: { patientId }, orderBy: { takenAt: "desc" }, take: 8 }),
    prisma.auditLog.findMany({ where: { patientId }, orderBy: { createdAt: "desc" }, take: 60 }),
  ]);
  return {
    ...shared,
    limitOverrides: overrides.map((o) => ({ vital: o.vital as ThresholdVital, updatedBy: o.updatedBy, updatedAt: o.updatedAt })),
    defaultLimits: limits.defaults ?? DEFAULT_LIMITS,
    alerts: alerts.map((a) => alertDto(a, who)),
    notes: notes.map((n) => ({ id: n.id, authorName: n.authorName, authorRole: n.authorRole, kind: n.kind, body: n.body, createdAt: n.createdAt })),
    summaries: summaries.map((s) => ({ id: s.id, engine: s.engine, createdBy: s.createdBy, createdAt: s.createdAt, doc: JSON.parse(s.content) })),
    ecg: {
      available: !!patch,
      connected: patch?.status === "CONNECTED",
      deviceName: patch?.name ?? null,
      heartRate: latest.HR?.v ?? null,
      irregular: p.ecgIrregular,
      strips: strips.map((s) => ({ id: s.id, takenAt: s.takenAt, heartRate: s.heartRate, irregular: s.irregular, seed: s.seed, durationSec: s.durationSec, label: s.label })),
    },
    timeline: timeline.map((t) => ({ id: t.id, at: t.createdAt, who: t.userName, role: t.userRole, action: t.action, detail: t.detail })),
  };
}
