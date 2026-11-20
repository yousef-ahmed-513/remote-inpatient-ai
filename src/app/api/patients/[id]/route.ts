import { HttpError, requirePatientAccess, route } from "@/lib/auth";
import { patientView } from "@/lib/views";

export const GET = route<{ id: string }>(async (req, { id }) => {
  const { user, scope } = await requirePatientAccess(id, "patient:view");
  const w = Number(new URL(req.url).searchParams.get("window") ?? 15);
  const windowMin = [5, 15, 60, 360].includes(w) ? w : 15;
  const view = await patientView(user, id, scope, windowMin);
  if (!view) throw new HttpError(404, "Patient not found");
  return view;
});
