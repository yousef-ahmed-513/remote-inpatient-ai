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
  WEARABLE_SYNC: "Smartwatch / phone sync",
  WEARABLE_DEMO: "Smartwatch demo sync (synthetic)",
  DEVICE_HUB: "Connected device (home hub)",
  DEVICE_HUB_DEMO: "Home hub demo upload (synthetic)",
};
/** Sources whose values are synthetic and must carry a SIMULATED badge. */
export const SYNTHETIC_SOURCES = new Set(["SIMULATED_DEVICE", "WEARABLE_DEMO", "DEVICE_HUB_DEMO"]);

// ---------------------------------------------------------------- wearables (see docs/WEARABLES.md)
/** Health-store platforms a smartwatch / phone link can sync from. */
export type WearablePlatform = "APPLE_HEALTH" | "HEALTH_CONNECT" | "OTHER";
export const WEARABLE_PLATFORMS: Record<WearablePlatform, { label: string; defaultName: string; devices: string; deviceType: "SMARTWATCH" | "PHONE" }> = {
  APPLE_HEALTH: { label: "Apple Health", defaultName: "Apple Watch / iPhone", devices: "iPhone · Apple Watch · any device that writes to Apple Health", deviceType: "SMARTWATCH" },
  HEALTH_CONNECT: { label: "Health Connect (Android)", defaultName: "Android phone / watch", devices: "Android phone · Wear OS · Galaxy Watch · Fitbit · Garmin, via Health Connect", deviceType: "SMARTWATCH" },
  OTHER: { label: "Other app / companion service", defaultName: "Health app link", devices: "Any app that can POST the documented JSON format", deviceType: "PHONE" },
};

/** Context metrics from consumer wearables. Shown for context only — no alert rules run on them. */
export type ActivityType = "STEPS" | "SLEEP" | "RESTING_HR" | "HRV";
export const ACTIVITY: Record<ActivityType, { label: string; unit: string; decimals: number }> = {
  STEPS: { label: "Steps", unit: "steps", decimals: 0 },
  SLEEP: { label: "Sleep", unit: "h", decimals: 1 },
  RESTING_HR: { label: "Resting heart rate", unit: "bpm", decimals: 0 },
  HRV: { label: "Heart rate variability", unit: "ms", decimals: 0 },
};
export const ACTIVITY_ORDER: ActivityType[] = ["STEPS", "SLEEP", "RESTING_HR", "HRV"];
export type ActivitySummary = Partial<Record<ActivityType, { v: number; t: string; src: string }>>;

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

// ---------------------------------------------------------------- emergency transfer (see docs/EMERGENCY-TRANSFER.md)
export type TransferStatus = "REQUESTED" | "DISPATCHED" | "ON_SCENE" | "TRANSPORTING" | "ARRIVED" | "HANDED_OVER" | "CANCELLED";
export const TRANSFER_STAGES: TransferStatus[] = ["REQUESTED", "DISPATCHED", "ON_SCENE", "TRANSPORTING", "ARRIVED", "HANDED_OVER"];
export const TRANSFER_STATUS: Record<TransferStatus, { label: string; patientLabel: string }> = {
  REQUESTED: { label: "Ambulance requested", patientLabel: "Ambulance requested" },
  DISPATCHED: { label: "Ambulance dispatched", patientLabel: "Ambulance on the way" },
  ON_SCENE: { label: "Crew with patient", patientLabel: "Ambulance crew is with you" },
  TRANSPORTING: { label: "Transporting", patientLabel: "On the way to hospital" },
  ARRIVED: { label: "Arrived at hospital", patientLabel: "Arrived at hospital" },
  HANDED_OVER: { label: "Handed over to receiving team", patientLabel: "With the hospital team" },
  CANCELLED: { label: "Cancelled", patientLabel: "Transfer cancelled" },
};
export const TRANSFER_OPEN: TransferStatus[] = ["REQUESTED", "DISPATCHED", "ON_SCENE", "TRANSPORTING", "ARRIVED"];

export type TransferPriority = "EMERGENCY" | "URGENT";
export const TRANSFER_PRIORITY: Record<TransferPriority, { label: string; hint: string }> = {
  EMERGENCY: { label: "Emergency (blue lights)", hint: "Immediate threat to life" },
  URGENT: { label: "Urgent", hint: "Needs hospital care now, stable enough for a non-emergency response" },
};

export type TransferPathway = "CARDIAC" | "RESPIRATORY" | "SEPSIS" | "SURGICAL" | "METABOLIC" | "GENERAL_MEDICAL" | "EMERGENCY_DEPT";
/** Receiving pathways. `direct` = the ambulance goes straight to the unit once it accepts (no ED). */
export const TRANSFER_PATHWAYS: Record<TransferPathway, { label: string; unit: string; direct: boolean }> = {
  CARDIAC: { label: "Cardiac", unit: "Coronary Care Unit (CCU)", direct: true },
  RESPIRATORY: { label: "Respiratory", unit: "Respiratory High Dependency Unit", direct: true },
  SEPSIS: { label: "Suspected sepsis", unit: "Acute Medical Unit — sepsis bay", direct: true },
  SURGICAL: { label: "Surgical", unit: "Surgical Assessment Unit", direct: true },
  METABOLIC: { label: "Metabolic / diabetes", unit: "Acute Medical Unit", direct: true },
  GENERAL_MEDICAL: { label: "General medical", unit: "Acute Medical Unit", direct: true },
  EMERGENCY_DEPT: { label: "Emergency department", unit: "Emergency Department (pre-alerted)", direct: false },
};

// ---------------------------------------------------------------- red-flag symptoms (deterministic triage, no AI)
export type RedFlag = "CHEST_PAIN" | "SEVERE_BREATHLESS" | "BLUE_LIPS" | "CONFUSION" | "FAINT" | "STROKE" | "BLEEDING" | "SEIZURE";
export const RED_FLAGS: Record<RedFlag, { label: string; pathway: TransferPathway; advice: string }> = {
  CHEST_PAIN: { label: "New or severe chest pain / pressure", pathway: "CARDIAC", advice: "Stop what you are doing, sit down and rest. Do not drive yourself." },
  SEVERE_BREATHLESS: { label: "Severe breathlessness — can't finish a sentence", pathway: "RESPIRATORY", advice: "Sit upright. If you use home oxygen, keep it on as prescribed." },
  BLUE_LIPS: { label: "Blue or grey lips / face", pathway: "RESPIRATORY", advice: "Sit upright and keep still." },
  CONFUSION: { label: "New confusion, very drowsy or hard to wake", pathway: "EMERGENCY_DEPT", advice: "Do not leave the person alone. Do not give food or drink." },
  FAINT: { label: "Fainted or collapsed", pathway: "EMERGENCY_DEPT", advice: "Lie down. Do not stand up quickly." },
  STROKE: { label: "Face drooping, arm weakness or slurred speech", pathway: "EMERGENCY_DEPT", advice: "Note the time the symptoms started — the hospital will ask." },
  BLEEDING: { label: "Heavy bleeding, or vomiting / coughing blood", pathway: "EMERGENCY_DEPT", advice: "Press firmly on any visible bleeding." },
  SEIZURE: { label: "Seizure / fit", pathway: "EMERGENCY_DEPT", advice: "Move objects away, do not hold the person down, note how long it lasts." },
};
export const RED_FLAG_ORDER: RedFlag[] = ["CHEST_PAIN", "SEVERE_BREATHLESS", "BLUE_LIPS", "CONFUSION", "FAINT", "STROKE", "BLEEDING", "SEIZURE"];
