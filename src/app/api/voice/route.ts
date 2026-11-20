// Voice command interpreter. The browser does speech-to-text / text-to-speech; this route turns the
// transcript into an answer plus (for writes) calls to the existing endpoints. See docs/VOICE.md.
import { z } from "zod";
import { audit, requireUser, route } from "@/lib/auth";
import { interpretVoice } from "@/lib/voice";

const schema = z.object({ text: z.string().trim().min(1).max(500), lang: z.enum(["en", "ar"]).optional(), patientId: z.string().max(60).nullable().optional() });

export const POST = route(async (req) => {
  const user = await requireUser();
  const input = schema.parse(await req.json());
  const out = await interpretVoice(user, input.text, { lang: input.lang, patientId: input.patientId ?? null });
  // The transcript itself is not stored (it may contain health details); the intent is.
  await audit(user, "VOICE_COMMAND", { patientId: user.patientId ?? input.patientId ?? null, detail: `Intent ${out.intent} (${out.lang})${out.calls?.length ? ` → ${out.calls.length} action(s) ${out.confirm ? "awaiting confirmation" : "sent immediately"}` : ""}` });
  return out;
});
