// Device-to-server ingest for smartwatch / phone health data. Authenticated by a per-device
// bearer token (created from the patient's or clinician's "Smartwatch & phone" panel), NOT by a
// user session — the caller is the patient's phone. See docs/WEARABLES.md for the formats.
import { HttpError, route } from "@/lib/auth";
import { deviceForToken, ingestWearableBatch, MAX_BODY_BYTES, parseWearablePayload, PayloadError } from "@/lib/wearables";

function bearer(req: Request): string {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(\S+)\s*$/i);
  return (m?.[1] ?? req.headers.get("x-device-token") ?? "").trim();
}

async function authDevice(req: Request) {
  const token = bearer(req);
  if (!token) throw new HttpError(401, "Missing device token. Send it as: Authorization: Bearer <token>");
  const device = await deviceForToken(token);
  if (!device) throw new HttpError(401, "Unknown or revoked device token");
  return device;
}

/** Connection test for exporter apps: returns which link the token belongs to. */
export const GET = route(async (req) => {
  const d = await authDevice(req);
  return { ok: true, device: d.name, platform: d.platform, lastSyncAt: d.lastSeenAt, samplesStored: d.syncCount };
});

export const POST = route(async (req) => {
  const device = await authDevice(req);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, "Payload too large — send smaller batches (max 5 MB)");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Payload too large — send smaller batches (max 5 MB)");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
  let batch;
  try {
    batch = parseWearablePayload(body);
  } catch (e) {
    if (e instanceof PayloadError) throw new HttpError(400, e.message);
    throw e; // ZodError → 400 via route()
  }
  return ingestWearableBatch(device, batch);
});
