import { PrismaClient } from "@prisma/client";

const g = globalThis as unknown as { __prisma?: PrismaClient };

export const prisma = g.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.__prisma = prisma;

/** Serialises simulator / housekeeping work so concurrent polls never double-tick. */
const lockState = globalThis as unknown as { __riaLock?: Promise<unknown> };
export function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = lockState.__riaLock ?? Promise.resolve();
  const next = prev.then(fn, fn);
  lockState.__riaLock = next.catch(() => undefined);
  return next;
}
