"use client";
import clsx from "clsx";
import {
  Activity, Ambulance, ArrowLeft, BedDouble, BellRing, CalendarClock, CircleAlert, ClipboardCheck, ClipboardList, FileText, HeartPulse, History, ListChecks, MessageSquare,
  MessageSquareWarning, NotebookPen, Pill, Radio, Save, SlidersHorizontal, Sparkles, Stethoscope, Router, Syringe, Video, Watch,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertList, type AlertDto } from "@/components/AlertList";
import { TransferPanel, TransferRequestDialog, type TransferDto } from "@/components/TransferWidgets";
import { ActivityStrip, ConsultRoom, DevicePanel, HubPanel, MedicationList, MessageThread, TaskList, WearablePanel, type DeviceDto, type MedDto, type MessageDto, type TaskDto } from "@/components/CareWidgets";
import { EcgLive, EcgStrip } from "@/components/EcgMonitor";
import type { SimDto } from "@/components/SimControls";
import { SummaryView, type SummaryDto } from "@/components/SummaryView";
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Modal, PageError, PageLoading, Select, SimBadge, StatePill, Tabs, Textarea } from "@/components/ui";
import { VitalChart, type Point } from "@/components/VitalChart";
import { api, clock, dateTime, initials, timeAgo, useAction, useLive } from "@/lib/client";
import { worstBreach } from "@/lib/rules";
import {
  RED_FLAGS, ROLE_LABEL, SOURCE_LABEL, SYNTHETIC_SOURCES, type RedFlag, THRESHOLD_VITALS, type ActivitySummary, VITALS, VITAL_ORDER, formatVital, mgdlToMmol,
  type LatestMap, type Limits, type MonitoringState, type Role, type ThresholdVital, type VitalType,
} from "@/lib/types";

type Who = { id: string; name: string; role: string } | null;
type Strip = { id: string; takenAt: string; heartRate: number; irregular: boolean; seed: number; durationSec: number; label: string };
type View = {
  me: { id: string; name: string; role: Role };
  sim: SimDto;
  now: string;
  patient: {
    id: string; mrn: string; name: string; age: number; sex: string; condition: string; pathway: string; room: string; wardName: string; admittedAt: string;
    doctor: Who; nurse: Who; lastContactAt: string | null; lastReadingAt: string | null; nextCheckInDueAt: string | null; checkInOverdue: boolean; awaitingAssessment: boolean; carePlan: string[]; manualEntry?: boolean;
  };
  state: MonitoringState;
  stateReason: string;
  connectivity: string;
  latest: LatestMap;
  activity?: ActivitySummary;
  transfer?: TransferDto | null;
  devices: DeviceDto[];
  tasks: TaskDto[];
  medications: MedDto[];
  messages: MessageDto[];
  consults: { id: string; status: string; reason: string; requestedBy: string; createdAt: string; startedAt: string | null; endedAt: string | null }[];
  series: Record<string, Point[]>;
  limits: Record<ThresholdVital, Limits>;
  defaultLimits: Record<ThresholdVital, Limits>;
  limitOverrides: { vital: ThresholdVital; updatedBy: string | null; updatedAt: string }[];
  symptoms: { id: string; text: string; severity: string; redFlags?: string[]; reportedBy: string; createdAt: string; reviewedAt: string | null; reviewedBy: string | null }[];
  alerts: AlertDto[];
  notes: { id: string; authorName: string; authorRole: string; kind: string; body: string; createdAt: string }[];
  summaries: SummaryDto[];
  ecg: { available: boolean; connected: boolean; deviceName: string | null; heartRate: number | null; irregular: boolean; strips: Strip[] };
  timeline: { id: string; at: string; who: string; role: string; action: string; detail: string }[];
};

type TabId = "overview" | "trends" | "care" | "notes" | "devices" | "timeline";
const WINDOWS = [
  { v: 15, label: "15 min" },
  { v: 60, label: "1 h" },
  { v: 360, label: "6 h" },
];
const NOTE_KIND: Record<string, { label: string; tone: "primary" | "teal" | "info" | "muted" }> = {
  NOTE: { label: "Clinical note", tone: "muted" },
  OBSERVATION: { label: "Observation", tone: "teal" },
  CHECKIN: { label: "Check-in", tone: "primary" },
  ASSESSMENT: { label: "Assessment", tone: "info" },
};
const humanise = (a: string) => a.charAt(0) + a.slice(1).toLowerCase().replace(/_/g, " ");

// ---------------------------------------------------------------- vitals tiles
function VitalTiles({ v }: { v: View }) {
  const stale = v.state === "DEVICE_DISCONNECTED" || v.state === "NO_RECENT_DATA";
  const types = VITAL_ORDER.filter((t) => v.latest[t]);
  if (types.length === 0) return <Card><Empty>No readings on record for this patient.</Empty></Card>;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(auto-fit,minmax(165px,1fr))]">
      {types.map((t) => {
        const l = v.latest[t]!;
        const b = stale ? null : worstBreach({ type: t, value: l.v, value2: l.v2 }, v.limits);
        return (
          <Card key={t} className={clsx("relative overflow-hidden p-3.5", b?.severity === "CRITICAL" && "border-crit/60", b?.severity === "WARNING" && "border-warn/60")}>
            <span className="absolute inset-y-0 left-0 w-1" style={{ background: stale ? "var(--border)" : b ? (b.severity === "CRITICAL" ? "var(--crit)" : "var(--warn)") : VITALS[t].color }} aria-hidden />
            <p className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wide text-muted">
              {VITALS[t].label}
              {b && <Badge tone={b.severity === "CRITICAL" ? "crit" : "warn"}>{b.direction === "low" ? "LOW" : "HIGH"}</Badge>}
            </p>
            <p className={clsx("tnum mt-1.5 text-[26px] font-bold leading-none", stale ? "text-muted" : b?.severity === "CRITICAL" ? "text-crit" : b ? "text-warn" : "text-ink")}>
              {formatVital(t, l.v, l.v2)}
              <span className="ml-1 text-xs font-medium text-muted">{VITALS[t].unit}</span>
            </p>
            {t === "GLUCOSE" && <p className="tnum text-[11px] text-muted">{mgdlToMmol(l.v)} mmol/L</p>}
            <p className="tnum mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted" title={dateTime(l.t)}>
              {stale ? "Last received" : "Measured"} {timeAgo(l.t, v.now)}
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted">
              {SYNTHETIC_SOURCES.has(l.src) && <SimBadge />}
              {l.src !== "SIMULATED_DEVICE" && (SOURCE_LABEL[l.src] ?? l.src)}
            </p>
          </Card>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- ECG
function EcgCard({ v, refresh }: { v: View; refresh: () => void }) {
  const [strip, setStrip] = useState<Strip | null>(null);
  const { busy, error, run } = useAction();
  if (!v.ecg.available) return null;
  return (
    <Card>
      <CardHeader
        icon={<HeartPulse className="size-4" />}
        title="ECG monitor"
        subtitle={`${v.ecg.deviceName} · synthetic waveform for demonstration`}
        action={
          <Button size="sm" busy={busy} disabled={!v.ecg.connected} onClick={() => run(async () => (await api(`/api/patients/${v.patient.id}/ecg`, { body: {} }), refresh()))}>
            <Save className="size-3.5" /> Capture 10 s strip
          </Button>
        }
      />
      <div className="px-5 pb-4">
        <EcgLive hr={v.ecg.heartRate} irregular={v.ecg.irregular} connected={v.ecg.connected && v.state !== "NO_RECENT_DATA"} className="h-52" />
        {v.ecg.irregular && v.ecg.connected && (
          <p className="mt-2 flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
            <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            The simulated ECG patch is flagging irregular R-R intervals. This is a scripted, artificial pattern — not a rhythm diagnosis. Clinician review required.
          </p>
        )}
        <ErrorNote className="mt-2">{error}</ErrorNote>
        <h4 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-muted">Stored recordings</h4>
        {v.ecg.strips.length === 0 ? (
          <p className="py-3 text-xs text-muted">No stored strips yet.</p>
        ) : (
          <ul className="mt-1 divide-y divide-line">
            {v.ecg.strips.map((s) => (
              <li key={s.id}>
                <button type="button" onClick={() => setStrip(s)} className="flex w-full items-center gap-3 py-2 text-left hover:bg-surface-2">
                  <Activity className={clsx("size-4 shrink-0", s.irregular ? "text-warn" : "text-teal")} aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-ink">{s.label}</span>
                    <span className="tnum block text-[11px] text-muted">
                      {dateTime(s.takenAt)} · {s.durationSec} s · {s.heartRate} bpm
                    </span>
                  </span>
                  {s.irregular ? <Badge tone="warn">Simulated irregularity</Badge> : <Badge tone="muted">Regular (simulated)</Badge>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Modal open={!!strip} onClose={() => setStrip(null)} title="Stored ECG strip" wide>
        {strip && (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <SimBadge />
              <span className="tnum text-xs text-muted">
                {dateTime(strip.takenAt)} · {strip.durationSec} s · {strip.heartRate} bpm · {strip.label}
              </span>
              {strip.irregular && <Badge tone="warn">Simulated irregularity</Badge>}
            </div>
            <EcgStrip hr={strip.heartRate} irregular={strip.irregular} seed={strip.seed} seconds={strip.durationSec} height={170} />
            <p className="mt-3 text-[11px] leading-relaxed text-muted">Artificial waveform regenerated from stored simulator parameters. It is not a recorded ECG and must not be used for clinical interpretation.</p>
          </>
        )}
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- AI summary
function SummaryCard({ v, refresh }: { v: View; refresh: () => void }) {
  const { busy, error, run } = useAction();
  const [fresh, setFresh] = useState<SummaryDto | null>(null);
  const latest = fresh && (!v.summaries[0] || fresh.id === v.summaries[0].id || new Date(fresh.createdAt) >= new Date(v.summaries[0].createdAt)) ? fresh : v.summaries[0];
  const generate = () => run(async () => (setFresh(await api<SummaryDto>(`/api/patients/${v.patient.id}/summary`, { body: {} })), refresh()));
  return (
    <Card>
      <CardHeader
        icon={<Sparkles className="size-4" />}
        title="AI-assisted summary"
        subtitle="Summarises recorded data for clinician review"
        action={
          <Button size="sm" variant="teal" busy={busy} onClick={generate}>
            <Sparkles className="size-3.5" /> {latest ? "Regenerate" : "Generate"}
          </Button>
        }
      />
      <div className="px-5 pb-5">
        <ErrorNote className="mb-2">{error}</ErrorNote>
        {latest ? (
          <SummaryView summary={latest} />
        ) : (
          <Empty icon={<Sparkles className="size-6" />}>No summary yet. Generate one to get a structured overview of readings, trends, symptoms, alerts and data gaps.</Empty>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- symptoms
function SymptomsCard({ v, refresh }: { v: View; refresh: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Card>
      <CardHeader icon={<MessageSquareWarning className="size-4" />} title="Patient-reported symptoms" subtitle={`${v.symptoms.filter((s) => !s.reviewedAt).length} awaiting review`} />
      <div className="px-5 pb-4">
        {v.symptoms.length === 0 ? (
          <Empty>No symptoms reported.</Empty>
        ) : (
          <ul className="space-y-2">
            {v.symptoms.map((s) => (
              <li key={s.id} className={clsx("rounded-xl border p-3", s.reviewedAt ? "border-line" : "border-warn/50 bg-warn-soft/40")}>
                <p className="text-sm leading-relaxed text-ink">“{s.text}”</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted">
                  <Badge tone={s.severity === "SEVERE" ? "crit" : s.severity === "MODERATE" ? "warn" : "muted"}>{s.severity.toLowerCase()}</Badge>
                  {s.redFlags?.map((f) => (
                    <Badge key={f} tone="crit">
                      Red flag: {RED_FLAGS[f as RedFlag]?.label ?? f}
                    </Badge>
                  ))}
                  {s.reportedBy} · {timeAgo(s.createdAt, v.now)}
                  {s.reviewedAt ? (
                    <span className="text-ok">· reviewed by {s.reviewedBy} at {clock(s.reviewedAt)}</span>
                  ) : (
                    <Button size="sm" className="ml-auto" disabled={busy} onClick={() => run(async () => (await api(`/api/patients/${v.patient.id}/symptom-review`, { body: { symptomId: s.id } }), refresh()))}>
                      Mark reviewed
                    </Button>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        <ErrorNote className="mt-2">{error}</ErrorNote>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- notes
function NoteComposer({ v, refresh, preset, onDone }: { v: View; refresh: () => void; preset?: string; onDone?: () => void }) {
  const role = v.me.role;
  const kinds = ["NOTE", "OBSERVATION", ...(role === "NURSE" ? ["CHECKIN"] : []), ...(role === "DOCTOR" ? ["ASSESSMENT"] : [])];
  const [kind, setKind] = useState(preset && kinds.includes(preset) ? preset : "NOTE");
  const [body, setBody] = useState("");
  const { busy, error, run } = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => (await api(`/api/patients/${v.patient.id}/notes`, { body: { kind, body: body.trim() } }), setBody(""), refresh(), onDone?.()));
      }}
    >
      <div className="flex flex-wrap gap-3">
        <Field label="Entry type" className="w-44">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {NOTE_KIND[k].label}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label={kind === "ASSESSMENT" ? "Assessment (clears “awaiting clinician assessment”)" : kind === "CHECKIN" ? "Check-in record (updates last contact)" : "Note"} className="mt-3">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your entry…" maxLength={4000} />
      </Field>
      <ErrorNote className="mt-2">{error}</ErrorNote>
      <div className="mt-3 flex justify-end">
        <Button type="submit" variant="primary" busy={busy} disabled={body.trim().length < 3}>
          <NotebookPen className="size-3.5" /> Save to record
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- tasks
function TaskComposer({ v, refresh }: { v: View; refresh: () => void }) {
  const [title, setTitle] = useState("");
  const [assignee, setAssignee] = useState(v.me.role === "DOCTOR" ? "NURSE" : "DOCTOR");
  const [due, setDue] = useState("60");
  const { busy, error, run } = useAction();
  return (
    <form
      className="mt-3 rounded-xl bg-surface-2 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => (await api(`/api/patients/${v.patient.id}/tasks`, { body: { title: title.trim(), assigneeRole: assignee, dueInMinutes: Number(due) } }), setTitle(""), refresh()));
      }}
    >
      <p className="mb-2 text-xs font-semibold text-ink">{v.me.role === "DOCTOR" ? "Request follow-up" : "Add task"}</p>
      <div className="grid gap-2 sm:grid-cols-[1fr_130px_110px_auto]">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Repeat SpO₂ spot check and call patient" aria-label="Task title" maxLength={200} />
        <Select value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assign to">
          {(["NURSE", "DOCTOR", "CAREGIVER", "PATIENT"] as Role[]).map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </Select>
        <Select value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due">
          <option value="15">in 15 min</option>
          <option value="60">in 1 h</option>
          <option value="240">in 4 h</option>
          <option value="1440">tomorrow</option>
        </Select>
        <Button type="submit" variant="primary" busy={busy} disabled={title.trim().length < 3}>
          Add
        </Button>
      </div>
      <ErrorNote className="mt-2">{error}</ErrorNote>
    </form>
  );
}

// ---------------------------------------------------------------- limits
function LimitsCard({ v, refresh }: { v: View; refresh: () => void }) {
  const canEdit = v.me.role === "DOCTOR";
  const [editing, setEditing] = useState<ThresholdVital | null>(null);
  const [form, setForm] = useState<Record<keyof Limits, string>>({ critLow: "", warnLow: "", warnHigh: "", critHigh: "" });
  const { busy, error, run, clearError } = useAction();
  const open = (vital: ThresholdVital) => {
    const l = v.limits[vital];
    setForm({ critLow: l.critLow?.toString() ?? "", warnLow: l.warnLow?.toString() ?? "", warnHigh: l.warnHigh?.toString() ?? "", critHigh: l.critHigh?.toString() ?? "" });
    clearError();
    setEditing(vital);
  };
  const n = (s: string) => (s.trim() === "" ? null : Number(s));
  const save = () =>
    run(async () => {
      await api(`/api/patients/${v.patient.id}/thresholds`, { body: { vital: editing, critLow: n(form.critLow), warnLow: n(form.warnLow), warnHigh: n(form.warnHigh), critHigh: n(form.critHigh) } });
      setEditing(null);
      refresh();
    });
  const reset = (vital: ThresholdVital) => run(async () => (await api(`/api/patients/${v.patient.id}/thresholds`, { body: { vital, reset: true } }), setEditing(null), refresh()));
  const cell = (x: number | null) => (x == null ? <span className="text-muted/50">—</span> : x);
  return (
    <Card>
      <CardHeader
        icon={<SlidersHorizontal className="size-4" />}
        title="Monitoring limits for this patient"
        subtitle={canEdit ? "Configured by the doctor. Readings outside these limits raise rule-based alerts." : "Set by the doctor (read-only for nurses)."}
      />
      <div className="overflow-x-auto px-5 pb-4">
        <table className="w-full min-w-[560px] text-left text-sm">
          <thead>
            <tr className="border-b border-line text-[11px] uppercase tracking-wide text-muted">
              <th className="py-2 font-semibold">Vital</th>
              <th className="py-2 font-semibold text-crit">Critical low</th>
              <th className="py-2 font-semibold text-warn">Review low</th>
              <th className="py-2 font-semibold text-warn">Review high</th>
              <th className="py-2 font-semibold text-crit">Critical high</th>
              <th className="py-2 font-semibold">Source</th>
              <th />
            </tr>
          </thead>
          <tbody className="tnum divide-y divide-line">
            {(Object.keys(THRESHOLD_VITALS) as ThresholdVital[]).map((vital) => {
              const l = v.limits[vital];
              const o = v.limitOverrides.find((x) => x.vital === vital);
              return (
                <tr key={vital}>
                  <td className="py-2.5 font-medium text-ink">
                    {THRESHOLD_VITALS[vital].label} <span className="text-xs font-normal text-muted">({THRESHOLD_VITALS[vital].unit})</span>
                  </td>
                  <td className="py-2.5">{cell(l.critLow)}</td>
                  <td className="py-2.5">{cell(l.warnLow)}</td>
                  <td className="py-2.5">{cell(l.warnHigh)}</td>
                  <td className="py-2.5">{cell(l.critHigh)}</td>
                  <td className="py-2.5">{o ? <Badge tone="info" title={dateTime(o.updatedAt)}>Patient-specific · {o.updatedBy}</Badge> : <Badge tone="muted">Programme default</Badge>}</td>
                  <td className="py-2.5 text-right">
                    {canEdit && (
                      <Button size="sm" onClick={() => open(vital)}>
                        Edit
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="mt-3 text-[11px] text-muted">Demo monitoring limits — not clinical guidance.</p>
      </div>
      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing ? `Limits · ${THRESHOLD_VITALS[editing].label} (${THRESHOLD_VITALS[editing].unit})` : ""}>
        {editing && (
          <>
            <p className="text-xs text-muted">Leave a box empty to switch that limit off. Values must increase from left to right.</p>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {(["critLow", "warnLow", "warnHigh", "critHigh"] as (keyof Limits)[]).map((k) => (
                <Field key={k} label={{ critLow: "Critical low", warnLow: "Review low", warnHigh: "Review high", critHigh: "Critical high" }[k]}>
                  <Input type="number" step={THRESHOLD_VITALS[editing].step} value={form[k]} onChange={(e) => setForm((f) => ({ ...f, [k]: e.target.value }))} />
                </Field>
              ))}
            </div>
            <ErrorNote className="mt-3">{error}</ErrorNote>
            <div className="mt-5 flex flex-wrap justify-between gap-2">
              <Button variant="ghost" disabled={busy || !v.limitOverrides.some((x) => x.vital === editing)} onClick={() => reset(editing)}>
                Reset to programme default
              </Button>
              <span className="flex gap-2">
                <Button onClick={() => setEditing(null)}>Cancel</Button>
                <Button variant="primary" busy={busy} onClick={save}>
                  Save limits
                </Button>
              </span>
            </div>
          </>
        )}
      </Modal>
    </Card>
  );
}

// ---------------------------------------------------------------- page
export function BedsideClient({ patientId }: { patientId: string }) {
  const [win, setWin] = useState(15);
  const { data: v, error, loading, refresh } = useLive<View>(`/api/patients/${patientId}?window=${win}`, 2000);
  const [tab, setTab] = useState<TabId>("overview");
  const [noteOpen, setNoteOpen] = useState<string | null>(null);
  const [room, setRoom] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  // Voice command "ambulance for <patient>" lands here with ?transfer=1 → open the form (never auto-submits).
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("transfer") === "1") {
      setTransferOpen(true);
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const consult = useAction();

  if (loading && !v) return <PageLoading />;
  if (!v) return <PageError message={error?.message ?? "No data"} onRetry={refresh} />;

  const p = v.patient;
  const role = v.me.role;
  const stale = v.state === "DEVICE_DISCONNECTED" || v.state === "NO_RECENT_DATA";
  const active = v.alerts.filter((a) => a.status !== "RESOLVED");
  const openConsult = v.consults.find((c) => c.status !== "COMPLETED");
  const startConsult = () => consult.run(async () => (await api(`/api/patients/${p.id}/consult`, { body: { status: "IN_PROGRESS" } }), setRoom(true), refresh()));
  const endConsult = () => consult.run(async () => (await api(`/api/patients/${p.id}/consult`, { body: { status: "COMPLETED" } }), refresh()));
  const chartTypes = VITAL_ORDER.filter((t) => v.series[t]?.length || v.latest[t]);

  const WindowPicker = (
    <div className="flex overflow-hidden rounded-lg border border-line" role="group" aria-label="Time window">
      {WINDOWS.map((w) => (
        <button key={w.v} type="button" aria-pressed={win === w.v} onClick={() => setWin(w.v)} className={clsx("h-8 px-2.5 text-xs font-semibold", win === w.v ? "bg-primary text-white dark:text-[#06131f]" : "bg-surface text-muted hover:bg-surface-2")}>
          {w.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="space-y-4">
      <Link href="/ward" className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted hover:text-primary">
        <ArrowLeft className="size-3.5" /> Virtual ward
      </Link>

      {/* Patient header */}
      <Card className="p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex min-w-0 gap-4">
            <span className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-primary text-lg font-bold text-white dark:text-[#06131f]">{initials(p.name)}</span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-xl font-bold tracking-tight text-ink">{p.name}</h1>
                <Badge tone="warn">SYNTHETIC PATIENT</Badge>
                <Badge tone="primary">
                  <BedDouble className="size-3" aria-hidden /> {p.room}
                </Badge>
              </div>
              <p className="tnum mt-1 text-sm text-muted">
                {p.mrn} · {p.age} y · {p.sex} · {p.wardName}
              </p>
              <p className="mt-1 text-sm font-medium text-ink">{p.condition}</p>
              <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span className="inline-flex items-center gap-1"><ClipboardList className="size-3.5" /> {p.pathway}</span>
                <span className="inline-flex items-center gap-1"><CalendarClock className="size-3.5" /> Admitted {dateTime(p.admittedAt)}</span>
                <span className="inline-flex items-center gap-1"><Stethoscope className="size-3.5" /> {p.doctor?.name ?? "Unassigned"}</span>
                <span className="inline-flex items-center gap-1"><Syringe className="size-3.5" /> {p.nurse?.name ?? "Unassigned"}</span>
                <span className="inline-flex items-center gap-1"><MessageSquare className="size-3.5" /> Last contact {timeAgo(p.lastContactAt, v.now)}</span>
                <span className="inline-flex items-center gap-1"><Radio className="size-3.5" /> Last reading {timeAgo(p.lastReadingAt, v.now)}</span>
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-start gap-2 lg:items-end">
            <StatePill state={v.state} />
            <p className="max-w-xs text-xs text-muted lg:text-right">{v.stateReason}</p>
            <div className="mt-1 flex flex-wrap gap-1.5 lg:justify-end">
              {role === "DOCTOR" && p.awaitingAssessment && (
                <Button size="sm" variant="primary" onClick={() => setNoteOpen("ASSESSMENT")}>
                  <ClipboardCheck className="size-3.5" /> Record assessment
                </Button>
              )}
              {role === "NURSE" && (
                <Button size="sm" onClick={() => setNoteOpen("CHECKIN")}>
                  <ClipboardCheck className="size-3.5" /> Record check-in
                </Button>
              )}
              {!v.transfer?.open && (
                <Button size="sm" variant="danger" onClick={() => setTransferOpen(true)}>
                  <Ambulance className="size-3.5" /> Emergency transfer
                </Button>
              )}
              <Button size="sm" onClick={() => setNoteOpen("NOTE")}>
                <NotebookPen className="size-3.5" /> Add note
              </Button>
              <Button size="sm" busy={consult.busy} onClick={openConsult?.status === "IN_PROGRESS" ? () => setRoom(true) : startConsult}>
                <Video className="size-3.5" /> {openConsult?.status === "IN_PROGRESS" ? "Rejoin consultation" : "Start consultation"}
              </Button>
            </div>
            <ErrorNote>{consult.error}</ErrorNote>
          </div>
        </div>
      </Card>

      {error && <p className="rounded-xl bg-warn-soft px-4 py-2 text-xs font-medium text-warn">Connection problem — showing the last data received ({error.message})</p>}
      {stale && (
        <div className="flex items-start gap-3 rounded-2xl border border-line bg-neutral-soft px-4 py-3">
          <CircleAlert className="mt-0.5 size-5 shrink-0 text-muted" aria-hidden />
          <div>
            <p className="text-sm font-semibold text-ink">No current data — this patient is not shown as stable</p>
            <p className="text-xs leading-relaxed text-muted">
              {v.stateReason}. Values below were last received {p.lastReadingAt ? `at ${clock(p.lastReadingAt, true)} (${timeAgo(p.lastReadingAt, v.now)})` : "— never"} and do not describe the patient&apos;s present condition.
            </p>
          </div>
        </div>
      )}
      {!v.sim.running && !stale && (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-line bg-surface px-4 py-2 text-xs text-muted">
          <CircleAlert className="size-4 shrink-0 text-warn" aria-hidden /> Simulator paused — readings are frozen at {clock(v.sim.pausedAt, true)}. Start it from the virtual ward to stream live data.
        </p>
      )}
      {openConsult?.status === "REQUESTED" && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-info/40 bg-info-soft px-4 py-3">
          <Video className="size-5 shrink-0 text-info" aria-hidden />
          <p className="min-w-0 flex-1 text-sm text-ink">
            <b className="font-semibold">Consultation requested</b> by {openConsult.requestedBy} {timeAgo(openConsult.createdAt, v.now)}
            {openConsult.reason ? ` — “${openConsult.reason}”` : ""}
          </p>
          <Button size="sm" variant="primary" busy={consult.busy} onClick={startConsult}>
            Start now
          </Button>
        </div>
      )}

      {v.transfer && <TransferPanel t={v.transfer} patientId={p.id} now={v.now} onChange={refresh} />}
      <TransferRequestDialog patientId={p.id} patientName={p.name} open={transferOpen} onClose={() => setTransferOpen(false)} onDone={refresh} />

      <VitalTiles v={v} />
      {v.activity && Object.keys(v.activity).length > 0 && <ActivityStrip activity={v.activity} now={v.now} />}

      <Tabs<TabId>
        value={tab}
        onChange={setTab}
        items={[
          { id: "overview", label: "Overview", count: active.length },
          { id: "trends", label: "Trends" },
          { id: "care", label: "Care plan & tasks" },
          { id: "notes", label: "Notes & messages" },
          { id: "devices", label: "Devices & limits" },
          { id: "timeline", label: "Activity timeline" },
        ]}
      />

      {tab === "overview" && (
        <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
          <div className="min-w-0 space-y-4">
            <EcgCard v={v} refresh={refresh} />
            <Card>
              <CardHeader icon={<Activity className="size-4" />} title="Key trends" subtitle="Dashed lines are this patient's configured limits. Gaps mean no data was received." action={WindowPicker} />
              <div className="grid gap-4 px-5 pb-5 md:grid-cols-2">
                {(["SPO2", "HR"] as VitalType[]).filter((t) => v.latest[t]).map((t) => (
                  <div key={t}>
                    <p className="mb-1 text-xs font-semibold text-ink">
                      {VITALS[t].label} <span className="font-normal text-muted">({VITALS[t].unit})</span>
                    </p>
                    <VitalChart type={t} points={v.series[t] ?? []} limits={v.limits} height={190} />
                  </div>
                ))}
              </div>
            </Card>
          </div>
          <div className="min-w-0 space-y-4">
            <Card>
              <CardHeader icon={<BellRing className="size-4" />} title="Alerts" subtitle={`${active.length} active · ${v.alerts.length - active.length} resolved`} />
              <div className="max-h-[440px] overflow-y-auto px-4 pb-4">
                <AlertList alerts={v.alerts.slice(0, 12)} role={role} now={v.now} onChange={refresh} showPatient={false} empty="No alerts for this patient." />
              </div>
            </Card>
            <SummaryCard v={v} refresh={refresh} />
            <SymptomsCard v={v} refresh={refresh} />
          </div>
        </div>
      )}

      {tab === "trends" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-muted">Reading history with units, limits and data gaps.</p>
            {WindowPicker}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {chartTypes.map((t) => (
              <Card key={t}>
                <CardHeader
                  title={
                    <>
                      {VITALS[t].label} <span className="font-normal text-muted">({VITALS[t].unit})</span>
                    </>
                  }
                  subtitle={v.latest[t] ? `Latest ${formatVital(t, v.latest[t]!.v, v.latest[t]!.v2)} ${VITALS[t].unit} · ${timeAgo(v.latest[t]!.t, v.now)} · ${SOURCE_LABEL[v.latest[t]!.src] ?? v.latest[t]!.src}` : undefined}
                  action={<span className="tnum text-[11px] text-muted">{v.series[t]?.length ?? 0} readings</span>}
                />
                <div className="px-4 pb-4">
                  <VitalChart type={t} points={v.series[t] ?? []} limits={v.limits} />
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {tab === "care" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader icon={<FileText className="size-4" />} title="Care plan" subtitle={p.pathway} />
            <ul className="space-y-2 px-5 pb-5">
              {p.carePlan.map((c, i) => (
                <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-ink">
                  <span className="mt-2 size-1.5 shrink-0 rounded-full bg-teal" aria-hidden /> {c}
                </li>
              ))}
            </ul>
          </Card>
          <Card>
            <CardHeader icon={<ListChecks className="size-4" />} title="Tasks & follow-up" subtitle={`${v.tasks.filter((t) => t.status === "OPEN").length} open`} />
            <div className="px-5 pb-5">
              <TaskList tasks={v.tasks} role={role} now={v.now} onChange={refresh} />
              <TaskComposer v={v} refresh={refresh} />
            </div>
          </Card>
          <Card>
            <CardHeader icon={<Pill className="size-4" />} title="Medications" subtitle="Reminder and adherence tracking" />
            <div className="px-5 pb-5">
              <MedicationList patientId={p.id} meds={v.medications} canLog={role === "NURSE"} now={v.now} onChange={refresh} />
            </div>
          </Card>
          <Card>
            <CardHeader icon={<Video className="size-4" />} title="Consultations" />
            <div className="px-5 pb-5">
              {v.consults.length === 0 ? (
                <Empty>No consultations yet.</Empty>
              ) : (
                <ul className="divide-y divide-line">
                  {v.consults.map((c) => (
                    <li key={c.id} className="flex items-center gap-3 py-2.5 text-sm">
                      <Badge tone={c.status === "COMPLETED" ? "ok" : c.status === "IN_PROGRESS" ? "teal" : "info"}>{humanise(c.status)}</Badge>
                      <span className="min-w-0 flex-1 text-ink">
                        {c.requestedBy}
                        {c.reason ? <span className="text-muted"> — {c.reason}</span> : null}
                      </span>
                      <span className="tnum text-[11px] text-muted">{dateTime(c.createdAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      )}

      {tab === "notes" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader icon={<NotebookPen className="size-4" />} title="Clinical notes" subtitle={`${v.notes.length} entries`} />
            <div className="px-5 pb-5">
              <NoteComposer v={v} refresh={refresh} />
              <ul className="mt-4 space-y-2.5">
                {v.notes.map((n) => (
                  <li key={n.id} className="rounded-xl border border-line p-3">
                    <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
                      <Badge tone={NOTE_KIND[n.kind]?.tone ?? "muted"}>{NOTE_KIND[n.kind]?.label ?? n.kind}</Badge>
                      <span className="font-semibold text-ink">{n.authorName}</span>
                      <span className="tnum ml-auto">{dateTime(n.createdAt)}</span>
                    </p>
                    <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">{n.body}</p>
                  </li>
                ))}
              </ul>
            </div>
          </Card>
          <Card className="h-fit">
            <CardHeader icon={<MessageSquare className="size-4" />} title="Secure messages" subtitle={`With ${p.name} and authorised caregivers`} />
            <div className="px-5 pb-5">
              <MessageThread patientId={p.id} messages={v.messages} meId={v.me.id} onSent={refresh} height={420} />
            </div>
          </Card>
        </div>
      )}

      {tab === "devices" && (
        <div className="space-y-4">
          <Card>
            <CardHeader icon={<Radio className="size-4" />} title="Monitoring devices" subtitle="Device adapters — simulated data is always labelled" />
            <div className="px-5 pb-5">
              <DevicePanel patientId={p.id} devices={v.devices} canManage now={v.now} onChange={refresh} />
            </div>
          </Card>
          <Card>
            <CardHeader icon={<Router className="size-4" />} title="Home hub — automatic uploads" subtitle="Medical devices upload by themselves; no patient data entry" />
            <div className="px-5 pb-5">
              <HubPanel patientId={p.id} devices={v.devices} manualEntry={!!p.manualEntry} now={v.now} onChange={refresh} />
            </div>
          </Card>
          <Card>
            <CardHeader icon={<Watch className="size-4" />} title="Smartwatch & phone" subtitle="Patient-owned consumer devices synced from Apple Health / Health Connect" />
            <div className="px-5 pb-5">
              <WearablePanel patientId={p.id} devices={v.devices} canManage now={v.now} onChange={refresh} />
            </div>
          </Card>
          <LimitsCard v={v} refresh={refresh} />
        </div>
      )}

      {tab === "timeline" && (
        <Card>
          <CardHeader icon={<History className="size-4" />} title="Clinical activity timeline" subtitle="Every alert, action and record access for this patient (most recent first)" />
          <div className="px-5 pb-5">
            {v.timeline.length === 0 ? (
              <Empty>No activity recorded yet.</Empty>
            ) : (
              <ol className="relative ml-2 space-y-3 border-l border-line pl-5">
                {v.timeline.map((t) => (
                  <li key={t.id} className="relative">
                    <span className={clsx("absolute -left-[25px] top-1.5 size-2.5 rounded-full ring-4 ring-surface", t.action.startsWith("ALERT_RAISED") || t.action === "ALERT_UPGRADED" ? "bg-warn" : t.role === "SYSTEM" ? "bg-muted" : "bg-primary")} aria-hidden />
                    <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span className="font-semibold text-ink">{humanise(t.action)}</span>
                      <span className="text-xs text-muted">
                        {t.who}
                        {t.role !== "SYSTEM" ? ` · ${ROLE_LABEL[t.role as Role] ?? t.role}` : ""}
                      </span>
                      <span className="tnum ml-auto text-[11px] text-muted">{dateTime(t.at)}</span>
                    </p>
                    {t.detail && <p className="text-xs leading-relaxed text-muted">{t.detail}</p>}
                  </li>
                ))}
              </ol>
            )}
          </div>
        </Card>
      )}

      <Modal open={!!noteOpen} onClose={() => setNoteOpen(null)} title={noteOpen === "ASSESSMENT" ? "Record admission assessment" : noteOpen === "CHECKIN" ? "Record patient check-in" : "Add to clinical record"}>
        {noteOpen && <NoteComposer key={noteOpen} v={v} refresh={refresh} preset={noteOpen} onDone={() => setNoteOpen(null)} />}
      </Modal>
      <ConsultRoom open={room} onClose={() => setRoom(false)} title={`Consultation · ${p.name}`} onEnd={endConsult} />
    </div>
  );
}
