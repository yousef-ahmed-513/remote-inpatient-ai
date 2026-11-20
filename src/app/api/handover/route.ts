import { prisma } from "@/lib/db";
import { audit, requireUser, route } from "@/lib/auth";
import { aiProvider, generateHandover } from "@/lib/ai";
import { ensureSeeded } from "@/lib/seed";
import { advanceSimulation } from "@/lib/simulator";

export const GET = route(async () => {
  await requireUser("handover:generate");
  await ensureSeeded();
  const rows = await prisma.aiSummary.findMany({ where: { kind: "HANDOVER" }, orderBy: { createdAt: "desc" }, take: 5 });
  return { provider: aiProvider(), reports: rows.map((r) => ({ id: r.id, engine: r.engine, createdBy: r.createdBy, createdAt: r.createdAt, doc: JSON.parse(r.content) })) };
});

export const POST = route(async () => {
  const user = await requireUser("handover:generate");
  await advanceSimulation();
  const out = await generateHandover(user.name);
  await audit(user, "HANDOVER_GENERATED", { detail: `Engine: ${out.engine}` });
  return out;
});
