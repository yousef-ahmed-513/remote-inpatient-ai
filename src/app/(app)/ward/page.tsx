import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { ROLE_HOME } from "@/lib/types";
import { WardClient } from "./WardClient";

export default async function WardPage() {
  const user = await getSessionUser();
  if (!user) redirect("/");
  if (!can(user.role, "ward:view")) redirect(ROLE_HOME[user.role]);
  return <WardClient />;
}
