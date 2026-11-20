import { prisma } from "@/lib/db";
import { requireUser, route } from "@/lib/auth";
import { advanceSimulation } from "@/lib/simulator";
import { ensureSeeded } from "@/lib/seed";
import { alertDto, simDto } from "@/lib/views";

export const GET = route(async (req) => {
  const user = await requireUser("alert:view");
  await ensureSeeded();
  const sim = await advanceSimulation();
  const status = new URL(req.url).searchParams.get("status") ?? "active";
  const [alerts, users, patients] = await Promise.all([
    prisma.alert.findMany({
      where: status === "resolved" ? { status: "RESOLVED" } : status === "all" ? {} : { status: { not: "RESOLVED" } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.user.findMany(),
    prisma.patient.findMany({ select: { id: true, name: true, room: true, mrn: true } }),
  ]);
  const um = new Map(users.map((u) => [u.id, u]));
  const who = (id: string | null | undefined) => (id === "system" ? { id: "system", name: "System (automatic)", role: "SYSTEM" } : id && um.get(id) ? { id, name: um.get(id)!.name, role: um.get(id)!.role } : null);
  const pm = new Map(patients.map((p) => [p.id, p]));
  return { me: user, sim: simDto(sim), now: new Date(), alerts: alerts.map((a) => alertDto(a, who, pm.get(a.patientId))) };
});
