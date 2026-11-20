import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit, HttpError, requireUser, route } from "@/lib/auth";
import { onAlertResolved } from "@/lib/simulator";

const schema = z.object({ action: z.enum(["acknowledge", "escalate", "resolve"]), note: z.string().trim().max(1000).optional() });

export const PATCH = route<{ id: string }>(async (req, { id }) => {
  const { action, note } = schema.parse(await req.json());
  // Server-side permission per action: only nurses escalate; any clinician acknowledges / resolves.
  const user = await requireUser(action === "acknowledge" ? "alert:acknowledge" : action === "escalate" ? "alert:escalate" : "alert:resolve");
  const alert = await prisma.alert.findUnique({ where: { id }, include: { patient: true } });
  if (!alert) throw new HttpError(404, "Alert not found");
  if (alert.status === "RESOLVED") throw new HttpError(409, "This alert has already been resolved");
  const now = new Date();

  if (action === "acknowledge") {
    if (alert.acknowledgedAt) throw new HttpError(409, "This alert has already been acknowledged");
    await prisma.alert.update({ where: { id }, data: { acknowledgedAt: now, acknowledgedById: user.id, status: alert.status === "ESCALATED" ? "ESCALATED" : "ACKNOWLEDGED" } });
    await audit(user, "ALERT_ACKNOWLEDGED", { patientId: alert.patientId, detail: alert.title });
  } else if (action === "escalate") {
    if (alert.status === "ESCALATED") throw new HttpError(409, "This alert has already been escalated");
    await prisma.alert.update({
      where: { id },
      data: { status: "ESCALATED", escalatedAt: now, escalatedById: user.id, acknowledgedAt: alert.acknowledgedAt ?? now, acknowledgedById: alert.acknowledgedById ?? user.id },
    });
    await prisma.task.create({
      data: { patientId: alert.patientId, title: `Review escalated alert: ${alert.title}`, assigneeRole: "DOCTOR", dueAt: new Date(now.getTime() + 15 * 60_000), createdById: user.id, createdByName: user.name },
    });
    await audit(user, "ALERT_ESCALATED", { patientId: alert.patientId, detail: `${alert.title}${note ? ` — "${note}"` : ""} (escalated to doctor)` });
  } else {
    if (!note || note.length < 3) throw new HttpError(400, "A resolution note is required to resolve an alert");
    await prisma.alert.update({
      where: { id },
      data: { status: "RESOLVED", resolvedAt: now, resolvedById: user.id, resolutionNote: note, acknowledgedAt: alert.acknowledgedAt ?? now, acknowledgedById: alert.acknowledgedById ?? user.id },
    });
    await prisma.task.updateMany({ where: { patientId: alert.patientId, status: "OPEN", title: `Review escalated alert: ${alert.title}` }, data: { status: "DONE", completedAt: now, completedBy: user.name } });
    await audit(user, "ALERT_RESOLVED", { patientId: alert.patientId, detail: `${alert.title} — "${note}"` });
    await onAlertResolved(alert, alert.patient);
  }
  return { ok: true };
});
