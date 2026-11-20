import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { prisma } from "./db";
import { can, patientScope, type Action, type PatientScope } from "./permissions";
import type { Role } from "./types";

const COOKIE = "ria_session";
const g = globalThis as unknown as { __riaSecret?: string };
function secret(): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Local demo only: per-process random secret (sessions reset on restart).
  g.__riaSecret ??= randomBytes(32).toString("hex");
  return g.__riaSecret;
}
function sign(value: string): string {
  return createHmac("sha256", secret()).update(value).digest("hex");
}

export type SessionUser = { id: string; name: string; role: Role; title: string; patientId: string | null };

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function setSession(userId: string) {
  const jar = await cookies();
  jar.set(COOKIE, `${userId}.${sign(userId)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.INSECURE_COOKIES !== "1",
    path: "/",
    maxAge: 60 * 60 * 12,
  });
}
export async function clearSession() {
  (await cookies()).delete(COOKIE);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const i = raw.lastIndexOf(".");
  if (i < 1) return null;
  const id = raw.slice(0, i);
  const mac = Buffer.from(raw.slice(i + 1));
  const expected = Buffer.from(sign(id));
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) return null;
  return { id: u.id, name: u.name, role: u.role as Role, title: u.title, patientId: u.patientId };
}

/** 401 when signed out, 403 when the role lacks the permission. */
export async function requireUser(action?: Action): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new HttpError(401, "Not signed in");
  if (action && !can(user.role, action)) {
    throw new HttpError(403, `Your role (${user.role.toLowerCase()}) is not permitted to perform "${action}"`);
  }
  return user;
}

/** Role permission + patient-level access in one call. */
export async function requirePatientAccess(
  patientId: string,
  action: Action,
): Promise<{ user: SessionUser; scope: PatientScope }> {
  const user = await requireUser(action);
  const scope = patientScope(user, patientId);
  if (!scope) throw new HttpError(403, "You do not have access to this patient record");
  return { user, scope };
}

type Ctx<P> = { params: Promise<P> };
/** Wraps a route handler: consistent JSON errors, no stack traces leaked. */
export function route<P = Record<string, string>>(
  fn: (req: Request, params: P) => Promise<unknown>,
): (req: Request, ctx: Ctx<P>) => Promise<Response> {
  return async (req, ctx) => {
    try {
      const params = (ctx?.params ? await ctx.params : {}) as P;
      const out = await fn(req, params);
      if (out instanceof Response) return out;
      return NextResponse.json(out ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
      if (e instanceof ZodError) {
        const msg = e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
        return NextResponse.json({ error: `Invalid input — ${msg}` }, { status: 400 });
      }
      console.error("[api]", e);
      return NextResponse.json({ error: "Unexpected server error" }, { status: 500 });
    }
  };
}

export async function audit(
  user: Pick<SessionUser, "id" | "name" | "role"> | null,
  action: string,
  opts: { patientId?: string | null; detail?: string } = {},
) {
  await prisma.auditLog.create({
    data: {
      userId: user?.id ?? null,
      userName: user?.name ?? "System",
      userRole: user?.role ?? "SYSTEM",
      action,
      patientId: opts.patientId ?? null,
      detail: opts.detail ?? "",
    },
  });
}
