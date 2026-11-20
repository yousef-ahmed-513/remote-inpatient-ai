// Monitoring state for a patient. Rule: missing or stale data is NEVER reported as stable.
import { STALE_MS, type MonitoringState } from "./types";

export type StatusInput = {
  lastReadingAt: Date | null;
  nextCheckInDueAt: Date | null;
  awaitingAssessment: boolean;
  devices: { streaming: boolean; status: string }[];
  activeAlerts: { severity: string; kind: string }[];
  unreviewedSymptoms: number;
};
export type SimClock = { running: boolean; pausedAt: Date | null };

/** While the simulation is paused, staleness is judged against the moment it was paused. */
export function referenceNow(sim: SimClock, now: Date): Date {
  return sim.running || !sim.pausedAt ? now : sim.pausedAt;
}

export function computeStatus(p: StatusInput, sim: SimClock, now: Date): { state: MonitoringState; reason: string } {
  const streaming = p.devices.filter((d) => d.streaming);
  const allDisconnected = streaming.length > 0 && streaming.every((d) => d.status !== "CONNECTED");
  const critical = p.activeAlerts.filter((a) => a.severity === "CRITICAL").length;

  if (critical > 0) return { state: "CRITICAL", reason: `${critical} critical demo alert${critical > 1 ? "s" : ""} open` };
  if (allDisconnected) return { state: "DEVICE_DISCONNECTED", reason: "No device is transmitting — current condition unknown" };

  const overdue = p.nextCheckInDueAt != null && p.nextCheckInDueAt.getTime() < now.getTime();
  if (overdue) return { state: "NO_RECENT_DATA", reason: "Scheduled check-in overdue — no observations received" };

  if (streaming.length > 0) {
    const ref = referenceNow(sim, now).getTime();
    if (!p.lastReadingAt || ref - p.lastReadingAt.getTime() > STALE_MS) {
      return { state: "NO_RECENT_DATA", reason: "No readings received recently — current condition unknown" };
    }
  } else if (!p.lastReadingAt) {
    return { state: "NO_RECENT_DATA", reason: "No observations on record" };
  }

  if (p.activeAlerts.length > 0) return { state: "NEEDS_REVIEW", reason: `${p.activeAlerts.length} alert${p.activeAlerts.length > 1 ? "s" : ""} awaiting review` };
  if (p.unreviewedSymptoms > 0) return { state: "NEEDS_REVIEW", reason: "Patient-reported symptom awaiting review" };
  if (p.awaitingAssessment) return { state: "AWAITING_ASSESSMENT", reason: "Admission assessment not yet recorded" };
  return { state: "STABLE", reason: "Latest readings are inside configured limits" };
}
