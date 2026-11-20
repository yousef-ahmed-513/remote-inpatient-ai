// Home-hub device gateway (server only): medical-device readings arrive WITHOUT the patient typing
// anything. Design + integration plan: docs/DEVICE-GATEWAY.md
//
//   BLE medical devices ──(standard GATT profiles, auto-pair)──▶ cellular home hub
//        (BP cuff, glucose meter, oximeter, thermometer, scale)        │ provisioned by the nurse
//                                                                      ▼ HTTPS, hub bearer token
//                                    POST /api/ingest/device — HL7 FHIR Observation(s) or simple JSON
//                                      └─ ingestGatewayBatch(): serial → provisioned device → validate
//                                         → de-duplicate → store (source DEVICE_HUB) → limit rules
//                                         → scheduled measurement satisfied → audit
//
// The patient only uses the device (puts on the cuff, uses the meter). Upload, timing, units and the
// link to the right patient are handled by the hub and this module.
import { createHash, randomBytes } from "node:crypto";
import type { Device } from "@prisma/client";
import { z } from "zod";
import { prisma, withLock } from "./db";
import { checkWeightTrend, evaluateReadings, loadAlertContext, loadLimits } from "./alerts";
import { worstBreach } from "./rules";
import { SOURCE_LABEL, VITALS, type LatestMap, type VitalType } from "./types";
import { MAX_BACKFILL_MS, MAX_FUTURE_MS, PLAUSIBLE, parseTime, toAppUnit, ALERT_WINDOW_MS } from "./wearables";

export const HUB_TOKEN_PREFIX = "ria_hub_";
export const DEVICE_INGEST_PATH = "/api/ingest/device";
export const CHECKIN_INTERVAL_MS = 4 * 3600_000;
const MAX_READINGS = 5_000;

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
export function newHubToken() {
  const token = HUB_TOKEN_PREFIX + randomBytes(24).toString("base64url");
  return { token, hash: hashToken(token), hint: token.slice(-4) };
}
export async function hubForToken(token: string): Promise<Device | null> {
  if (!token.startsWith(HUB_TOKEN_PREFIX) || token.length < 30 || token.length > 100) return null;
  const d = await prisma.device.findFirst({ where: { tokenHash: hashToken(token), deviceType: "HOME_HUB" } });
  return d && d.status === "CONNECTED" ? d : null;
}

// ------------------------------------------------------------------ parsing
export type GatewaySample = { serial: string; type: VitalType; value: number; value2: number | null; takenAt: Date };
export type GatewayBatch = { format: "fhir" | "simple"; samples: GatewaySample[]; unparseable: number; ignored: string[] };
export class GatewayPayloadError extends Error {}

/** LOINC codes the gateway understands (HL7 Personal Health Device → FHIR mapping uses LOINC / MDC). */
export const LOINC: Record<string, VitalType> = {
  "8867-4": "HR",
  "59408-5": "SPO2",
  "2708-6": "SPO2",
  "85354-9": "BP",
  "8310-5": "TEMP",
  "9279-1": "RR",
  "2339-0": "GLUCOSE",
  "15074-8": "GLUCOSE",
  "29463-7": "WEIGHT",
};
const SYSTOLIC = "8480-6";
const DIASTOLIC = "8462-4";

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const codesOf = (cc: unknown): string[] => (isRec(cc) && Array.isArray(cc.coding) ? cc.coding.filter(isRec).map((c) => String(c.code ?? "")) : []);
const qty = (q: unknown) => (isRec(q) && typeof q.value === "number" && Number.isFinite(q.value) ? { value: q.value, unit: String(q.code ?? q.unit ?? "") } : null);

function observationSerial(o: Rec): string | null {
  const dev = o.device;
  if (isRec(dev)) {
    if (isRec(dev.identifier) && typeof dev.identifier.value === "string") return dev.identifier.value;
    if (typeof dev.display === "string") return dev.display;
  }
  return null;
}

function parseObservation(o: Rec, out: GatewayBatch) {
  const codes = codesOf(o.code);
  const loinc = codes.find((c) => LOINC[c]);
  if (!loinc) {
    out.ignored.push(codes[0] ?? "unknown");
    return;
  }
  const type = LOINC[loinc];
  const serial = observationSerial(o);
  const at = parseTime(o.effectiveDateTime ?? (isRec(o.effectivePeriod) ? o.effectivePeriod.start : undefined) ?? o.issued);
  if (!serial || !at || (o.status && !["final", "amended", "corrected", "preliminary"].includes(String(o.status)))) {
    out.unparseable++;
    return;
  }
  if (type === "BP") {
    const comps = Array.isArray(o.component) ? o.component.filter(isRec) : [];
    const sys = qty(comps.find((c) => codesOf(c.code).includes(SYSTOLIC))?.valueQuantity);
    const dia = qty(comps.find((c) => codesOf(c.code).includes(DIASTOLIC))?.valueQuantity);
    if (!sys || !dia) return void out.unparseable++;
    out.samples.push({ serial, type, value: sys.value, value2: dia.value, takenAt: at });
    return;
  }
  const q = qty(o.valueQuantity);
  const value = q ? toAppUnit(type, q.value, q.unit) : null;
  if (value == null) return void out.unparseable++;
  out.samples.push({ serial, type, value, value2: null, takenAt: at });
}

const simpleSchema = z.object({
  readings: z
    .array(z.object({ serial: z.string().min(1).max(80), type: z.enum(Object.keys(VITALS) as [VitalType, ...VitalType[]]), value: z.number().finite(), value2: z.number().finite().nullable().optional(), unit: z.string().max(20).optional(), takenAt: z.union([z.string().max(40), z.number()]) }))
    .max(MAX_READINGS),
});

/** FHIR Bundle / Observation, or { readings: [...] }. */
export function parseGatewayPayload(body: unknown): GatewayBatch {
  if (isRec(body) && (body.resourceType === "Bundle" || body.resourceType === "Observation")) {
    const out: GatewayBatch = { format: "fhir", samples: [], unparseable: 0, ignored: [] };
    const obs = body.resourceType === "Observation" ? [body] : (Array.isArray(body.entry) ? body.entry : []).filter(isRec).map((e) => e.resource).filter((r): r is Rec => isRec(r) && r.resourceType === "Observation");
    if (obs.length > MAX_READINGS) throw new GatewayPayloadError(`Too many observations (${obs.length}); the limit is ${MAX_READINGS}`);
    for (const o of obs) parseObservation(o, out);
    out.ignored = [...new Set(out.ignored)];
    return out;
  }
  if (isRec(body) && Array.isArray(body.readings)) {
    const input = simpleSchema.parse(body);
    const out: GatewayBatch = { format: "simple", samples: [], unparseable: 0, ignored: [] };
    for (const r of input.readings) {
      const at = parseTime(r.takenAt);
      const value = toAppUnit(r.type, r.value, r.unit);
      if (!at || value == null || (r.type === "BP" && r.value2 == null)) out.unparseable++;
      else out.samples.push({ serial: r.serial, type: r.type, value, value2: r.value2 ?? null, takenAt: at });
    }
    return out;
  }
  throw new GatewayPayloadError('Unrecognised payload. Send a FHIR Bundle of Observations (LOINC-coded, device.identifier = serial) or { "readings": [...] } — see docs/DEVICE-GATEWAY.md.');
}

// ------------------------------------------------------------------ ingestion
export type GatewayResult = { ok: true; format: GatewayBatch["format"]; received: number; accepted: number; duplicates: number; rejected: Record<string, number>; ignoredCodes: string[]; byType: Record<string, number>; alertsRaised: number; scheduledMeasurementMet: boolean };

const hhmm = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

export function ingestGatewayBatch(hub: Device, batch: GatewayBatch, opts: { demo?: boolean; now?: Date } = {}): Promise<GatewayResult> {
  return withLock(async () => {
    const now = opts.now ?? new Date();
    const source = opts.demo ? "DEVICE_HUB_DEMO" : "DEVICE_HUB";
    const rejected: Record<string, number> = {};
    const reject = (why: string, n = 1) => (rejected[why] = (rejected[why] ?? 0) + n);
    if (batch.unparseable) reject("missing value, unit, code, serial or time", batch.unparseable);

    const paired = await prisma.device.findMany({ where: { patientId: hub.patientId, hubId: hub.id } });
    const bySerial = new Map(paired.filter((d) => d.serial).map((d) => [d.serial!.toLowerCase(), d]));
    const valid: (GatewaySample & { device: Device })[] = [];
    for (const s of batch.samples) {
      const device = bySerial.get(s.serial.toLowerCase());
      const age = now.getTime() - s.takenAt.getTime();
      const [lo, hi] = PLAUSIBLE[s.type];
      if (!device) reject("device not paired with this hub");
      else if (device.status === "REVOKED") reject("device removed from this patient");
      else if (age < -MAX_FUTURE_MS) reject("timestamp in the future");
      else if (age > MAX_BACKFILL_MS) reject("older than 30 days");
      else if (s.value < lo || s.value > hi || (s.type === "BP" && (s.value2 == null || s.value2 < 30 || s.value2 > 160))) reject("implausible value");
      else valid.push({ ...s, device });
    }

    // de-duplicate: hubs retry uploads
    let duplicates = 0;
    const fresh: typeof valid = [];
    if (valid.length) {
      const times = valid.map((s) => s.takenAt.getTime());
      const existing = await prisma.reading.findMany({ where: { patientId: hub.patientId, deviceId: { in: [...new Set(valid.map((v) => v.device.id))] }, takenAt: { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) } }, select: { deviceId: true, type: true, takenAt: true } });
      const seen = new Set(existing.map((r) => `${r.deviceId}|${r.type}|${r.takenAt.getTime()}`));
      for (const s of valid) {
        const k = `${s.device.id}|${s.type}|${s.takenAt.getTime()}`;
        if (seen.has(k)) duplicates++;
        else {
          seen.add(k);
          fresh.push(s);
        }
      }
    }
    fresh.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
    if (fresh.length) {
      await prisma.reading.createMany({ data: fresh.map((s) => ({ patientId: hub.patientId, deviceId: s.device.id, type: s.type, value: s.value, value2: s.value2, unit: VITALS[s.type].unit, source, quality: "MEDICAL_DEVICE", takenAt: s.takenAt })) });
    }
    const byType: Record<string, number> = {};
    for (const s of fresh) byType[s.type] = (byType[s.type] ?? 0) + 1;

    // latest values (forward only), scheduled measurement
    const p = await prisma.patient.findUniqueOrThrow({ where: { id: hub.patientId } });
    const latest: LatestMap = JSON.parse(p.latestJson || "{}");
    let lastReadingAt = p.lastReadingAt;
    for (const s of fresh) {
      const cur = latest[s.type];
      if (!cur || new Date(cur.t).getTime() <= s.takenAt.getTime()) latest[s.type] = { v: s.value, v2: s.value2, t: s.takenAt.toISOString(), src: source };
      if (!lastReadingAt || lastReadingAt < s.takenAt) lastReadingAt = s.takenAt;
    }
    // A device measurement taken within the scheduled window counts as the scheduled check-in.
    const newest = fresh.length ? fresh[fresh.length - 1].takenAt : null;
    const met = !!(p.nextCheckInDueAt && newest && newest.getTime() >= p.nextCheckInDueAt.getTime() - CHECKIN_INTERVAL_MS);
    await prisma.patient.update({ where: { id: p.id }, data: { latestJson: JSON.stringify(latest), lastReadingAt, ...(met ? { nextCheckInDueAt: new Date(newest!.getTime() + CHECKIN_INTERVAL_MS) } : {}) } });
    for (const id of new Set(fresh.map((s) => s.device.id))) await prisma.device.update({ where: { id }, data: { lastSeenAt: now, status: "CONNECTED" } });
    await prisma.device.update({ where: { id: hub.id }, data: { lastSeenAt: now, syncCount: { increment: fresh.length } } });

    // limit rules — once per vital, worst recent breach, with device name and time
    const limits = (await loadLimits()).forPatient(p.id);
    const ctx = await loadAlertContext(prisma, now);
    let alertsRaised = 0;
    const pick = new Map<string, { s: (typeof fresh)[number]; rank: number }>();
    for (const s of fresh) {
      if (now.getTime() - s.takenAt.getTime() > ALERT_WINDOW_MS) continue;
      const b = worstBreach(s, limits);
      if (!b) continue;
      const rank = b.severity === "CRITICAL" ? 2 : 1;
      const cur = pick.get(s.type);
      if (!cur || rank > cur.rank || (rank === cur.rank && s.takenAt >= cur.s.takenAt)) pick.set(s.type, { s, rank });
    }
    for (const { s } of pick.values()) alertsRaised += (await evaluateReadings(prisma, p.id, [s], limits, ctx.active, ctx.recentlyResolved, now, `${s.device.name} (${SOURCE_LABEL[source].toLowerCase()}, measured ${hhmm(s.takenAt)})`)).length;
    if (fresh.some((s) => s.type === "WEIGHT") && (await checkWeightTrend(prisma, p.id, ctx.active, ctx.recentlyResolved, now))) alertsRaised++;

    const rej = Object.values(rejected).reduce((a, b) => a + b, 0);
    await prisma.auditLog.create({
      data: {
        userName: hub.name,
        userRole: "DEVICE",
        action: opts.demo ? "HUB_DEMO_UPLOAD" : "HUB_UPLOAD",
        patientId: p.id,
        detail: `${batch.samples.length + batch.unparseable} readings received → ${fresh.length} stored${Object.keys(byType).length ? ` (${Object.entries(byType).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}, ${duplicates} duplicates, ${rej} rejected${met ? ", scheduled measurement received" : ""}${alertsRaised ? `, ${alertsRaised} alerts` : ""}`,
        createdAt: now,
      },
    });
    return { ok: true, format: batch.format, received: batch.samples.length + batch.unparseable, accepted: fresh.length, duplicates, rejected, ignoredCodes: batch.ignored, byType, alertsRaised, scheduledMeasurementMet: met };
  });
}

// ------------------------------------------------------------------ demo upload (synthetic FHIR bundle)
/** What a hub would send after the patient uses each paired spot-check device. */
export async function demoHubBundle(patientId: string, hubId: string, scenario: "NORMAL" | "HIGH", now = new Date()) {
  const devices = await prisma.device.findMany({ where: { patientId, hubId, status: { not: "REVOKED" } } });
  const j = (sd: number) => (Math.random() - 0.5) * 2 * sd;
  const iso = (minAgo: number) => new Date(now.getTime() - minAgo * 60_000).toISOString();
  const coding = (code: string, display: string) => ({ coding: [{ system: "http://loinc.org", code, display }] });
  const q = (value: number, unit: string, code: string) => ({ value, unit, system: "http://unitsofmeasure.org", code });
  const entry: unknown[] = [];
  const add = (serial: string, code: string, display: string, extra: Rec) =>
    entry.push({ resource: { resourceType: "Observation", status: "final", category: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/observation-category", code: "vital-signs" }] }], code: coding(code, display), effectiveDateTime: iso(2), device: { identifier: { value: serial }, display: serial }, ...extra } });
  for (const d of devices) {
    if (!d.serial) continue;
    if (d.deviceType === "GLUCOMETER") add(d.serial, "15074-8", "Glucose [Moles/volume] in Blood", { valueQuantity: q(Math.round((scenario === "HIGH" ? 14.9 : 7.4 + j(0.6)) * 10) / 10, "mmol/L", "mmol/L") });
    if (d.deviceType === "BP_MONITOR") {
      add(d.serial, "85354-9", "Blood pressure panel", { component: [{ code: coding(SYSTOLIC, "Systolic blood pressure"), valueQuantity: q(Math.round(scenario === "HIGH" ? 168 : 128 + j(6)), "mmHg", "mm[Hg]") }, { code: coding(DIASTOLIC, "Diastolic blood pressure"), valueQuantity: q(Math.round(scenario === "HIGH" ? 96 : 80 + j(4)), "mmHg", "mm[Hg]") }] });
      add(d.serial, "8867-4", "Heart rate", { valueQuantity: q(Math.round(78 + j(5)), "beats/minute", "/min") });
    }
    if (d.deviceType === "PULSE_OXIMETER") add(d.serial, "59408-5", "Oxygen saturation by pulse oximetry", { valueQuantity: q(Math.round(97 + j(1)), "%", "%") });
    if (d.deviceType === "THERMOMETER") add(d.serial, "8310-5", "Body temperature", { valueQuantity: q(Math.round((36.8 + j(0.3)) * 10) / 10, "C", "Cel") });
    if (d.deviceType === "SCALE") add(d.serial, "29463-7", "Body weight", { valueQuantity: q(Math.round((78 + j(0.4)) * 10) / 10, "kg", "kg") });
  }
  return { resourceType: "Bundle", type: "collection", timestamp: now.toISOString(), entry };
}
