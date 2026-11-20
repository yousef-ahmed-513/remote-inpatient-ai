"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    cache: "no-store",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

/** Polls a JSON endpoint. Keeps the last good data on screen if a poll fails. */
export function useLive<T = any>(url: string | null, intervalMs = 2000) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const urlRef = useRef(url);
  urlRef.current = url;

  const refresh = useCallback(async () => {
    const u = urlRef.current;
    if (!u) return;
    try {
      const d = await api<T>(u);
      if (urlRef.current !== u) return;
      setData(d);
      setError(null);
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "Cannot reach the server — retrying…");
      if (err.status === 401 && typeof window !== "undefined") window.location.href = "/";
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!url) return;
    setLoading(true);
    refresh();
    const id = setInterval(refresh, intervalMs);
    return () => clearInterval(id);
  }, [url, intervalMs, refresh]);

  return { data, error, loading, refresh };
}

/** Runs an async action with busy + error state for buttons and forms. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, clearError: () => setError(null) };
}

const toDate = (d: string | Date) => (typeof d === "string" ? new Date(d) : d);

export function clock(d: string | Date | null | undefined, withSeconds = false): string {
  if (!d) return "—";
  return toDate(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(withSeconds ? { second: "2-digit" } : {}) });
}
export function dateTime(d: string | Date | null | undefined): string {
  if (!d) return "—";
  const x = toDate(d);
  return `${x.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${clock(x)}`;
}
export function timeAgo(d: string | Date | null | undefined, now: string | Date = new Date()): string {
  if (!d) return "never";
  const s = Math.round((toDate(now).getTime() - toDate(d).getTime()) / 1000);
  if (s < 0) {
    const m = Math.round(-s / 60);
    return m < 1 ? "in under a minute" : m < 60 ? `in ${m} min` : `in ${Math.floor(m / 60)} h ${m % 60} min`;
  }
  if (s < 5) return "just now";
  if (s < 60) return `${s} s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} d ago`;
}
export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.round(seconds)} s`;
  const m = seconds / 60;
  return m < 60 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`;
}
export const initials = (name: string) =>
  name
    .replace(/^(Dr\.|Nurse)\s+/i, "")
    .replace(/,.*$/, "")
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
