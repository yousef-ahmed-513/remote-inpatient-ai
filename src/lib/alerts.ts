// Rule-based alerting. Deterministic and transparent: every alert states the reading
// and the clinician-configured limit that was crossed. No autonomous clinical decisions.
import type { Alert, Prisma, Threshold } from "@prisma/client";
import { prisma } from "./db";
import { DEFAULT_LIMITS, THRESHOLD_VITALS, type Limits, type ThresholdVital } from "./types";

export type LimitMap = Record<ThresholdVital, Limits>;
type Db = Prisma.TransactionClient | typeof prisma;

/** After a clinician resolves an alert, the same rule stays quiet this long. */
export const RESOLVE_COOLDOWN_MS = 90_000;

export function buildLimitMaps(rows: Threshold[]): { defaults: LimitMap; forPatient: (id: string) => LimitMap } {
  const defaults: LimitMap = structuredClone(DEFAULT_LIMITS);
  const overrides = new Map<string, Partial<LimitMap>>();
  for (const r of rows) {
    const lim: Limits = { critLow: r.critLow, warnLow: r.warnLow, warnHigh: r.warnHigh, critHigh: r.critHigh };
    if (!(r.vital in defaults)) continue;
    if (r.patientId == null) defaults[r.vital as ThresholdVital] = lim;
    else overrides.set(r.patientId, { ...(overrides.get(r.patientId) ?? {}), [r.vital]: lim });
  }
  return { defaults, forPatient: (id) => ({ ...defaults, ...(overrides.get(id) ?? {}) }) };
}

export async function loadLimits(db: Db = prisma) {
  return buildLimitMaps(await db.threshold.findMany());
}

export { classify, ruleValues, type Breach, type ReadingInput } from "./rules";
import { classify, ruleValues, type Breach, type ReadingInput } from "./rules";

type AlertDraft = { kind: string; vital: string | null; severity: "WARNING" | "CRITICAL"; title: string; message: string };

/**
 * Creates or upgrades an alert, de-duplicating against the patient's active alerts.
 * `active` and `recentlyResolved` are mutated so one tick never double-raises.
 */
export async function raiseAlert(
  db: Db,
  patientId: string,
  draft: AlertDraft,
  active: Alert[],
  recentlyResolved: Alert[],
  now: Date,
): Promise<Alert | null> {
  const same = (a: Alert) => a.patientId === patientId && a.kind === draft.kind && a.vital === draft.vital;
  const existing = active.find(same);
  if (existing) {
    if (existing.severity === "WARNING" && draft.severity === "CRITICAL") {
      // Worsened: upgrade and re-open so it must be acknowledged again.
      const up = await db.alert.update({
        where: { id: existing.id },
        data: { severity: "CRITICAL", title: draft.title, message: draft.message, status: "OPEN", acknowledgedAt: null, acknowledgedById: null },
      });
      active[active.indexOf(existing)] = up;
      await db.auditLog.create({
        data: { userName: "System", userRole: "SYSTEM", action: "ALERT_UPGRADED", patientId, detail: `${draft.title} — upgraded from warning to critical` },
      });
      return up;
    }
    return null;
  }
  const cooling = recentlyResolved.some(
    (a) => same(a) && a.resolvedAt && now.getTime() - a.resolvedAt.getTime() < RESOLVE_COOLDOWN_MS && a.resolvedById !== "system",
  );
  if (cooling) return null;
  const created = await db.alert.create({ data: { patientId, ...draft, createdAt: now } });
  active.push(created);
  await db.auditLog.create({
    data: { userName: "System", userRole: "SYSTEM", action: "ALERT_RAISED", patientId, detail: `${draft.severity}: ${draft.title}`, createdAt: now },
  });
  return created;
}

export function thresholdDraft(vital: ThresholdVital, value: number, b: Breach, sourceLabel: string): AlertDraft {
  const meta = THRESHOLD_VITALS[vital];
  const shown = meta.step < 1 ? value.toFixed(1) : String(Math.round(value));
  const dir = b.direction === "low" ? "below" : "above";
  return {
    kind: "THRESHOLD",
    vital,
    severity: b.severity,
    title: `${meta.label} ${shown} ${meta.unit} — ${dir} ${b.severity === "CRITICAL" ? "critical" : "review"} limit`,
    message: `${sourceLabel} reading of ${shown} ${meta.unit} is ${dir} the configured ${b.severity === "CRITICAL" ? "critical" : "review"} limit of ${b.limit} ${meta.unit}. Rule-based demo alert — requires clinician review.`,
  };
}

/** Checks a batch of readings for one patient against limits. Returns alerts raised/upgraded. */
export async function evaluateReadings(
  db: Db,
  patientId: string,
  readings: ReadingInput[],
  limits: LimitMap,
  active: Alert[],
  recentlyResolved: Alert[],
  now: Date,
  sourceLabel: string,
): Promise<Alert[]> {
  const raised: Alert[] = [];
  for (const r of readings) {
    for (const { vital, value } of ruleValues(r)) {
      const b = classify(value, limits[vital]);
      if (!b) continue;
      const a = await raiseAlert(db, patientId, thresholdDraft(vital, value, b, sourceLabel), active, recentlyResolved, now);
      if (a) raised.push(a);
    }
  }
  return raised;
}

/** Trend rule: SpO₂ falling ≥3 points across the last 6 readings while under 96%. */
export function spo2TrendDraft(series: number[]): AlertDraft | null {
  if (series.length < 6) return null;
  const last6 = series.slice(-6);
  const drop = last6[0] - last6[5];
  if (drop >= 3 && last6[5] < 96) {
    return {
      kind: "TREND",
      vital: "SPO2",
      severity: "WARNING",
      title: `SpO₂ downward trend (${Math.round(last6[0])}% → ${Math.round(last6[5])}%)`,
      message: `Oxygen saturation has fallen ${drop.toFixed(0)} points across the last 6 readings. Trend rule — requires clinician review.`,
    };
  }
  return null;
}

export async function loadAlertContext(db: Db, now: Date) {
  const [active, recentlyResolved] = await Promise.all([
    db.alert.findMany({ where: { status: { not: "RESOLVED" } } }),
    db.alert.findMany({ where: { status: "RESOLVED", resolvedAt: { gte: new Date(now.getTime() - RESOLVE_COOLDOWN_MS) } } }),
  ]);
  return { active, recentlyResolved };
}
