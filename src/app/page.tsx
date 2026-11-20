import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth";
import { ROLE_HOME } from "@/lib/types";
import { LoginClient } from "./LoginClient";

export const dynamic = "force-dynamic";

export default async function Home() {
  const user = await getSessionUser();
  if (user) redirect(ROLE_HOME[user.role]);
  return <LoginClient />;
}
