"use client";
// Widgets shared by the clinician bedside view and the patient / caregiver apps.
import clsx from "clsx";
import { Bluetooth, Check, CircleCheck, Cloud, Cpu, Mic, MicOff, Pill, PlugZap, Send, Unplug, Video, VideoOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, clock, dateTime, timeAgo, useAction } from "@/lib/client";
import { checkBluetooth } from "@/lib/devices";
import { ROLE_LABEL, VITALS, type Role, type VitalType } from "@/lib/types";
import { Badge, Button, Empty, ErrorNote, Field, Input, Modal, Select, SimBadge, Textarea } from "./ui";

// ------------------------------------------------------------------ messages
export type MessageDto = { id: string; senderId: string; senderName: string; senderRole: string; body: string; createdAt: string };

export function MessageThread({ patientId, messages, meId, onSent, height = 320 }: { patientId: string; messages: MessageDto[]; meId: string; onSent: () => void; height?: number }) {
  const [text, setText] = useState("");
  const { busy, error, run } = useAction();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [messages.length]);
  const send = () => text.trim() && run(async () => (await api(`/api/patients/${patientId}/messages`, { body: { body: text.trim() } }), setText(""), onSent()));
  return (
    <div>
      <div ref={box} style={{ maxHeight: height }} className="space-y-2.5 overflow-y-auto pr-1">
        {messages.length === 0 && <Empty>No messages yet</Empty>}
        {messages.map((m) => {
          const mine = m.senderId === meId;
          return (
            <div key={m.id} className={clsx("flex", mine ? "justify-end" : "justify-start")}>
              <div className={clsx("max-w-[85%] rounded-2xl px-3.5 py-2", mine ? "rounded-br-md bg-primary text-white dark:text-[#06131f]" : "rounded-bl-md bg-neutral-soft text-ink")}>
                {!mine && (
                  <p className="text-[11px] font-semibold opacity-80">
                    {m.senderName} · {ROLE_LABEL[m.senderRole as Role] ?? m.senderRole}
                  </p>
                )}
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{m.body}</p>
                <p className={clsx("mt-0.5 text-right text-[10px]", mine ? "opacity-75" : "text-muted")}>{dateTime(m.createdAt)}</p>
              </div>
            </div>
          );
        })}
      </div>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a secure message…" aria-label="Message" maxLength={1500} />
        <Button type="submit" variant="primary" busy={busy} disabled={!text.trim()} aria-label="Send message">
          <Send className="size-3.5" /> Send
        </Button>
      </form>
      <ErrorNote className="mt-2">{error}</ErrorNote>
    </div>
  );
}

// ------------------------------------------------------------------ tasks
export type TaskDto = { id: string; title: string; assigneeRole: string; status: string; dueAt: string | null; createdByName: string; completedAt: string | null; completedBy: string | null };

export function TaskList({ tasks, role, now, onChange, empty = "No tasks" }: { tasks: TaskDto[]; role: Role; now?: string; onChange: () => void; empty?: string }) {
  const { busy, error, run } = useAction();
  if (tasks.length === 0) return <Empty>{empty}</Empty>;
  const canDo = (t: TaskDto) => role === "DOCTOR" || role === "NURSE" || t.assigneeRole === role;
  return (
    <div>
      <ul className="divide-y divide-line">
        {tasks.map((t) => {
          const overdue = t.status === "OPEN" && t.dueAt && new Date(t.dueAt) < new Date(now ?? Date.now());
          return (
            <li key={t.id} className="flex items-start gap-3 py-2.5">
              {t.status === "DONE" ? (
                <CircleCheck className="mt-0.5 size-5 shrink-0 text-ok" aria-label="Completed" />
              ) : (
                <button
                  type="button"
                  disabled={busy || !canDo(t)}
                  onClick={() => run(async () => (await api(`/api/tasks/${t.id}`, { method: "PATCH", body: {} }), onChange()))}
                  title={canDo(t) ? "Mark as done" : `Assigned to the ${t.assigneeRole.toLowerCase()}`}
                  aria-label={`Mark "${t.title}" as done`}
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-line text-transparent hover:border-ok hover:text-ok disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Check className="size-3" />
                </button>
              )}
              <div className="min-w-0 flex-1">
                <p className={clsx("text-sm leading-snug", t.status === "DONE" ? "text-muted line-through" : "font-medium text-ink")}>{t.title}</p>
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-muted">
                  <Badge tone="muted">{ROLE_LABEL[t.assigneeRole as Role] ?? t.assigneeRole}</Badge>
                  {t.status === "DONE" ? (
                    <span>
                      Done {clock(t.completedAt)} by {t.completedBy}
                    </span>
                  ) : t.dueAt ? (
                    <span className={clsx(overdue && "font-semibold text-crit")}>
                      {overdue ? "Overdue · " : "Due "} {timeAgo(t.dueAt, now)}
                    </span>
                  ) : null}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorNote className="mt-2">{error}</ErrorNote>
    </div>
  );
}

// ------------------------------------------------------------------ medications
export type MedDto = { id: string; name: string; dose: string; schedule: string; lastTakenAt: string | null; lastRecordedBy: string | null };

export function MedicationList({ patientId, meds, canLog, now, onChange }: { patientId: string; meds: MedDto[]; canLog: boolean; now?: string; onChange: () => void }) {
  const { busy, error, run } = useAction();
  if (meds.length === 0) return <Empty>No medications on the care plan</Empty>;
  return (
    <div>
      <ul className="divide-y divide-line">
        {meds.map((m) => (
          <li key={m.id} className="flex items-center gap-3 py-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
              <Pill className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">
                {m.name} <span className="font-normal text-muted">· {m.dose}</span>
              </p>
              <p className="text-[11px] text-muted">
                {m.schedule} · {m.lastTakenAt ? `last recorded ${timeAgo(m.lastTakenAt, now)} by ${m.lastRecordedBy}` : "no dose recorded yet"}
              </p>
            </div>
            {canLog && (
              <Button size="sm" disabled={busy} onClick={() => run(async () => (await api(`/api/patients/${patientId}/medlog`, { body: { medicationId: m.id } }), onChange()))}>
                <Check className="size-3.5" /> Taken
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-muted">Reminder tracking only — doses are set by the care team, never by this app.</p>
      <ErrorNote className="mt-2">{error}</ErrorNote>
    </div>
  );
}

// ------------------------------------------------------------------ manual readings
const FORM_VITALS: { type: VitalType; label: string; placeholder: string; step: string }[] = [
  { type: "HR", label: "Pulse (bpm)", placeholder: "72", step: "1" },
  { type: "SPO2", label: "Oxygen saturation (%)", placeholder: "97", step: "1" },
  { type: "TEMP", label: "Temperature (°C)", placeholder: "36.8", step: "0.1" },
  { type: "GLUCOSE", label: "Blood glucose (mg/dL)", placeholder: "110", step: "1" },
];

export function ReadingForm({ patientId, onDone, withComment }: { patientId: string; onDone: () => void; withComment?: boolean }) {
  const [vals, setVals] = useState<Record<string, string>>({});
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const set = (k: string, v: string) => (setSent(null), setVals((s) => ({ ...s, [k]: v })));
  const num = (k: string) => (vals[k]?.trim() ? Number(vals[k]) : null);

  const submit = () =>
    run(async () => {
      const readings: { type: string; value: number; value2?: number }[] = [];
      for (const f of FORM_VITALS) {
        const v = num(f.type);
        if (v != null) readings.push({ type: f.type, value: v });
      }
      const sys = num("SYS");
      const dia = num("DIA");
      if (sys != null || dia != null) {
        if (sys == null || dia == null) throw new Error("Enter both blood-pressure numbers (top and bottom).");
        readings.push({ type: "BP", value: sys, value2: dia });
      }
      if (readings.some((r) => Number.isNaN(r.value))) throw new Error("Readings must be numbers.");
      if (readings.length === 0) throw new Error("Enter at least one reading.");
      const res = await api(`/api/patients/${patientId}/readings`, { body: { readings, ...(comment.trim() ? { comment: comment.trim() } : {}) } });
      setVals({});
      setComment("");
      setSent(res.alertsRaised > 0 ? "Sent. One or more readings are outside your care team's limits — they have been notified and will review." : "Sent to your care team. Thank you.");
      onDone();
    });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Blood pressure — top (mmHg)">
          <Input inputMode="numeric" type="number" placeholder="120" value={vals.SYS ?? ""} onChange={(e) => set("SYS", e.target.value)} />
        </Field>
        <Field label="Blood pressure — bottom (mmHg)">
          <Input inputMode="numeric" type="number" placeholder="80" value={vals.DIA ?? ""} onChange={(e) => set("DIA", e.target.value)} />
        </Field>
        {FORM_VITALS.map((f) => (
          <Field key={f.type} label={f.label}>
            <Input inputMode="decimal" type="number" step={f.step} placeholder={f.placeholder} value={vals[f.type] ?? ""} onChange={(e) => set(f.type, e.target.value)} />
          </Field>
        ))}
      </div>
      {withComment && (
        <Field label="Comment for the care team (optional)" className="mt-3">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={500} placeholder="e.g. taken after a short rest" />
        </Field>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" busy={busy}>
          Send readings
        </Button>
        <span className="text-[11px] text-muted">Fill in only what you measured. Saved as {withComment ? "caregiver" : "patient"}-reported.</span>
      </div>
      <ErrorNote className="mt-2">{error}</ErrorNote>
      {sent && <p className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-xs font-medium text-ok">{sent}</p>}
    </form>
  );
}

export function SymptomForm({ patientId, onDone }: { patientId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState("MODERATE");
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => (await api(`/api/patients/${patientId}/symptoms`, { body: { text: text.trim(), severity } }), setText(""), setSent(true), onDone()));
      }}
    >
      <Field label="How are you feeling? Describe any new or changed symptom">
        <Textarea value={text} onChange={(e) => (setSent(false), setText(e.target.value))} placeholder="e.g. More breathless than usual when climbing the stairs" maxLength={600} />
      </Field>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <Field label="How strong is it?" className="w-40">
          <Select value={severity} onChange={(e) => setSeverity(e.target.value)}>
            <option value="MILD">Mild</option>
            <option value="MODERATE">Moderate</option>
            <option value="SEVERE">Severe</option>
          </Select>
        </Field>
        <Button type="submit" variant="primary" busy={busy} disabled={text.trim().length < 3}>
          Tell my care team
        </Button>
      </div>
      <ErrorNote className="mt-2">{error}</ErrorNote>
      {sent && <p className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-xs font-medium text-ok">Your care team has received this and will review it.</p>}
    </form>
  );
}

// ------------------------------------------------------------------ devices
export type DeviceDto = { id: string; name: string; deviceType: string; adapter: string; status: string; streaming: boolean; battery: number; lastSeenAt: string | null };
const DEVICE_LABEL: Record<string, string> = { WEARABLE_PATCH: "Wearable ECG / vitals patch", PULSE_OXIMETER: "Pulse oximeter", BP_MONITOR: "Blood pressure monitor", THERMOMETER: "Thermometer", GLUCOMETER: "Glucose meter", SCALE: "Weight scale" };

export function DevicePanel({ patientId, devices, canManage, now, onChange }: { patientId: string; devices: DeviceDto[]; canManage: boolean; now?: string; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const [bt, setBt] = useState<string | null>(null);
  const setStatus = (deviceId: string, status: string) => run(async () => (await api(`/api/patients/${patientId}/device`, { body: { deviceId, status } }), onChange()));
  return (
    <div>
      <ul className="space-y-2">
        {devices.map((d) => {
          const up = d.status === "CONNECTED";
          return (
            <li key={d.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
              <span className={clsx("flex size-9 shrink-0 items-center justify-center rounded-lg", !d.streaming ? "bg-neutral-soft text-muted" : up ? "bg-teal-soft text-teal" : "bg-crit-soft text-crit")}>
                {d.streaming ? up ? <PlugZap className="size-4" /> : <Unplug className="size-4" /> : <Cpu className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-ink">
                  {d.name} {d.adapter === "SIMULATED" && <SimBadge />}
                </p>
                <p className="text-[11px] text-muted">
                  {DEVICE_LABEL[d.deviceType] ?? d.deviceType} ·{" "}
                  {d.streaming ? (up ? `transmitting · last seen ${timeAgo(d.lastSeenAt, now)}` : `disconnected · last seen ${timeAgo(d.lastSeenAt, now)}`) : "manual entry — readings are typed in at each check-in"}
                  {d.streaming && ` · battery ${d.battery}%`}
                </p>
              </div>
              {d.streaming && (up ? <Badge tone="teal">Connected</Badge> : <Badge tone="crit">Disconnected</Badge>)}
              {canManage && d.streaming && (
                <Button size="sm" disabled={busy} variant={up ? "secondary" : "teal"} onClick={() => setStatus(d.id, up ? "DISCONNECTED" : "CONNECTED")}>
                  {up ? "Disconnect" : "Reconnect"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <ErrorNote className="mt-2">{error}</ErrorNote>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        <div className="rounded-xl border border-line p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Cpu className="size-3.5 text-teal" /> Simulated adapter
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">Fully working. Produces labelled synthetic readings for this demo.</p>
          <Badge tone="teal" className="mt-2">Operational</Badge>
        </div>
        <div className="rounded-xl border border-line p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Bluetooth className="size-3.5 text-primary" /> Bluetooth adapter
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">Capability check and integration scaffold only. Not validated against a physical device.</p>
          <Button size="sm" className="mt-2" onClick={async () => setBt(await checkBluetooth())}>
            Check this browser
          </Button>
          {bt && <p className="mt-2 text-[11px] font-medium text-ink">{bt}</p>}
        </div>
        <div className="rounded-xl border border-line p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-ink">
            <Cloud className="size-3.5 text-primary" /> Vendor API adapter
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">Documented interface for future vendor clouds (e.g. via an authorised companion app). Not connected.</p>
          <Badge tone="muted" className="mt-2">Planned</Badge>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ consultation room
/**
 * Demo consultation room. Shows the local camera/microphone preview only; a peer-to-peer
 * media connection between patient and clinician is NOT part of this MVP.
 */
export function ConsultRoom({ open, onClose, title, onEnd }: { open: boolean; onClose: () => void; title: string; onEnd?: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"idle" | "live" | "unavailable">("idle");
  const [cam, setCam] = useState(true);
  const [mic, setMic] = useState(true);
  const [started] = useState(() => Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const iv = setInterval(() => tick((x) => x + 1), 1000);
    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error("unsupported");
        const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        if (video.current) video.current.srcObject = s;
        setState("live");
      } catch {
        if (!cancelled) setState("unavailable");
      }
    })();
    return () => {
      cancelled = true;
      clearInterval(iv);
      stream.current?.getTracks().forEach((t) => t.stop());
      stream.current = null;
      setState("idle");
    };
  }, [open]);

  const toggle = (kind: "video" | "audio") => {
    const on = kind === "video" ? !cam : !mic;
    (kind === "video" ? stream.current?.getVideoTracks() : stream.current?.getAudioTracks())?.forEach((t) => (t.enabled = on));
    if (kind === "video") setCam(on);
    else setMic(on);
  };
  const secs = Math.floor((Date.now() - started) / 1000);

  return (
    <Modal open={open} onClose={onClose} title={title} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="relative aspect-video overflow-hidden rounded-xl bg-[#06131f]">
          <video ref={video} autoPlay muted playsInline className={clsx("h-full w-full object-cover", (!cam || state !== "live") && "hidden")} />
          {(state !== "live" || !cam) && (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-slate-300">
              <VideoOff className="size-6" />
              <p className="text-xs">{state === "unavailable" ? "Camera or microphone unavailable or not permitted in this browser. You can continue by phone and record notes." : state === "idle" ? "Requesting camera…" : "Camera off"}</p>
            </div>
          )}
          <span className="absolute bottom-2 left-2 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-white">You (local preview)</span>
        </div>
        <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line bg-surface-2 px-4 text-center">
          <Video className="size-6 text-muted" />
          <p className="text-sm font-semibold text-ink">Remote participant</p>
          <p className="text-[11px] leading-relaxed text-muted">Not connected in this MVP. This room demonstrates the consultation workflow and your local camera preview; live two-way video is on the roadmap.</p>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={() => toggle("audio")} disabled={state !== "live"} aria-pressed={!mic}>
          {mic ? <Mic className="size-3.5" /> : <MicOff className="size-3.5" />} {mic ? "Mute" : "Unmute"}
        </Button>
        <Button onClick={() => toggle("video")} disabled={state !== "live"} aria-pressed={!cam}>
          {cam ? <Video className="size-3.5" /> : <VideoOff className="size-3.5" />} {cam ? "Stop camera" : "Start camera"}
        </Button>
        <span className="tnum text-xs text-muted">
          {String(Math.floor(secs / 60)).padStart(2, "0")}:{String(secs % 60).padStart(2, "0")}
        </span>
        <Button variant="danger" className="ml-auto" onClick={() => (onEnd?.(), onClose())}>
          {onEnd ? "End consultation" : "Leave room"}
        </Button>
      </div>
    </Modal>
  );
}

export function vitalLabel(type: VitalType) {
  return `${VITALS[type].label} (${VITALS[type].unit})`;
}
