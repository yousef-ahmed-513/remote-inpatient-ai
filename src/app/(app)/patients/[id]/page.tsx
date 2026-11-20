import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { patientScope } from "@/lib/permissions";
import { ROLE_HOME } from "@/lib/types";
import { BedsideClient } from "./BedsideClient";

export default async function PatientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getSessionUser();
  if (!user) redirect("/");
  // Only the clinical team uses the bedside view; patients and caregivers have their own apps.
  if (patientScope(user, id) !== "clinical") redirect(ROLE_HOME[user.role]);
  return <BedsideClient patientId={id} />;
}
