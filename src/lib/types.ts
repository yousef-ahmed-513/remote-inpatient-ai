// Shared constants + types (safe to import from client and server).

export type Role = "ADMIN" | "DOCTOR" | "NURSE" | "PATIENT" | "CAREGIVER";
export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Hospital administrator",
  DOCTOR: "Doctor",
  NURSE: "Nurse",
  PATIENT: "Patient",
  CAREGIVER: "Caregiver",
};
export const ROLE_HOME: Record<Role, string> = {
  ADMIN: "/admin",
  DOCTOR: "/ward",
  NURSE: "/ward",
  PATIENT: "/me",
  CAREGIVER: "/caregiver",
};

export type VitalType = "HR" | "SPO2" | "BP" | "TEMP" | "RR" | "GLUCOSE" | "WEIGHT";
export const VITALS: Record<VitalType, { label: string; short: string; unit: string; decimals: number; color: string }> = {
  HR: { label: "Heart rate", short: "HR", unit: "bpm", decimals: 0, color: "#e11d48" },
  SPO2: { label: "Oxygen saturation", short: "SpO₂", unit: "%", decimals: 0, color: "#1456A0" },
  BP: { label: "Blood pressure", short: "BP", unit: "mmHg", decimals: 0, color: "#7c3aed" },
  TEMP: { label: "Body temperature", short: "Temp", unit: "°C", decimals: 1, color: "#d97706" },
  RR: { label: "Respiratory rate", short: "RR", unit: "breaths/min", decimals: 0, color: "#14B8A6" },
  GLUCOSE: { label: "Blood glucose", short: "Glucose", unit: "mg/dL", decimals: 0, color: "#0891b2" },
  WEIGHT: { label: "Weight", short: "Weight", unit: "kg", decimals: 1, color: "#64748b" },
};
export const VITAL_ORDER: VitalType[] = ["HR", "SPO2", "BP", "RR", "TEMP", "GLUCOSE", "WEIGHT"];

export type ThresholdVital = "HR" | "SPO2" | "BP_SYS" | "BP_DIA" | "TEMP" | "RR" | "GLUCOSE";
export const THRESHOLD_VITALS: Record<ThresholdVital, { label: string; unit: string; step: number }> = {
  HR: { label: "Heart rate", unit: "bpm", step: 1 },
  SPO2: { label: "SpO₂", unit: "%", step: 1 },
  BP_SYS: { label: "Systolic BP", unit: "mmHg", step: 1 },
  BP_DIA: { label: "Diastolic BP", unit: "mmHg", step: 1 },
  TEMP: { label: "Temperature", unit: "°C", step: 0.1 },
  RR: { label: "Respiratory rate", unit: "breaths/min", step: 1 },
  GLUCOSE: { label: "Blood glucose", unit: "mg/dL", step: 1 },
};
export type Limits = { critLow: number | null; warnLow: number | null; warnHigh: number | null; critHigh: number | null };

/** Programme defaults. DEMO monitoring limits only — not clinical guidance. */
export const DEFAULT_LIMITS: Record<ThresholdVital, Limits> = {
  HR: { critLow: 40, warnLow: 50, warnHigh: 110, critHigh: 130 },
  SPO2: { critLow: 90, warnLow: 94, warnHigh: null, critHigh: null },
  BP_SYS: { critLow: 85, warnLow: 95, warnHigh: 160, critHigh: 180 },
  BP_DIA: { critLow: null, warnLow: 50, warnHigh: 100, critHigh: 110 },
  TEMP: { critLow: 35, warnLow: 35.8, warnHigh: 38, critHigh: 39 },
  RR: { critLow: 8, warnLow: 10, warnHigh: 22, critHigh: 28 },
  GLUCOSE: { critLow: 54, warnLow: 70, warnHigh: 250, critHigh: 400 },
};

export type MonitoringState =
  | "STABLE"
  | "NEEDS_REVIEW"
  | "CRITICAL"
  | "NO_RECENT_DATA"
  | "DEVICE_DISCONNECTED"
  | "AWAITING_ASSESSMENT";

export const STATE_META: Record<MonitoringState, { label: string; tone: "ok" | "warn" | "crit" | "muted" | "info" }> = {
  STABLE: { label: "Stable on latest readings", tone: "ok" },
  NEEDS_REVIEW: { label: "Needs review", tone: "warn" },
  CRITICAL: { label: "Critical demo alert", tone: "crit" },
  NO_RECENT_DATA: { label: "No recent data", tone: "muted" },
  DEVICE_DISCONNECTED: { label: "Device disconnected", tone: "muted" },
  AWAITING_ASSESSMENT: { label: "Awaiting clinician assessment", tone: "info" },
};
export const STATE_PRIORITY: MonitoringState[] = [
  "CRITICAL",
  "DEVICE_DISCONNECTED",
  "NO_RECENT_DATA",
  "NEEDS_REVIEW",
  "AWAITING_ASSESSMENT",
  "STABLE",
];

export type LatestVital = { v: number; v2?: number | null; t: string; src: string };
export type LatestMap = Partial<Record<VitalType, LatestVital>>;

export const SOURCE_LABEL: Record<string, string> = {
  SIMULATED_DEVICE: "Simulated device",
  PATIENT_REPORTED: "Patient-reported",
  CAREGIVER_REPORTED: "Caregiver-reported",
  CLINICIAN_ENTERED: "Clinician-entered",
};

export function formatVital(type: VitalType, v: number, v2?: number | null): string {
  const d = VITALS[type].decimals;
  if (type === "BP") return `${Math.round(v)}/${v2 == null ? "—" : Math.round(v2)}`;
  return v.toFixed(d);
}
export function mgdlToMmol(v: number): string {
  return (v / 18.016).toFixed(1);
}

export type SummarySection = { title: string; items: string[] };
export type SummaryDoc = { headline: string; sections: SummarySection[]; disclaimer: string };

/** Streaming data older than this (against the simulation clock) is "no recent data". */
export const STALE_MS = 45_000;
export const BASE_TICK_MS = 3_000;
