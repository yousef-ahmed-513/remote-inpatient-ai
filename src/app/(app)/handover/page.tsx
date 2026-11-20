import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ROLE_HOME } from "@/lib/types";
import { HandoverClient } from "./HandoverClient";

export default async function HandoverPage() {
  const user = await getSessionUser();
  if (!user) redirect("/");
  if (!can(user.role, "handover:generate")) redirect(ROLE_HOME[user.role]);
  return <HandoverClient />;
}
