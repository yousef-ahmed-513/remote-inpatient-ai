import { prisma } from "@/lib/db";
import { audit, HttpError, requireUser, route } from "@/lib/auth";
import { canCompleteTask, patientScope } from "@/lib/permissions";

// Mark a task as done. Clinicians may complete any task; patients and caregivers only
// tasks assigned to their own role, and only for the patient they are linked to.
export const PATCH = route<{ id: string }>(async (_req, { id }) => {
  const user = await requireUser("task:complete");
  const task = await prisma.task.findUnique({ where: { id } });
  if (!task) throw new HttpError(404, "Task not found");
  if (!patientScope(user, task.patientId)) throw new HttpError(403, "You do not have access to this patient record");
  if (!canCompleteTask(user.role, task.assigneeRole)) throw new HttpError(403, `This task is assigned to the ${task.assigneeRole.toLowerCase()}`);
  if (task.status === "DONE") throw new HttpError(409, "Task already completed");
  await prisma.task.update({ where: { id }, data: { status: "DONE", completedAt: new Date(), completedBy: user.name } });
  await audit(user, "TASK_COMPLETED", { patientId: task.patientId, detail: task.title });
  return { ok: true };
});
