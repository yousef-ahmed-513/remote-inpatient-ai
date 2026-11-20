// Home-hub ingest: medical-device readings uploaded automatically by the patient's provisioned hub,
// authenticated by the hub's bearer token (no user session — nobody types anything).
// Formats and integration plan: docs/DEVICE-GATEWAY.md
import { HttpError, route } from "@/lib/auth";
import { GatewayPayloadError, hubForToken, ingestGatewayBatch, parseGatewayPayload } from "@/lib/gateway";
import { MAX_BODY_BYTES } from "@/lib/wearables";

async function authHub(req: Request) {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer\s+(\S+)\s*$/i);
  const token = (m?.[1] ?? req.headers.get("x-device-token") ?? "").trim();
  if (!token) throw new HttpError(401, "Missing hub token. Send it as: Authorization: Bearer <token>");
  const hub = await hubForToken(token);
  if (!hub) throw new HttpError(401, "Unknown or revoked hub token");
  return hub;
}

/** Connection test used by the hub at installation. */
export const GET = route(async (req) => {
  const hub = await authHub(req);
  return { ok: true, hub: hub.name, serial: hub.serial, lastUploadAt: hub.lastSeenAt };
});

export const POST = route(async (req) => {
  const hub = await authHub(req);
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, "Payload too large (max 5 MB)");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, "Payload too large (max 5 MB)");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new HttpError(400, "Body must be JSON (application/json or application/fhir+json)");
  }
  let batch;
  try {
    batch = parseGatewayPayload(body);
  } catch (e) {
    if (e instanceof GatewayPayloadError) throw new HttpError(400, e.message);
    throw e;
  }
  return ingestGatewayBatch(hub, batch);
});
