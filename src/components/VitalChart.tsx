"use client";
import { useMemo } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { VITALS, type Limits, type ThresholdVital, type VitalType } from "@/lib/types";

export type Point = { t: string; v: number; v2: number | null; src: string };

const fmtTime = (ms: number, seconds: boolean) => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });

/**
 * Trend chart for one vital. Gaps in the data are drawn as gaps (never joined up),
 * and clinician-configured limits are shown as dashed reference lines.
 */
export function VitalChart({ type, points, limits, height = 220 }: { type: VitalType; points: Point[]; limits?: Partial<Record<ThresholdVital, Limits>>; height?: number }) {
  const meta = VITALS[type];
  const { rows, short } = useMemo(() => {
    const raw = points.map((p) => ({ x: new Date(p.t).getTime(), v: p.v as number | null, v2: p.v2 as number | null }));
    if (raw.length < 2) return { rows: raw, short: true };
    const out: typeof raw = [];
    raw.forEach((r, i) => {
      // Break the line where data stopped arriving. Spot-check history (minutes apart) is
      // judged against its own spacing; a live stream breaks after 45 s of silence.
      if (i > 1 && type !== "WEIGHT" && type !== "GLUCOSE") {
        const gap = r.x - raw[i - 1].x;
        const prevGap = raw[i - 1].x - raw[i - 2].x;
        const allowed = prevGap >= 4 * 60_000 ? Math.max(5.5 * 60_000, prevGap * 1.5) : 45_000;
        if (gap > allowed) out.push({ x: raw[i - 1].x + 1, v: null, v2: null });
      }
      out.push(r);
    });
    return { rows: out, short: raw[raw.length - 1].x - raw[0].x < 30 * 60_000 };
  }, [points, type]);

  if (points.length === 0) {
    return (
      <div style={{ height }} className="flex items-center justify-center rounded-xl border border-dashed border-line text-sm text-muted">
        No {meta.label.toLowerCase()} readings in this time window
      </div>
    );
  }

  const lim = type === "BP" ? limits?.BP_SYS : limits?.[type as ThresholdVital];
  const refs: { y: number; crit: boolean; label: string }[] = [];
  if (lim) {
    if (lim.critLow != null) refs.push({ y: lim.critLow, crit: true, label: `critical < ${lim.critLow}` });
    if (lim.warnLow != null) refs.push({ y: lim.warnLow, crit: false, label: `review < ${lim.warnLow}` });
    if (lim.warnHigh != null) refs.push({ y: lim.warnHigh, crit: false, label: `review > ${lim.warnHigh}` });
    if (lim.critHigh != null) refs.push({ y: lim.critHigh, crit: true, label: `critical > ${lim.critHigh}` });
  }
  const vals = rows.flatMap((r) => [r.v, r.v2]).filter((x): x is number => x != null);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  // Only pull limit lines into view when the data is near them — keeps the trace readable.
  const pad = Math.max((hi - lo) * 0.25, type === "TEMP" ? 0.4 : type === "SPO2" ? 2 : 6);
  const near = refs.filter((r) => r.y >= lo - pad * 2.5 && r.y <= hi + pad * 2.5);
  const yMin = Math.floor(Math.min(lo - pad, ...near.map((r) => r.y - pad * 0.3)) * 10) / 10;
  const yMax = Math.ceil(Math.max(hi + pad, ...near.map((r) => r.y + pad * 0.3)) * 10) / 10;
  const dots = rows.length < 60;

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 12, bottom: 0, left: -14 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="x" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={(v) => fmtTime(v, short)} tickLine={false} axisLine={false} minTickGap={48} />
          <YAxis domain={[type === "SPO2" ? Math.max(70, yMin) : yMin, type === "SPO2" ? 100 : yMax]} tickLine={false} axisLine={false} width={48} allowDecimals={type === "TEMP" || type === "WEIGHT"} />
          <Tooltip
            isAnimationActive={false}
            labelFormatter={(v) => fmtTime(Number(v), true)}
            formatter={(value, name) => [`${Number(value).toFixed(meta.decimals)} ${meta.unit}`, name === "v2" ? "Diastolic" : type === "BP" ? "Systolic" : meta.label]}
            contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 12, color: "var(--text)" }}
            labelStyle={{ color: "var(--muted)", fontSize: 11 }}
          />
          {near.map((r) => (
            <ReferenceLine key={r.label} y={r.y} stroke={r.crit ? "var(--crit)" : "var(--warn)"} strokeDasharray="5 4" strokeOpacity={0.9} label={{ value: r.label, position: "insideTopRight", fill: r.crit ? "var(--crit)" : "var(--warn)", fontSize: 10 }} />
          ))}
          <Line dataKey="v" type="monotone" stroke={meta.color} strokeWidth={2} dot={dots ? { r: 2.5 } : false} activeDot={{ r: 4 }} isAnimationActive={false} connectNulls={false} />
          {type === "BP" && <Line dataKey="v2" type="monotone" stroke={meta.color} strokeOpacity={0.55} strokeWidth={2} dot={dots ? { r: 2.5 } : false} isAnimationActive={false} connectNulls={false} />}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
