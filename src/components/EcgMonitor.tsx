"use client";
// Synthetic ECG rendering. The waveform is generated in the browser from heart rate +
// a "simulated irregularity" flag. It is never presented as a recorded ECG.
import clsx from "clsx";
import { useEffect, useMemo, useRef } from "react";
import { ECG_FS, synthEcg } from "@/lib/ecg";

const WINDOW_SEC = 6;

/** Live sweep display (monitor style). Pre-fills its buffer so it is never blank. */
export function EcgLive({ hr, irregular, connected, className }: { hr: number | null; irregular: boolean; connected: boolean; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const params = useRef({ hr: hr ?? 70, irregular });
  params.current = { hr: hr ?? 70, irregular };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !connected) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const n = WINDOW_SEC * ECG_FS;
    const buf = new Float32Array(n);
    let write = 0;
    let seed = (Math.random() * 1e9) | 0;
    let chunk: number[] = [];
    let ci = 0;
    const refill = () => {
      // Generate the next ~2.4 s with the *current* parameters so rate changes show within seconds.
      seed = (seed * 1664525 + 1013904223) | 0;
      chunk = synthEcg({ hr: params.current.hr, irregular: params.current.irregular, seed, seconds: 2.4 });
      ci = 0;
    };
    const push = (count: number) => {
      for (let i = 0; i < count; i++) {
        if (ci >= chunk.length) refill();
        buf[write] = chunk[ci++];
        write = (write + 1) % n;
      }
    };
    refill();
    push(n - 40);

    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      // grid
      ctx.lineWidth = 1;
      for (let x = 0; x <= w; x += w / (WINDOW_SEC * 5)) {
        ctx.strokeStyle = Math.round((x / w) * WINDOW_SEC * 5) % 5 === 0 ? "rgba(45,212,191,0.16)" : "rgba(45,212,191,0.06)";
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += h / 8) {
        ctx.strokeStyle = "rgba(45,212,191,0.08)";
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      // trace with a sweep gap ahead of the write head
      const gap = 14;
      const yOf = (v: number) => h * 0.62 - v * h * 0.42;
      ctx.strokeStyle = params.current.irregular ? "#fbbf24" : "#34f5c5";
      ctx.lineWidth = 1.8;
      ctx.lineJoin = "round";
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 6;
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; i++) {
        const dist = (i - write + n) % n;
        if (dist < gap) {
          pen = false;
          continue;
        }
        const x = (i / (n - 1)) * w;
        const y = yOf(buf[i]);
        if (!pen) {
          ctx.moveTo(x, y);
          pen = true;
        } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.shadowBlur = 0;
      const hx = (((write - 1 + n) % n) / (n - 1)) * w;
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(hx, yOf(buf[(write - 1 + n) % n]), 2.2, 0, Math.PI * 2);
      ctx.fill();
    };

    draw();
    let raf = 0;
    let last = performance.now();
    let carry = 0;
    const frame = (t: number) => {
      const dt = Math.min(0.25, (t - last) / 1000);
      last = t;
      carry += dt * ECG_FS;
      const k = Math.floor(carry);
      if (k > 0) {
        carry -= k;
        push(k);
        draw();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    // Fallback for background tabs where requestAnimationFrame is throttled.
    const iv = setInterval(() => {
      if (performance.now() - last > 500) {
        push(Math.round(0.5 * ECG_FS));
        last = performance.now();
        draw();
      }
    }, 500);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(iv);
    };
  }, [connected]);

  return (
    <div className={clsx("relative overflow-hidden rounded-xl bg-[var(--ecg-bg)]", className)}>
      {connected ? (
        <canvas ref={ref} className="block h-full w-full" role="img" aria-label={`Simulated ECG trace, ${irregular ? "simulated irregular rhythm" : "regular rhythm"}`} />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
          <div className="h-px w-2/3 bg-slate-600" />
          <p className="mt-3 text-sm font-semibold tracking-wide text-slate-300">NO SIGNAL</p>
          <p className="text-xs text-slate-500">ECG device disconnected — nothing is being received</p>
        </div>
      )}
      <div className="pointer-events-none absolute left-3 top-2.5 flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-teal-200">SIMULATED ECG · LEAD I</span>
        {connected && irregular && <span className="rounded bg-amber-400/20 px-1.5 py-0.5 text-[10px] font-bold tracking-wider text-amber-300">SIMULATED IRREGULARITY</span>}
      </div>
      {connected && (
        <div className="pointer-events-none absolute right-3 top-2 text-right">
          <div className={clsx("tnum text-2xl font-bold leading-none", irregular ? "text-amber-300" : "text-emerald-300")}>{hr != null ? Math.round(hr) : "--"}</div>
          <div className="text-[10px] font-medium text-slate-400">bpm</div>
        </div>
      )}
      <div className="pointer-events-none absolute bottom-2 left-3 text-[10px] text-slate-500">25 mm/s (illustrative) · artificial waveform, not a recorded ECG and not diagnostic</div>
    </div>
  );
}

/** Static stored strip, redrawn deterministically from its seed. */
export function EcgStrip({ hr, irregular, seed, seconds = 10, height = 120 }: { hr: number; irregular: boolean; seed: number; seconds?: number; height?: number }) {
  const W = 1000;
  const d = useMemo(() => {
    const s = synthEcg({ hr, irregular, seed, seconds });
    const yOf = (v: number) => height * 0.64 - v * height * 0.44;
    let p = "";
    for (let i = 0; i < s.length; i++) p += `${i === 0 ? "M" : "L"}${((i / (s.length - 1)) * W).toFixed(1)} ${yOf(s[i]).toFixed(1)}`;
    return p;
  }, [hr, irregular, seed, seconds, height]);
  const cols = seconds * 5;
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block w-full rounded-lg bg-[#fff5f5] dark:bg-[#1c1216]" style={{ height }} role="img" aria-label={`Stored simulated ECG strip, ${seconds} seconds, ${irregular ? "simulated irregular rhythm" : "regular rhythm"}`}>
      {Array.from({ length: cols + 1 }, (_, i) => (
        <line key={i} x1={(i / cols) * W} x2={(i / cols) * W} y1={0} y2={height} stroke="#e11d48" strokeOpacity={i % 5 === 0 ? 0.28 : 0.1} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      {Array.from({ length: 7 }, (_, i) => (
        <line key={i} x1={0} x2={W} y1={(i / 6) * height} y2={(i / 6) * height} stroke="#e11d48" strokeOpacity={0.12} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      ))}
      <path d={d} fill="none" stroke="currentColor" className="text-slate-900 dark:text-slate-100" strokeWidth={1.4} strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Tiny inline trend line for patient cards. */
export function Sparkline({ values, color, height = 28, min, max }: { values: number[]; color: string; height?: number; min?: number; max?: number }) {
  if (values.length < 2) return <div style={{ height }} className="flex items-center text-[10px] text-muted">no trend data</div>;
  const lo = Math.min(min ?? Infinity, ...values);
  const hi = Math.max(max ?? -Infinity, ...values);
  const span = hi - lo || 1;
  const W = 100;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * W).toFixed(1)},${(height - 3 - ((v - lo) / span) * (height - 6)).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="block w-full" style={{ height }} aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
