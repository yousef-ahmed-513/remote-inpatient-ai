import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/types";
import { CaregiverHome } from "./CaregiverHome";

export default async function CaregiverPage() {
  const u = await getSessionUser();
  if (!u) redirect("/");
  if (u.role !== "CAREGIVER" || !u.patientId) redirect(ROLE_HOME[u.role]);
  return <CaregiverHome patientId={u.patientId} />;
}
