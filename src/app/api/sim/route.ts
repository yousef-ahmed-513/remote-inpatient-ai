import { z } from "zod";
import { audit, requireDemoMode, requireUser, route } from "@/lib/auth";
import { withLock } from "@/lib/db";
import { seedDatabase } from "@/lib/seed";
import { getSim, simControl } from "@/lib/simulator";
import { simDto } from "@/lib/views";

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["start", "pause", "step", "reset"]) }),
  z.object({ action: z.literal("speed"), speed: z.number().int() }),
  z.object({ action: z.literal("trigger"), scenario: z.enum(["RESP", "CARDIAC", "DISCONNECT", "RECONNECT", "MISSED_CHECKIN"]) }),
]);

export const GET = route(async () => {
  await requireUser("sim:control");
  return { sim: simDto(await getSim()) };
});

// Demo controls for the synthetic data simulator.
export const POST = route(async (req) => {
  const user = await requireUser("sim:control");
  requireDemoMode("The data simulator");
  const cmd = schema.parse(await req.json());
  if (cmd.action === "reset") {
    await withLock(() => seedDatabase());
    await audit(user, "SIM_RESET", { detail: "Demo data reset to the starting state" });
    return { sim: simDto(await getSim()) };
  }
  const sim = await simControl(cmd as Parameters<typeof simControl>[0]);
  await audit(user, "SIM_CONTROL", { detail: cmd.action === "trigger" ? `Triggered scenario: ${cmd.scenario}` : cmd.action === "speed" ? `Speed ×${cmd.speed}` : cmd.action });
  return { sim: simDto(sim!) };
});
