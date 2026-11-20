import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/types";
import { AdminClient } from "./AdminClient";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const u = await getSessionUser();
  if (!u) redirect("/");
  if (u.role !== "ADMIN") redirect(ROLE_HOME[u.role]);
  return <AdminClient />;
}
