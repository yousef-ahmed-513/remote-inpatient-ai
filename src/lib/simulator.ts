// Live vital-sign simulation engine. Everything produced here is SYNTHETIC and is
// stored with source = SIMULATED_DEVICE.
//
// The engine is "lazy": there is no background timer. Each data request calls
// advanceSimulation(), which works out how many ticks are due since the last one.
// That keeps it correct under hot reload and on serverless hosts.
import type { Alert, Device, Patient } from "@prisma/client";
import { prisma, withLock } from "./db";
import { evaluateReadings, loadAlertContext, loadLimits, raiseAlert, spo2TrendDraft } from "./alerts";
import { BASE_TICK_MS, type LatestMap, type VitalType } from "./types";

export type Vals = { hr: number; spo2: number; rr: number; sys: number; dia: number; temp: number; glucose: number };
type Gen = { vals: Vals; phase: string; step: number; irregular: boolean; events: ("SYMPTOM" | "RHYTHM_START")[] };

function gauss(sd: number): number {
  const u = 1 - Math.random();
  const v = Math.random();
  return sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const lerpTo = (from: number, to: number, perStep: number, step: number) =>
  from < to ? Math.min(to, from + perStep * step) : Math.max(to, from - perStep * step);

const BASELINES: Record<string, Vals> = {
  STABLE: { hr: 72, spo2: 98, rr: 15, sys: 118, dia: 76, temp: 36.7, glucose: 102 },
  RESP: { hr: 84, spo2: 96, rr: 18, sys: 132, dia: 82, temp: 37.0, glucose: 110 },
  CARDIAC: { hr: 74, spo2: 97, rr: 16, sys: 126, dia: 78, temp: 36.6, glucose: 104 },
  DISCONNECT: { hr: 78, spo2: 97, rr: 16, sys: 124, dia: 80, temp: 37.2, glucose: 108 },
  MISSED_CHECKIN: { hr: 80, spo2: 98, rr: 15, sys: 134, dia: 84, temp: 36.8, glucose: 164 },
  AWAITING: { hr: 86, spo2: 96, rr: 18, sys: 128, dia: 82, temp: 37.6, glucose: 112 },
};

function noisy(b: Vals): Vals {
  return {
    hr: b.hr + gauss(2.2),
    spo2: b.spo2 + gauss(0.45),
    rr: b.rr + gauss(0.8),
    sys: b.sys + gauss(3.5),
    dia: b.dia + gauss(2.5),
    temp: b.temp + gauss(0.08),
    glucose: b.glucose + gauss(6),
  };
}

/** Scripted scenario generator: (scenario, phase, step) → next synthetic values. */
export function generate(scenario: string, phase: string, step: number): Gen {
  const base = BASELINES[scenario] ?? BASELINES.STABLE;
  let target = { ...base };
  let nextPhase = phase;
  let nextStep = step + 1;
  let irregular = false;
  const events: Gen["events"] = [];

  if (scenario === "RESP") {
    if (phase === "declining") {
      target.spo2 = lerpTo(96, 88, 0.7, step);
      target.hr = lerpTo(84, 114, 2.4, step);
      target.rr = lerpTo(18, 26, 0.7, step);
      if (step === 5) events.push("SYMPTOM");
      if (target.spo2 <= 88) [nextPhase, nextStep] = ["plateau", 0];
    } else if (phase === "plateau") {
      target = { ...target, spo2: 88, hr: 113, rr: 26 };
    } else if (phase === "recovering") {
      target.spo2 = lerpTo(88, 95.5, 0.9, step);
      target.hr = lerpTo(113, 86, 3, step);
      target.rr = lerpTo(26, 18, 0.9, step);
      if (step >= 9) [nextPhase, nextStep] = ["settled", 0];
    }
  } else if (scenario === "CARDIAC" && phase === "irregular") {
    irregular = true;
    if (step === 0) events.push("RHYTHM_START");
    target.hr = clamp(92 + 28 * Math.sin(step * 1.3) + gauss(6), 56, 127);
    if (step >= 40) [nextPhase, nextStep] = ["settled", 0];
  }

  const v = noisy(target);
  if (scenario === "CARDIAC" && phase === "irregular") v.hr = clamp(v.hr, 54, 128);
  return {
    vals: {
      hr: Math.round(clamp(v.hr, 30, 200)),
      spo2: Math.round(clamp(v.spo2, 70, 100)),
      rr: Math.round(clamp(v.rr, 6, 40)),
      sys: Math.round(v.sys),
      dia: Math.round(v.dia),
      temp: Math.round(v.temp * 10) / 10,
      glucose: Math.round(v.glucose),
    },
    phase: nextPhase,
    step: nextStep,
    irregular,
    events,
  };
}

const DEVICE_PREFS: Record<string, string[]> = {
  HR: ["WEARABLE_PATCH", "PULSE_OXIMETER"],
  RR: ["WEARABLE_PATCH"],
  SPO2: ["PULSE_OXIMETER", "WEARABLE_PATCH"],
  BP: ["BP_MONITOR"],
  TEMP: ["THERMOMETER", "WEARABLE_PATCH"],
  GLUCOSE: ["GLUCOMETER"],
};
function deviceFor(type: string, connected: Device[]): Device | undefined {
  for (const t of DEVICE_PREFS[type] ?? []) {
    const d = connected.find((x) => x.deviceType === t);
    if (d) return d;
  }
  return connected[0];
}

export const UNITS: Record<VitalType, string> = {
  HR: "bpm",
  SPO2: "%",
  BP: "mmHg",
  TEMP: "°C",
  RR: "breaths/min",
  GLUCOSE: "mg/dL",
  WEIGHT: "kg",
};

export async function getSim() {
  return prisma.simState.upsert({ where: { id: 1 }, update: {}, create: { id: 1, pausedAt: new Date() } });
}

type ReadingRow = { patientId: string; deviceId: string | null; type: string; value: number; value2?: number | null; unit: string; source: string; takenAt: Date };

async function runTick(tickNo: number, at: Date) {
  const patients = await prisma.patient.findMany({ include: { devices: true } });
  const limits = await loadLimits();
  const ctx = await loadAlertContext(prisma, at);
  const rows: ReadingRow[] = [];

  for (const p of patients) {
    let phase = p.simPhase;
    let step = p.simStep;
    // Scripted scenario start points (each fires once per reset; can also be triggered manually).
    if (p.scenario === "RESP" && phase === "baseline" && tickNo >= 5) [phase, step] = ["declining", 0];
    if (p.scenario === "CARDIAC" && phase === "baseline" && tickNo >= 10) [phase, step] = ["irregular", 0];
    if (p.scenario === "DISCONNECT" && phase === "baseline" && tickNo >= 8) {
      phase = "disconnected";
      await prisma.device.updateMany({ where: { patientId: p.id, streaming: true }, data: { status: "DISCONNECTED" } });
      for (const d of p.devices) if (d.streaming) d.status = "DISCONNECTED";
    }

    const connected = p.devices.filter((d) => d.streaming && d.status === "CONNECTED");
    if (connected.length === 0) {
      // Nothing is transmitting: write NO readings. Silence is never back-filled with "normal" values.
      if (phase !== p.simPhase) await prisma.patient.update({ where: { id: p.id }, data: { simPhase: phase, simStep: step } });
      continue;
    }

    const g = generate(p.scenario, phase, step);
    const mine: ReadingRow[] = [];
    const push = (type: VitalType, value: number, value2?: number) => {
      const d = deviceFor(type, connected);
      mine.push({ patientId: p.id, deviceId: d?.id ?? null, type, value, value2: value2 ?? null, unit: UNITS[type], source: "SIMULATED_DEVICE", takenAt: at });
    };
    push("HR", g.vals.hr);
    push("SPO2", g.vals.spo2);
    push("RR", g.vals.rr);
    if (tickNo % 5 === 0) {
      push("BP", g.vals.sys, g.vals.dia);
      push("TEMP", g.vals.temp);
    }
    rows.push(...mine);

    const latest: LatestMap = JSON.parse(p.latestJson || "{}");
    for (const r of mine) latest[r.type as VitalType] = { v: r.value, v2: r.value2, t: at.toISOString(), src: r.source };

    await prisma.patient.update({
      where: { id: p.id },
      data: { simPhase: g.phase, simStep: g.step, ecgIrregular: g.irregular, latestJson: JSON.stringify(latest), lastReadingAt: at },
    });

    // --- rule evaluation ---
    await evaluateReadings(prisma, p.id, mine, limits.forPatient(p.id), ctx.active, ctx.recentlyResolved, at, "Simulated device");
    const prev = await prisma.reading.findMany({ where: { patientId: p.id, type: "SPO2" }, orderBy: { takenAt: "desc" }, take: 5, select: { value: true } });
    const trend = spo2TrendDraft([...prev.map((x) => x.value).reverse(), g.vals.spo2]);
    if (trend) await raiseAlert(prisma, p.id, trend, ctx.active, ctx.recentlyResolved, at);

    // --- scripted events ---
    if (g.events.includes("SYMPTOM")) {
      await prisma.symptom.create({
        data: {
          patientId: p.id,
          text: "Feeling more short of breath than this morning, especially when walking to the kitchen.",
          severity: "MODERATE",
          reportedBy: `${p.name} (simulated patient report)`,
          createdAt: at,
        },
      });
      await raiseAlert(
        prisma,
        p.id,
        { kind: "SYMPTOM", vital: null, severity: "WARNING", title: "Patient reports increased breathlessness", message: "Simulated patient-reported symptom received via the patient app. Requires clinician review." },
        ctx.active,
        ctx.recentlyResolved,
        at,
      );
    }
    const patch = connected.find((d) => d.deviceType === "WEARABLE_PATCH");
    if (g.events.includes("RHYTHM_START")) {
      await raiseAlert(
        prisma,
        p.id,
        { kind: "RHYTHM_FLAG", vital: "ECG", severity: "WARNING", title: "Simulated irregular rhythm flag — ECG patch", message: "The simulated ECG patch flagged irregular R-R intervals. This is an artificial waveform for demonstration, not a recorded ECG or a diagnosis. Requires clinician review." },
        ctx.active,
        ctx.recentlyResolved,
        at,
      );
      await prisma.ecgStrip.create({
        data: { patientId: p.id, deviceId: patch?.id, takenAt: at, heartRate: g.vals.hr, irregular: true, seed: (Math.random() * 1e9) | 0, label: "Auto-captured on simulated irregularity flag" },
      });
    } else if (patch && tickNo % 40 === 0) {
      await prisma.ecgStrip.create({
        data: { patientId: p.id, deviceId: patch.id, takenAt: at, heartRate: g.vals.hr, irregular: g.irregular, seed: (Math.random() * 1e9) | 0, label: "Scheduled 10 s strip" },
      });
    }
    await prisma.device.updateMany({ where: { id: { in: connected.map((d) => d.id) } }, data: { lastSeenAt: at } });
  }
  if (rows.length) await prisma.reading.createMany({ data: rows });
}

/** Connectivity + overdue check-in events. Runs whether or not the simulation is running. */
async function housekeeping(now: Date) {
  const g = globalThis as unknown as { __riaHk?: number };
  if (g.__riaHk && now.getTime() - g.__riaHk < 1000) return;
  g.__riaHk = now.getTime();

  const [patients, alerts] = await Promise.all([
    prisma.patient.findMany({ include: { devices: true } }),
    prisma.alert.findMany({ where: { kind: { in: ["CONNECTIVITY", "CHECKIN_OVERDUE"] } }, orderBy: { createdAt: "desc" } }),
  ]);
  const active: Alert[] = alerts.filter((a) => a.status !== "RESOLVED");
  const systemResolve = async (a: Alert, note: string) => {
    await prisma.alert.update({ where: { id: a.id }, data: { status: "RESOLVED", resolvedAt: now, resolvedById: "system", resolutionNote: note } });
    await prisma.auditLog.create({ data: { userName: "System", userRole: "SYSTEM", action: "ALERT_AUTO_CLEARED", patientId: a.patientId, detail: `${a.title} — ${note}` } });
  };

  for (const p of patients) {
    const streaming = p.devices.filter((d) => d.streaming);
    const allDown = streaming.length > 0 && streaming.every((d) => d.status !== "CONNECTED");
    const lastSeen = Math.max(0, ...streaming.map((d) => d.lastSeenAt?.getTime() ?? 0));
    const conn = alerts.filter((a) => a.patientId === p.id && a.kind === "CONNECTIVITY");
    if (allDown && !conn.some((a) => a.createdAt.getTime() >= lastSeen)) {
      await raiseAlert(
        prisma,
        p.id,
        { kind: "CONNECTIVITY", vital: null, severity: "WARNING", title: "Monitoring device disconnected — no data being received", message: `No device is transmitting for ${p.name}. Their current condition is unknown; the last readings shown are historical. Contact the patient to check the device.` },
        active,
        [],
        now,
      );
    }
    if (!allDown) for (const a of conn) if (a.status !== "RESOLVED") await systemResolve(a, "Device reconnected and transmitting");

    const overdueAlerts = alerts.filter((a) => a.patientId === p.id && a.kind === "CHECKIN_OVERDUE");
    const due = p.nextCheckInDueAt;
    if (due && due.getTime() < now.getTime()) {
      if (!overdueAlerts.some((a) => a.createdAt.getTime() >= due.getTime())) {
        await raiseAlert(
          prisma,
          p.id,
          { kind: "CHECKIN_OVERDUE", vital: null, severity: "WARNING", title: "Scheduled check-in overdue", message: `No patient-submitted observations were received by the expected time (${due.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}). Absence of data does not indicate the patient is well.` },
          active,
          [],
          now,
        );
      }
    } else {
      for (const a of overdueAlerts) if (a.status !== "RESOLVED") await systemResolve(a, "Check-in received");
    }
  }
}

/** Call from every data-reading endpoint. Safe under concurrent polling. */
export function advanceSimulation() {
  return withLock(async () => {
    let sim = await getSim();
    const now = new Date();
    if (sim.running) {
      const interval = BASE_TICK_MS / Math.max(1, sim.speed);
      const last = sim.lastTickAt?.getTime() ?? 0;
      const due = Math.floor((now.getTime() - last) / interval);
      if (due >= 1) {
        // Catch up at most 3 ticks. Longer gaps (nobody watching) are left as real gaps in the data.
        const n = Math.min(due, 3);
        for (let i = n - 1; i >= 0; i--) await runTick(sim.tick + (n - i), new Date(now.getTime() - i * interval));
        const nextLast = due <= 3 ? new Date(last + due * interval) : now;
        sim = await prisma.simState.update({ where: { id: 1 }, data: { tick: sim.tick + n, lastTickAt: nextLast } });
      }
    }
    await housekeeping(now);
    return sim;
  });
}

export type SimAction =
  | { action: "start" | "pause" | "step" }
  | { action: "speed"; speed: number }
  | { action: "trigger"; scenario: "RESP" | "CARDIAC" | "DISCONNECT" | "RECONNECT" | "MISSED_CHECKIN" };

export function simControl(cmd: SimAction) {
  return withLock(async () => {
    const sim = await getSim();
    const now = new Date();
    switch (cmd.action) {
      case "start":
        return prisma.simState.update({ where: { id: 1 }, data: { running: true, lastTickAt: now, pausedAt: null } });
      case "pause":
        return prisma.simState.update({ where: { id: 1 }, data: { running: false, pausedAt: now } });
      case "step":
        await runTick(sim.tick + 1, now);
        return prisma.simState.update({ where: { id: 1 }, data: { tick: sim.tick + 1, lastTickAt: now, pausedAt: sim.running ? null : now } });
      case "speed":
        return prisma.simState.update({ where: { id: 1 }, data: { speed: [1, 2, 5].includes(cmd.speed) ? cmd.speed : 1 } });
      case "trigger": {
        const find = (s: string) => prisma.patient.findFirst({ where: { scenario: s }, orderBy: { mrn: "asc" } });
        if (cmd.scenario === "RESP") {
          const p = await find("RESP");
          if (p) await prisma.patient.update({ where: { id: p.id }, data: { simPhase: "declining", simStep: 0 } });
        } else if (cmd.scenario === "CARDIAC") {
          const p = await find("CARDIAC");
          if (p) await prisma.patient.update({ where: { id: p.id }, data: { simPhase: "irregular", simStep: 0 } });
        } else if (cmd.scenario === "DISCONNECT") {
          const p = await find("DISCONNECT");
          if (p) await setPatientDevices(p.id, "DISCONNECTED");
        } else if (cmd.scenario === "RECONNECT") {
          const p = await find("DISCONNECT");
          if (p) await setPatientDevices(p.id, "CONNECTED");
        } else if (cmd.scenario === "MISSED_CHECKIN") {
          const p = await find("MISSED_CHECKIN");
          if (p) await prisma.patient.update({ where: { id: p.id }, data: { nextCheckInDueAt: new Date(now.getTime() - 60_000) } });
        }
        (globalThis as unknown as { __riaHk?: number }).__riaHk = 0;
        await housekeeping(now);
        return getSim();
      }
    }
  });
}

/** Connect / disconnect streaming devices (one device, or all for the patient). */
export async function setPatientDevices(patientId: string, status: "CONNECTED" | "DISCONNECTED", deviceId?: string) {
  await prisma.device.updateMany({
    where: { patientId, streaming: true, ...(deviceId ? { id: deviceId } : {}) },
    data: { status, ...(status === "CONNECTED" ? { lastSeenAt: new Date() } : {}) },
  });
  const p = await prisma.patient.findUnique({ where: { id: patientId } });
  if (p?.scenario === "DISCONNECT") {
    await prisma.patient.update({ where: { id: patientId }, data: { simPhase: status === "CONNECTED" ? "settled" : "disconnected" } });
  }
}

/**
 * Scripted scenario hook: once a clinician resolves the SpO₂ alert in the respiratory
 * scenario, the simulator moves to its scripted "recovering" phase so the demo can show
 * the full loop. This is a storyboard step, not a model of treatment effect.
 */
export async function onAlertResolved(alert: Pick<Alert, "patientId" | "kind" | "vital">, patient: Pick<Patient, "scenario" | "simPhase">) {
  if (patient.scenario === "RESP" && alert.vital === "SPO2" && ["declining", "plateau"].includes(patient.simPhase)) {
    await prisma.patient.update({ where: { id: alert.patientId }, data: { simPhase: "recovering", simStep: 0 } });
    await prisma.auditLog.create({
      data: { userName: "Simulator", userRole: "SYSTEM", action: "SIM_SCENARIO", patientId: alert.patientId, detail: "Scripted recovery phase started after clinician resolved the SpO₂ alert (simulated)" },
    });
  }
}
