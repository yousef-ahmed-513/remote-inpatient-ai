// Smartwatch / phone health-data ingestion (server only). Design notes: docs/WEARABLES.md
//
// A browser cannot read Apple Health or Android Health Connect. The phone has to push the
// data: either a companion app (ours, planned) or an existing exporter such as the iOS app
// "Health Auto Export", which can POST its JSON to a REST endpoint on a schedule.
//
//   phone health store ──(HTTPS POST, per-device bearer token)──▶ /api/ingest/wearable
//        └─ parseWearablePayload()  : Health Auto Export JSON  or  the normalized format below
//        └─ ingestWearableBatch()   : validate → de-duplicate → store → same alert rules as every
//                                     other reading → audit
//
// Safety rules (same spirit as the rest of the app):
//   • Consumer-wearable values are labelled with their source everywhere; they are never
//     presented as clinical-grade measurements.
//   • Late / back-filled data is stored but only data measured inside the alert window can
//     raise alerts, and every alert says when the value was measured.
//   • A watch that stops syncing raises a "sync overdue" alert — silence is never "stable".
//   • Tokens are random, shown once, stored only as SHA-256 hashes, and revocable.
import { createHash, randomBytes } from "node:crypto";
import type { Alert, Device } from "@prisma/client";
import { z } from "zod";
import { prisma, withLock } from "./db";
import { checkWeightTrend, evaluateReadings, loadAlertContext, loadLimits, raiseAlert } from "./alerts";
import { worstBreach } from "./rules";
import { ACTIVITY, SOURCE_LABEL, VITALS, type ActivityType, type LatestMap, type VitalType } from "./types";

export const WEARABLE_TOKEN_PREFIX = "ria_wk_";
export const INGEST_PATH = "/api/ingest/wearable";
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_SAMPLES = 20_000;
export const MAX_FUTURE_MS = 5 * 60_000;
export const MAX_BACKFILL_MS = 30 * 24 * 3600_000;
const envMin = (name: string, dflt: number) => {
  const n = Number(process.env[name]);
  return (Number.isFinite(n) && n > 0 ? n : dflt) * 60_000;
};
/** Only vitals measured within this window can raise threshold alerts. */
export const ALERT_WINDOW_MS = envMin("WEARABLE_ALERT_WINDOW_MIN", 60);
/** Rhythm classifications (watch ECG / irregular-rhythm notifications) can alert for longer. */
const RHYTHM_WINDOW_MS = 24 * 3600_000;
/** A linked watch that has not synced for this long raises a "sync overdue" alert. */
export const SYNC_STALE_MS = envMin("WEARABLE_SYNC_STALE_MIN", 360);

type SampleType = VitalType | ActivityType;
export type WearableSample = { type: SampleType; value: number; value2?: number | null; takenAt: Date; origin?: string };
export type WearableEvent = { kind: "ECG" | "IRREGULAR_RHYTHM" | "HIGH_HR" | "LOW_HR"; takenAt: Date; classification?: string; heartRate?: number | null; origin?: string };
export type ParsedBatch = {
  format: "health-auto-export" | "normalized";
  samples: WearableSample[];
  events: WearableEvent[];
  /** Metric names we received but do not use (e.g. active_energy) — reported back, not stored. */
  ignored: string[];
  /** Samples dropped while parsing (missing date / value). */
  unparseable: number;
};

// ------------------------------------------------------------------ tokens
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export function newWearableToken() {
  const token = WEARABLE_TOKEN_PREFIX + randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token), hint: token.slice(-4) };
}

/** The active WEARABLE_SYNC link a token belongs to, or null (unknown / revoked). */
export async function deviceForToken(token: string): Promise<Device | null> {
  if (!token.startsWith(WEARABLE_TOKEN_PREFIX) || token.length < 30 || token.length > 100) return null;
  const d = await prisma.device.findFirst({ where: { tokenHash: hashToken(token), adapter: "WEARABLE_SYNC" } });
  return d && d.status === "CONNECTED" ? d : null;
}

// ------------------------------------------------------------------ parsing helpers
/** Accepts "yyyy-MM-dd HH:mm:ss Z" (Health Auto Export), ISO 8601, or epoch seconds / ms. */
export function parseTime(x: unknown): Date | null {
  if (typeof x === "number" && Number.isFinite(x)) return new Date(x < 1e12 ? x * 1000 : x);
  if (typeof x !== "string" || !x.trim()) return null;
  const s = x.trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*([+-])(\d{2}):?(\d{2})$/);
  const d = m ? new Date(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`) : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

const num = (x: unknown): number | null => {
  const n = typeof x === "string" ? Number(x) : x;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
const norm = (u: unknown) => (typeof u === "string" ? u.trim().toLowerCase().replace(/[°\s]/g, "") : "");

/** Converts a value into the unit this app stores for that type. Returns null for unknown units. */
export function toAppUnit(type: SampleType, value: number, unit?: string): number | null {
  const u = norm(unit);
  switch (type) {
    case "SPO2":
      // Apple Health stores a fraction (0.97); exporters may send either.
      return value <= 1 ? Math.round(value * 1000) / 10 : value;
    case "TEMP":
      if (!u || u === "degc" || u === "c" || u === "celsius" || u === "cel") return value;
      if (u === "degf" || u === "f" || u === "fahrenheit" || u === "[degf]") return Math.round(((value - 32) * 5) / 9 * 10) / 10;
      return null;
    case "GLUCOSE":
      if (!u || u === "mg/dl") return value;
      // HealthKit spells it "mmol<180.15588000005408>/L"
      if (/^mmol(<[\d.]+>)?\/l$/.test(u)) return Math.round(value * 18.016);
      return null;
    case "WEIGHT":
      if (!u || u === "kg") return value;
      if (u === "lb" || u === "lbs" || u === "[lb_av]") return Math.round(value * 0.45359237 * 10) / 10;
      if (u === "g") return Math.round(value / 100) / 10;
      return null;
    case "SLEEP":
      if (!u || u === "hr" || u === "h" || u === "hours") return value;
      if (u === "min") return Math.round((value / 60) * 10) / 10;
      return null;
    default:
      return value;
  }
}

/** Plausibility limits for consumer-device data (anything outside is rejected, not stored). */
export const PLAUSIBLE: Record<SampleType, [number, number]> = {
  HR: [20, 250],
  SPO2: [50, 100],
  BP: [50, 260],
  TEMP: [30, 43],
  RR: [4, 60],
  GLUCOSE: [20, 600],
  WEIGHT: [20, 300],
  STEPS: [0, 100_000],
  SLEEP: [0, 24],
  RESTING_HR: [20, 200],
  HRV: [1, 500],
};
const VITAL_KEYS = Object.keys(VITALS) as VitalType[];
const isVital = (t: string): t is VitalType => (VITAL_KEYS as string[]).includes(t);

// ------------------------------------------------------------------ Health Auto Export (iOS)
// Metric names follow the app's JSON export (snake_case HealthKit identifiers).
const HAE_METRICS: Record<string, SampleType> = {
  heart_rate: "HR",
  blood_oxygen_saturation: "SPO2",
  oxygen_saturation: "SPO2",
  respiratory_rate: "RR",
  body_temperature: "TEMP",
  blood_pressure: "BP",
  blood_glucose: "GLUCOSE",
  weight_body_mass: "WEIGHT",
  body_mass: "WEIGHT",
  step_count: "STEPS",
  sleep_analysis: "SLEEP",
  resting_heart_rate: "RESTING_HR",
  heart_rate_variability: "HRV",
  heart_rate_variability_sdnn: "HRV",
};

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const originOf = (x: unknown) => (typeof x === "string" ? x.slice(0, 80) : isRec(x) && typeof x.name === "string" ? x.name.slice(0, 80) : undefined);

function parseHealthAutoExport(data: Rec): ParsedBatch {
  const out: ParsedBatch = { format: "health-auto-export", samples: [], events: [], ignored: [], unparseable: 0 };
  const metrics = Array.isArray(data.metrics) ? data.metrics : [];
  for (const m of metrics) {
    if (!isRec(m) || typeof m.name !== "string") continue;
    const type = HAE_METRICS[m.name];
    if (!type) {
      if (!out.ignored.includes(m.name)) out.ignored.push(m.name);
      continue;
    }
    for (const pt of Array.isArray(m.data) ? m.data : []) {
      if (!isRec(pt)) continue;
      let value: number | null;
      let value2: number | null = null;
      let at: Date | null;
      if (type === "BP") {
        value = num(pt.systolic);
        value2 = num(pt.diastolic);
        at = parseTime(pt.date);
      } else if (type === "HR") {
        value = num(pt.Avg) ?? num(pt.qty);
        at = parseTime(pt.date);
      } else if (type === "SLEEP") {
        // Needs "Summarize Data" on in the exporter (one record per night).
        value = num(pt.totalSleep) ?? num(pt.asleep);
        at = parseTime(pt.sleepEnd ?? pt.inBedEnd ?? pt.date);
      } else {
        value = num(pt.qty);
        at = parseTime(pt.date);
      }
      if (value == null || !at || (type === "BP" && value2 == null)) {
        out.unparseable++;
        continue;
      }
      const conv = toAppUnit(type, value, typeof m.units === "string" ? m.units : undefined);
      if (conv == null) {
        out.unparseable++;
        continue;
      }
      out.samples.push({ type, value: conv, value2, takenAt: at, origin: originOf(pt.source) });
    }
  }
  for (const e of Array.isArray(data.ecg) ? data.ecg : []) {
    if (!isRec(e)) continue;
    const at = parseTime(e.start);
    if (!at) {
      out.unparseable++;
      continue;
    }
    out.events.push({ kind: "ECG", takenAt: at, classification: typeof e.classification === "string" ? e.classification.slice(0, 60) : "Not Set", heartRate: num(e.averageHeartRate), origin: originOf(e.source) });
  }
  for (const n of Array.isArray(data.heartRateNotifications) ? data.heartRateNotifications : []) {
    if (!isRec(n)) continue;
    const at = parseTime(n.start);
    const id = typeof n.heartNotification === "string" ? n.heartNotification.toLowerCase() : "";
    if (!at) {
      out.unparseable++;
      continue;
    }
    const kind: WearableEvent["kind"] | null = id.includes("irregular") ? "IRREGULAR_RHYTHM" : id.includes("high") ? "HIGH_HR" : id.includes("low") ? "LOW_HR" : null;
    if (!kind) continue;
    const origin = originOf(n.source);
    const hrs = (Array.isArray(n.heartRateData) ? n.heartRateData : []).filter(isRec);
    out.events.push({ kind, takenAt: at, heartRate: hrs.length ? num(hrs[hrs.length - 1].qty) : num(n.threshold), origin });
    // The heart-rate samples inside a high/low notification are real readings — keep them.
    for (const h of hrs) {
      const v = num(h.qty);
      const t = parseTime(h.start);
      if (v != null && t) out.samples.push({ type: "HR", value: v, takenAt: t, origin });
    }
  }
  return out;
}

// ------------------------------------------------------------------ normalized format (companion apps)
const SAMPLE_TYPES = [...VITAL_KEYS, ...(Object.keys(ACTIVITY) as ActivityType[])] as [SampleType, ...SampleType[]];
const timeIn = z.union([z.string().max(40), z.number()]);
export const normalizedSchema = z.object({
  device: z.object({ name: z.string().max(120).optional(), model: z.string().max(120).optional(), os: z.string().max(60).optional() }).optional(),
  samples: z
    .array(
      z.object({
        type: z.enum(SAMPLE_TYPES),
        value: z.number().finite(),
        value2: z.number().finite().nullable().optional(),
        unit: z.string().max(30).optional(),
        takenAt: timeIn,
        source: z.string().max(120).optional(),
      }),
    )
    .max(MAX_SAMPLES)
    .default([]),
  events: z
    .array(
      z.object({
        kind: z.enum(["ECG", "IRREGULAR_RHYTHM", "HIGH_HR", "LOW_HR"]),
        takenAt: timeIn,
        classification: z.string().max(60).optional(),
        heartRate: z.number().finite().optional(),
        source: z.string().max(120).optional(),
      }),
    )
    .max(500)
    .default([]),
});

function parseNormalized(body: unknown): ParsedBatch {
  const input = normalizedSchema.parse(body);
  const out: ParsedBatch = { format: "normalized", samples: [], events: [], ignored: [], unparseable: 0 };
  for (const s of input.samples) {
    const at = parseTime(s.takenAt);
    const value = toAppUnit(s.type, s.value, s.unit);
    if (!at || value == null || (s.type === "BP" && s.value2 == null)) {
      out.unparseable++;
      continue;
    }
    out.samples.push({ type: s.type, value, value2: s.value2 ?? null, takenAt: at, origin: s.source });
  }
  for (const e of input.events) {
    const at = parseTime(e.takenAt);
    if (!at) {
      out.unparseable++;
      continue;
    }
    out.events.push({ kind: e.kind, takenAt: at, classification: e.classification, heartRate: e.heartRate ?? null, origin: e.source });
  }
  return out;
}

export class PayloadError extends Error {}

/** Detects the payload format and turns it into normalized samples + events. */
export function parseWearablePayload(body: unknown): ParsedBatch {
  if (isRec(body) && isRec(body.data) && (Array.isArray(body.data.metrics) || Array.isArray(body.data.ecg) || Array.isArray(body.data.heartRateNotifications))) {
    const b = parseHealthAutoExport(body.data);
    if (b.samples.length > MAX_SAMPLES) throw new PayloadError(`Too many samples in one sync (${b.samples.length}); the limit is ${MAX_SAMPLES}. Send smaller batches.`);
    return b;
  }
  if (isRec(body) && (Array.isArray(body.samples) || Array.isArray(body.events))) return parseNormalized(body);
  throw new PayloadError('Unrecognised payload. Send Health Auto Export JSON ({ "data": { "metrics": [...] } }) or the normalized format ({ "samples": [...], "events": [...] }) — see docs/WEARABLES.md.');
}

// ------------------------------------------------------------------ ingestion
export type IngestResult = {
  ok: true;
  format: ParsedBatch["format"];
  received: number;
  accepted: number;
  duplicates: number;
  rejected: Record<string, number>;
  ignoredMetrics: string[];
  byType: Record<string, number>;
  alertsRaised: number;
  eventsRecorded: number;
};

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

/** Validates, de-duplicates and stores one sync batch, then runs the normal alert rules. */
export function ingestWearableBatch(device: Device, batch: ParsedBatch, opts: { demo?: boolean; now?: Date } = {}): Promise<IngestResult> {
  return withLock(async () => {
    const now = opts.now ?? new Date();
    const source = opts.demo ? "WEARABLE_DEMO" : "WEARABLE_SYNC";
    const rejected: Record<string, number> = {};
    const reject = (why: string) => (rejected[why] = (rejected[why] ?? 0) + 1);
    if (batch.unparseable) rejected["missing or unreadable value, unit or date"] = batch.unparseable;

    // 1. validate
    const valid: WearableSample[] = [];
    for (const s of batch.samples) {
      const age = now.getTime() - s.takenAt.getTime();
      const [lo, hi] = PLAUSIBLE[s.type];
      if (age < -MAX_FUTURE_MS) reject("timestamp in the future");
      else if (age > MAX_BACKFILL_MS) reject("older than 30 days");
      else if (s.value < lo || s.value > hi || (s.type === "BP" && (s.value2 == null || s.value2 < 30 || s.value2 > 160))) reject("implausible value");
      else valid.push(s);
    }

    // 2. de-duplicate (exporters re-send overlapping windows) — within the batch and against the store
    let duplicates = 0;
    const fresh: WearableSample[] = [];
    if (valid.length) {
      const times = valid.map((s) => s.takenAt.getTime());
      const existing = await prisma.reading.findMany({
        where: { deviceId: device.id, takenAt: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) } },
        select: { type: true, takenAt: true },
      });
      const seen = new Set(existing.map((r) => `${r.type}|${r.takenAt.getTime()}`));
      for (const s of valid) {
        const k = `${s.type}|${s.takenAt.getTime()}`;
        if (seen.has(k)) duplicates++;
        else {
          seen.add(k);
          fresh.push(s);
        }
      }
    }
    fresh.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());

    // 3. store
    const unitOf = (t: SampleType) => (isVital(t) ? VITALS[t].unit : ACTIVITY[t].unit);
    if (fresh.length) {
      await prisma.reading.createMany({
        data: fresh.map((s) => ({ patientId: device.patientId, deviceId: device.id, type: s.type, value: s.value, value2: s.value2 ?? null, unit: unitOf(s.type), source, quality: "CONSUMER_WEARABLE", takenAt: s.takenAt })),
      });
    }
    const byType: Record<string, number> = {};
    for (const s of fresh) byType[s.type] = (byType[s.type] ?? 0) + 1;

    // 4. latest values — only ever move forward in time
    const p = await prisma.patient.findUniqueOrThrow({ where: { id: device.patientId } });
    const latest: LatestMap = JSON.parse(p.latestJson || "{}");
    let lastReadingAt = p.lastReadingAt;
    for (const s of fresh) {
      if (!isVital(s.type)) continue;
      const cur = latest[s.type];
      if (!cur || new Date(cur.t).getTime() <= s.takenAt.getTime()) latest[s.type] = { v: s.value, v2: s.value2 ?? null, t: s.takenAt.toISOString(), src: source };
      if (!lastReadingAt || lastReadingAt < s.takenAt) lastReadingAt = s.takenAt;
    }
    await prisma.patient.update({ where: { id: p.id }, data: { latestJson: JSON.stringify(latest), lastReadingAt } });
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now, syncCount: { increment: fresh.length } } });

    // 5. alert rules — the same limits as every other source, but only for recent measurements
    const limits = (await loadLimits()).forPatient(p.id);
    const ctx = await loadAlertContext(prisma, now);
    // A batch can hold many samples per vital: alert once per vital, on the worst recent
    // breach (critical before review; the most recent when equally severe).
    let alertsRaised = 0;
    const pick = new Map<string, { s: WearableSample; rank: number }>();
    for (const s of fresh) {
      if (!isVital(s.type) || now.getTime() - s.takenAt.getTime() > ALERT_WINDOW_MS) continue;
      const b = worstBreach(s, limits);
      if (!b) continue;
      const rank = b.severity === "CRITICAL" ? 2 : 1;
      const cur = pick.get(s.type);
      if (!cur || rank > cur.rank || (rank === cur.rank && s.takenAt >= cur.s.takenAt)) pick.set(s.type, { s, rank });
    }
    for (const { s } of pick.values()) {
      const label = `${device.name} (${SOURCE_LABEL[source].toLowerCase()}, measured ${hhmm(s.takenAt)})`;
      alertsRaised += (await evaluateReadings(prisma, p.id, [s], limits, ctx.active, ctx.recentlyResolved, now, label)).length;
    }

    if (fresh.some((s) => s.type === "WEIGHT") && (await checkWeightTrend(prisma, p.id, ctx.active, ctx.recentlyResolved, now))) alertsRaised++;

    // 6. rhythm events from the watch
    let eventsRecorded = 0;
    for (const e of batch.events) {
      const age = now.getTime() - e.takenAt.getTime();
      if (age < -MAX_FUTURE_MS || age > MAX_BACKFILL_MS) {
        reject("event outside the accepted time window");
        continue;
      }
      eventsRecorded++;
      const who = e.origin ?? device.name;
      const hr = e.heartRate != null ? `, average ${Math.round(e.heartRate)} bpm` : "";
      const afib = e.kind === "ECG" && /fibrillation/i.test(e.classification ?? "");
      const flag = afib || e.kind === "IRREGULAR_RHYTHM";
      const describe =
        e.kind === "ECG" ? `Watch ECG at ${hhmm(e.takenAt)} classified by the device as "${e.classification ?? "Not set"}"${hr}` : e.kind === "IRREGULAR_RHYTHM" ? `Irregular rhythm notification at ${hhmm(e.takenAt)}${hr}` : `${e.kind === "HIGH_HR" ? "High" : "Low"} heart rate notification at ${hhmm(e.takenAt)}${hr}`;
      await prisma.auditLog.create({ data: { userName: who, userRole: "DEVICE", action: "WEARABLE_EVENT", patientId: p.id, detail: `${describe} (${SOURCE_LABEL[source]})`, createdAt: now } });
      if (flag && age <= RHYTHM_WINDOW_MS) {
        const a = await raiseAlert(
          prisma,
          p.id,
          {
            kind: "RHYTHM_FLAG",
            vital: "WATCH_RHYTHM",
            severity: "WARNING",
            title: afib ? "Smartwatch ECG classified as atrial fibrillation" : "Smartwatch irregular rhythm notification",
            message: `${describe} — ${who}. This is a consumer-wearable classification, not a diagnosis or a recorded clinical ECG${opts.demo ? " (demo sync, synthetic data)" : ""}. Requires clinician review.`,
          },
          ctx.active,
          ctx.recentlyResolved,
          now,
        );
        if (a) alertsRaised++;
      }
    }

    const received = batch.samples.length + batch.unparseable;
    const rej = Object.values(rejected).reduce((a, b) => a + b, 0);
    await prisma.auditLog.create({
      data: {
        userName: device.name,
        userRole: "DEVICE",
        action: opts.demo ? "WEARABLE_DEMO_SYNC" : "WEARABLE_SYNC",
        patientId: p.id,
        detail: `${received} samples received → ${fresh.length} stored${Object.keys(byType).length ? ` (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}, ${duplicates} duplicates skipped, ${rej} rejected${eventsRecorded ? `, ${eventsRecorded} rhythm/heart events` : ""}${alertsRaised ? `, ${alertsRaised} alerts raised` : ""}`,
        createdAt: now,
      },
    });
    return { ok: true, format: batch.format, received, accepted: fresh.length, duplicates, rejected, ignoredMetrics: batch.ignored, byType, alertsRaised, eventsRecorded };
  });
}

// ------------------------------------------------------------------ silence detection
/**
 * Called from the simulator's housekeeping pass. A linked wearable that has stopped
 * syncing raises SYNC_OVERDUE (once per silence); it clears itself when the next sync arrives.
 */
export async function checkWearableSync(now: Date, active: Alert[], systemResolve: (a: Alert, note: string) => Promise<void>) {
  const [links, alerts] = await Promise.all([
    prisma.device.findMany({ where: { adapter: "WEARABLE_SYNC", status: "CONNECTED", lastSeenAt: { not: null } } }),
    prisma.alert.findMany({ where: { kind: "SYNC_OVERDUE" }, orderBy: { createdAt: "desc" } }),
  ]);
  const byPatient = new Map<string, Device[]>();
  for (const d of links) byPatient.set(d.patientId, [...(byPatient.get(d.patientId) ?? []), d]);
  const patientsWithAlerts = new Set(alerts.map((a) => a.patientId));
  for (const pid of new Set([...byPatient.keys(), ...patientsWithAlerts])) {
    const stale = (byPatient.get(pid) ?? []).filter((d) => now.getTime() - d.lastSeenAt!.getTime() > SYNC_STALE_MS);
    const mine = alerts.filter((a) => a.patientId === pid);
    if (stale.length) {
      const since = Math.max(...stale.map((d) => d.lastSeenAt!.getTime()));
      if (!mine.some((a) => a.createdAt.getTime() >= since)) {
        const d = stale[0];
        await raiseAlert(
          prisma,
          pid,
          {
            kind: "SYNC_OVERDUE",
            vital: null,
            severity: "WARNING",
            title: `${d.name}: no data for over ${SYNC_STALE_MS >= 3600_000 ? `${Math.round(SYNC_STALE_MS / 3600_000)} h` : `${Math.max(1, Math.round(SYNC_STALE_MS / 60_000))} min`}`,
            message: `No smartwatch / phone data received since ${d.lastSeenAt!.toLocaleString("en-GB", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}. The phone may be off, out of battery, or the export app stopped. Absence of data does not mean the patient is well.`,
          },
          active,
          [],
          now,
        );
      }
    } else {
      for (const a of mine) if (a.status !== "RESOLVED") await systemResolve(a, "Wearable sync resumed (or link revoked)");
    }
  }
}

// ------------------------------------------------------------------ demo payload
export type DemoScenario = "NORMAL" | "LOW_SPO2" | "AFIB";

/** "2026-11-20 14:30:00 +0000" — the Health Auto Export date format. */
function haeDate(d: Date) {
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " +0000");
}

/**
 * A synthetic Health Auto Export payload, so the full ingest path (parser, units, de-dup,
 * rules, audit) can be demonstrated without an iPhone. Stored as WEARABLE_DEMO (labelled synthetic).
 */
export function demoHealthAutoExportPayload(scenario: DemoScenario, now = new Date()) {
  const jitter = (sd: number) => (Math.random() - 0.5) * 2 * sd;
  const min = (m: number) => new Date(now.getTime() - m * 60_000);
  const round = (x: number, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
  const hr = [];
  for (let m = 30; m >= 1; m -= 2) {
    const base = scenario === "AFIB" ? 108 + 18 * Math.sin(m * 1.7) : scenario === "LOW_SPO2" ? 102 : 72;
    const avg = round(base + jitter(scenario === "AFIB" ? 9 : 3));
    hr.push({ date: haeDate(min(m)), Min: avg - 4, Avg: avg, Max: avg + 5, source: "Apple Watch" });
  }
  const spo2 = (scenario === "LOW_SPO2" ? [92, 90, 88] : [97, 96, 97]).map((v, i) => ({ date: haeDate(min(25 - i * 10)), qty: v / 100, source: "Apple Watch" }));
  const steps = [];
  for (let h = 23; h >= 0; h--) {
    const at = new Date(now.getTime() - h * 3600_000);
    const hour = at.getUTCHours();
    steps.push({ date: haeDate(at), qty: hour >= 22 || hour < 7 ? 0 : Math.round(150 + Math.random() * 650), source: "iPhone" });
  }
  const wake = min(8 * 60);
  return {
    data: {
      metrics: [
        { name: "heart_rate", units: "count/min", data: hr },
        { name: "blood_oxygen_saturation", units: "%", data: spo2 },
        { name: "respiratory_rate", units: "count/min", data: [{ date: haeDate(min(20)), qty: scenario === "LOW_SPO2" ? 24 : 15, source: "Apple Watch" }] },
        { name: "step_count", units: "count", data: steps },
        { name: "resting_heart_rate", units: "count/min", data: [{ date: haeDate(min(60)), qty: scenario === "NORMAL" ? 61 : 74, source: "Apple Watch" }] },
        { name: "heart_rate_variability", units: "ms", data: [{ date: haeDate(min(90)), qty: round(scenario === "NORMAL" ? 46 + jitter(6) : 24 + jitter(4)), source: "Apple Watch" }] },
        { name: "sleep_analysis", units: "hr", data: [{ date: haeDate(wake), totalSleep: round(6.6 + jitter(0.6), 1), sleepStart: haeDate(new Date(wake.getTime() - 7.4 * 3600_000)), sleepEnd: haeDate(wake), source: "Apple Watch" }] },
        { name: "active_energy", units: "kcal", data: [{ date: haeDate(min(60)), qty: 210 }] },
      ],
      ecg:
        scenario === "AFIB"
          ? [{ start: haeDate(min(4)), end: haeDate(new Date(min(4).getTime() + 30_000)), classification: "Atrial Fibrillation", averageHeartRate: 118, samplingFrequency: 512, source: "Apple Watch" }]
          : [{ start: haeDate(min(180)), end: haeDate(new Date(min(180).getTime() + 30_000)), classification: "Sinus Rhythm", averageHeartRate: 70, samplingFrequency: 512, source: "Apple Watch" }],
    },
  };
}
