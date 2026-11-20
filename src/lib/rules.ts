// Pure limit-checking helpers (no database access) — shared by server rules and client display.
import { THRESHOLD_VITALS, type Limits, type ThresholdVital } from "./types";

export type Breach = { severity: "WARNING" | "CRITICAL"; direction: "low" | "high"; limit: number };

export function classify(value: number, l: Limits | undefined): Breach | null {
  if (!l) return null;
  if (l.critLow != null && value < l.critLow) return { severity: "CRITICAL", direction: "low", limit: l.critLow };
  if (l.critHigh != null && value > l.critHigh) return { severity: "CRITICAL", direction: "high", limit: l.critHigh };
  if (l.warnLow != null && value < l.warnLow) return { severity: "WARNING", direction: "low", limit: l.warnLow };
  if (l.warnHigh != null && value > l.warnHigh) return { severity: "WARNING", direction: "high", limit: l.warnHigh };
  return null;
}

export type ReadingInput = { type: string; value: number; value2?: number | null };
/** Expands a reading into the rule vitals it should be checked against (BP → systolic + diastolic). */
export function ruleValues(r: ReadingInput): { vital: ThresholdVital; value: number }[] {
  if (r.type === "BP") {
    const out: { vital: ThresholdVital; value: number }[] = [{ vital: "BP_SYS", value: r.value }];
    if (r.value2 != null) out.push({ vital: "BP_DIA", value: r.value2 });
    return out;
  }
  if (r.type in THRESHOLD_VITALS) return [{ vital: r.type as ThresholdVital, value: r.value }];
  return [];
}

/** Worst breach for a displayed reading, or null when inside limits. */
export function worstBreach(r: ReadingInput, limits: Partial<Record<ThresholdVital, Limits>> | undefined): Breach | null {
  if (!limits) return null;
  let worst: Breach | null = null;
  for (const rv of ruleValues(r)) {
    const b = classify(rv.value, limits[rv.vital]);
    if (b && (!worst || (b.severity === "CRITICAL" && worst.severity !== "CRITICAL"))) worst = b;
  }
  return worst;
}
