// Backend permission model. Every route handler calls into this — the UI hiding a
// button is never the only control.
import type { Role } from "./types";

export type Action =
  | "ward:view"
  | "patient:view" // open a patient record at all (scope decides which fields)
  | "patient:clinical" // notes, AI summaries, ECG, thresholds, audit timeline
  | "reading:submit"
  | "symptom:submit"
  | "symptom:review"
  | "note:create"
  | "assessment:complete"
  | "checkin:record"
  | "alert:view"
  | "alert:acknowledge"
  | "alert:escalate"
  | "alert:resolve"
  | "task:create"
  | "task:complete"
  | "message:read"
  | "message:send"
  | "summary:generate"
  | "handover:generate"
  | "threshold:edit"
  | "consult:request"
  | "consult:manage"
  | "device:manage"
  | "med:log"
  | "transfer:request" // ask the ambulance service for an emergency transfer
  | "transfer:manage" // cancel, prep checklist, demo clock
  | "urgent:help" // patient / caregiver "I need urgent help" button
  | "kit:manage" // provision the home hub, pair devices, allow manual-entry fallback
  | "sim:control"
  | "admin:view"
  | "admin:manage";

const CLINICIANS: Role[] = ["DOCTOR", "NURSE"];
const EVERYONE_ON_CARE: Role[] = ["DOCTOR", "NURSE", "PATIENT", "CAREGIVER"];

export const MATRIX: Record<Action, Role[]> = {
  "ward:view": CLINICIANS,
  "patient:view": EVERYONE_ON_CARE,
  "patient:clinical": CLINICIANS,
  "reading:submit": ["NURSE", "PATIENT", "CAREGIVER"],
  "symptom:submit": ["PATIENT", "CAREGIVER", "NURSE"],
  "symptom:review": CLINICIANS,
  "note:create": CLINICIANS,
  "assessment:complete": ["DOCTOR"],
  "checkin:record": ["NURSE", "CAREGIVER"],
  "alert:view": CLINICIANS,
  "alert:acknowledge": CLINICIANS,
  "alert:escalate": ["NURSE"],
  "alert:resolve": CLINICIANS,
  "task:create": CLINICIANS,
  "task:complete": EVERYONE_ON_CARE,
  "message:read": EVERYONE_ON_CARE,
  "message:send": EVERYONE_ON_CARE,
  "summary:generate": CLINICIANS,
  "handover:generate": CLINICIANS,
  "threshold:edit": ["DOCTOR"],
  "consult:request": ["PATIENT", "CAREGIVER"],
  "consult:manage": CLINICIANS,
  "device:manage": ["PATIENT", "NURSE", "DOCTOR"],
  "med:log": ["PATIENT", "CAREGIVER", "NURSE"],
  "transfer:request": CLINICIANS,
  "transfer:manage": CLINICIANS,
  "urgent:help": ["PATIENT", "CAREGIVER"],
  "kit:manage": CLINICIANS,
  "sim:control": ["ADMIN", "DOCTOR", "NURSE"],
  "admin:view": ["ADMIN"],
  "admin:manage": ["ADMIN"],
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[action].includes(role);
}

/** Which slice of a patient record this user may read. null = no access. */
export type PatientScope = "clinical" | "patient" | "caregiver";
export function patientScope(
  user: { role: Role; patientId: string | null },
  patientId: string,
): PatientScope | null {
  if (user.role === "DOCTOR" || user.role === "NURSE") return "clinical";
  if (user.role === "PATIENT" && user.patientId === patientId) return "patient";
  if (user.role === "CAREGIVER" && user.patientId === patientId) return "caregiver";
  return null; // admins get operational data only, never the clinical record
}

/** Tasks are completed by the role they are assigned to (clinicians may complete any). */
export function canCompleteTask(role: Role, assigneeRole: string): boolean {
  if (role === "DOCTOR" || role === "NURSE") return true;
  return role === assigneeRole;
}
