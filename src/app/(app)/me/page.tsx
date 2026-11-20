import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/types";
import { PatientHome } from "./PatientHome";

export default async function MePage() {
  const u = await getSessionUser();
  if (!u) redirect("/");
  if (u.role !== "PATIENT" || !u.patientId) redirect(ROLE_HOME[u.role]);
  return <PatientHome patientId={u.patientId} />;
}
