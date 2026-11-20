import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit, clearSession, getSessionUser, HttpError, route, setSession } from "@/lib/auth";
import { ensureSeeded } from "@/lib/seed";

// GET: current session + the synthetic demo accounts shown on the sign-in screen.
export const GET = route(async () => {
  await ensureSeeded();
  const [user, users] = await Promise.all([
    getSessionUser(),
    prisma.user.findMany({ orderBy: { createdAt: "asc" }, select: { id: true, name: true, role: true, title: true } }),
  ]);
  return { user, users };
});

// POST: demo sign-in — pick one of the synthetic accounts (no real credentials exist in this demo).
export const POST = route(async (req) => {
  await ensureSeeded();
  const { userId } = z.object({ userId: z.string().min(1) }).parse(await req.json());
  const u = await prisma.user.findUnique({ where: { id: userId } });
  if (!u) throw new HttpError(404, "Unknown demo account");
  await setSession(u.id);
  await audit({ id: u.id, name: u.name, role: u.role as never }, "SIGNED_IN", { detail: `Demo sign-in as ${u.role.toLowerCase()}` });
  return { user: { id: u.id, name: u.name, role: u.role, title: u.title, patientId: u.patientId } };
});

export const DELETE = route(async () => {
  const user = await getSessionUser();
  if (user) await audit(user, "SIGNED_OUT");
  await clearSession();
  return { ok: true };
});
