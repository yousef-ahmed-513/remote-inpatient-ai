"use client";
// Widgets shared by the clinician bedside view and the patient / caregiver apps.
import clsx from "clsx";
import { Bluetooth, Check, CircleCheck, Router, Copy, Cpu, Footprints, HeartPulse, KeyRound, Link2, Mic, MicOff, Moon, Phone, Pill, PlugZap, Send, Siren, Smartphone, Unplug, Video, VideoOff, Watch } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, clock, dateTime, timeAgo, useAction } from "@/lib/client";
import { checkBluetooth } from "@/lib/devices";
import { ACTIVITY, ACTIVITY_ORDER, RED_FLAG_ORDER, RED_FLAGS, ROLE_LABEL, type RedFlag, SOURCE_LABEL, SYNTHETIC_SOURCES, VITALS, WEARABLE_PLATFORMS, type ActivitySummary, type ActivityType, type Role, type VitalType, type WearablePlatform } from "@/lib/types";
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

type RedFlagResult = { redFlags: { flag: RedFlag; label: string; advice: string }[]; emergencyNumber: string };

/** Shown the moment a red-flag symptom is submitted — straight from the deterministic rules, no AI. */
export function EmergencyInstructions({ result, onClose }: { result: RedFlagResult; onClose?: () => void }) {
  return (
    <div role="alert" className="mt-3 rounded-xl border-2 border-crit bg-crit-soft p-4">
      <p className="flex items-center gap-2 text-base font-bold text-crit">
        <Siren className="size-5 shrink-0" /> This could be an emergency — call {result.emergencyNumber} now
      </p>
      <p className="mt-1 text-sm text-ink">
        You reported: <b>{result.redFlags.map((f) => f.label).join("; ")}</b>. Your care team has also been alerted, but do not wait for them to call back.
      </p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink">
        {result.redFlags.map((f) => (
          <li key={f.flag}>{f.advice}</li>
        ))}
        <li>Unlock the door and keep your phone with you.</li>
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <a href={`tel:${result.emergencyNumber}`} className="inline-flex h-10 items-center gap-2 rounded-lg bg-crit px-4 text-sm font-semibold text-white dark:text-[#06131f]">
          <Phone className="size-4" /> Call {result.emergencyNumber}
        </a>
        {onClose && (
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        )}
      </div>
    </div>
  );
}

export function SymptomForm({ patientId, onDone }: { patientId: string; onDone: () => void }) {
  const [text, setText] = useState("");
  const [severity, setSeverity] = useState("MODERATE");
  const [flags, setFlags] = useState<RedFlag[]>([]);
  const [sent, setSent] = useState(false);
  const [emergency, setEmergency] = useState<RedFlagResult | null>(null);
  const { busy, error, run } = useAction();
  const toggle = (f: RedFlag) => setFlags((x) => (x.includes(f) ? x.filter((y) => y !== f) : [...x, f]));
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          const r = await api<RedFlagResult>(`/api/patients/${patientId}/symptoms`, { body: { text: text.trim() || flags.map((f) => RED_FLAGS[f].label).join("; "), severity, redFlags: flags } });
          setEmergency(r.redFlags.length ? r : null);
          setText("");
          setFlags([]);
          setSent(true);
          onDone();
        });
      }}
    >
      <fieldset className="mb-3 rounded-xl border border-crit/30 p-3">
        <legend className="px-1 text-xs font-semibold text-crit">Any of these right now?</legend>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {RED_FLAG_ORDER.map((f) => (
            <label key={f} className={clsx("flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 text-[13px]", flags.includes(f) ? "bg-crit-soft text-crit" : "text-ink hover:bg-surface-2")}>
              <input type="checkbox" className="mt-0.5" checked={flags.includes(f)} onChange={() => (setSent(false), toggle(f))} />
              {RED_FLAGS[f].label}
            </label>
          ))}
        </div>
      </fieldset>
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
        <Button type="submit" variant={flags.length ? "danger" : "primary"} busy={busy} disabled={text.trim().length < 3 && flags.length === 0}>
          {flags.length ? "Send — this is urgent" : "Tell my care team"}
        </Button>
      </div>
      <ErrorNote className="mt-2">{error}</ErrorNote>
      {emergency ? <EmergencyInstructions result={emergency} onClose={() => setEmergency(null)} /> : sent && <p className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-xs font-medium text-ok">Your care team has received this and will review it.</p>}
    </form>
  );
}

// ------------------------------------------------------------------ devices
export type DeviceDto = { id: string; name: string; deviceType: string; adapter: string; status: string; streaming: boolean; battery: number; lastSeenAt: string | null; platform?: string | null; tokenHint?: string | null; syncCount?: number; createdAt?: string; serial?: string | null; hubId?: string | null };
const DEVICE_LABEL: Record<string, string> = { WEARABLE_PATCH: "Wearable ECG / vitals patch", PULSE_OXIMETER: "Pulse oximeter", BP_MONITOR: "Blood pressure monitor", THERMOMETER: "Thermometer", GLUCOMETER: "Glucose meter", SCALE: "Weight scale" };

export function DevicePanel({ patientId, devices, canManage, now, onChange }: { patientId: string; devices: DeviceDto[]; canManage: boolean; now?: string; onChange: () => void }) {
  const { busy, error, run } = useAction();
  const [bt, setBt] = useState<string | null>(null);
  const setStatus = (deviceId: string, status: string) => run(async () => (await api(`/api/patients/${patientId}/device`, { body: { deviceId, status } }), onChange()));
  return (
    <div>
      <ul className="space-y-2">
        {devices.filter((d) => d.adapter !== "WEARABLE_SYNC" && d.deviceType !== "HOME_HUB").map((d) => {
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
                  {d.streaming ? (up ? `transmitting · last seen ${timeAgo(d.lastSeenAt, now)}` : `disconnected · last seen ${timeAgo(d.lastSeenAt, now)}`) : d.hubId ? `uploads automatically via the home hub when used · last upload ${timeAgo(d.lastSeenAt, now)}` : `spot-check device · last reading ${timeAgo(d.lastSeenAt, now)}`}
                  {d.serial && ` · S/N ${d.serial}`}
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
            <Watch className="size-3.5 text-primary" /> Smartwatch &amp; phone sync
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">Apple Health / Health Connect data pushed from the patient&apos;s phone with a per-device token. Consumer-grade, always labelled.</p>
          <Badge tone="teal" className="mt-2">Working</Badge>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ home hub (automatic device uploads)
/** Clinician panel: provision the home hub, see paired devices, demo upload, manual-entry fallback. */
export function HubPanel({ patientId, devices, manualEntry, now, onChange }: { patientId: string; devices: DeviceDto[]; manualEntry: boolean; now?: string; onChange: () => void }) {
  const hub = devices.find((d) => d.deviceType === "HOME_HUB" && d.status === "CONNECTED");
  const paired = hub ? devices.filter((d) => d.hubId === hub.id) : [];
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [serial, setSerial] = useState("");
  const [issued, setIssued] = useState<{ token: string; url: string } | null>(null);
  const [scenario, setScenario] = useState("NORMAL");
  const [result, setResult] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const post = (action: string, body: unknown) => api(`/api/patients/${patientId}/${action}`, { body });
  const register = () =>
    run(async () => {
      const r = await post("hub-register", { name: name.trim() || undefined, serial: serial.trim() || undefined });
      setIssued({ token: r.token, url: `${window.location.origin}${r.ingestPath}` });
      onChange();
    });
  const demo = () =>
    run(async () => {
      const r = await post("hub-demo", { scenario });
      setResult(`Hub upload processed: ${r.accepted} readings stored (${Object.entries(r.byType as Record<string, number>).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}), ${r.duplicates} duplicates${r.scheduledMeasurementMet ? ", scheduled measurement received" : ""}${r.alertsRaised ? `, ${r.alertsRaised} alert(s)` : ""}.`);
      onChange();
    });
  const example = issued
    ? `curl -X POST ${issued.url} -H "Authorization: Bearer ${issued.token}" -H "content-type: application/fhir+json" -d '{"resourceType":"Observation","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"59408-5"}]},"valueQuantity":{"value":97,"unit":"%","code":"%"},"effectiveDateTime":"${new Date().toISOString()}","device":{"identifier":{"value":"${paired[0]?.serial ?? "OXR-0001-1"}"}}}'`
    : "";
  return (
    <div className="space-y-3">
      <p className="text-[12px] leading-relaxed text-muted">The nurse pairs the patient&apos;s medical devices with a cellular home hub at admission. Readings then upload automatically as soon as a device is used — the patient never types numbers.</p>
      {hub ? (
        <div className="rounded-xl border border-line p-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex size-9 items-center justify-center rounded-lg bg-teal-soft text-teal">
              <Router className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-ink">{hub.name}</p>
              <p className="text-[11px] text-muted">
                S/N {hub.serial} · token …{hub.tokenHint} · last upload {timeAgo(hub.lastSeenAt, now)} · {hub.syncCount ?? 0} readings via hub
              </p>
            </div>
            <Badge tone="teal">Active</Badge>
          </div>
          <ul className="mt-2.5 space-y-1 border-t border-line pt-2.5">
            {paired.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2 text-[12px] text-ink">
                <Bluetooth className="size-3.5 text-primary" aria-hidden /> {d.name} <span className="text-muted">· S/N {d.serial ?? "—"} · {d.streaming ? "continuous" : "on use"}</span>
              </li>
            ))}
          </ul>
          <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
            <Select aria-label="Demo upload scenario" className="w-auto text-xs" value={scenario} onChange={(e) => setScenario(e.target.value)}>
              <option value="NORMAL">Demo: normal measurement</option>
              <option value="HIGH">Demo: high glucose + BP</option>
            </Select>
            <Button size="sm" variant="teal" disabled={busy} onClick={demo}>
              Send demo upload
            </Button>
            <SimBadge />
            <span className="flex-1" />
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => run(async () => (await post("hub-revoke", {}), setResult(null), onChange()))}>
              <Unplug className="size-3.5" /> Revoke hub
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line p-3">
          <p className="min-w-0 flex-1 text-[13px] text-ink">No home hub registered — this patient&apos;s readings come from simulated devices only.</p>
          <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
            <Router className="size-3.5" /> Register home hub
          </Button>
        </div>
      )}
      {result && <p className="rounded-lg bg-ok-soft px-3 py-2 text-xs font-medium text-ok">{result}</p>}

      <div className="rounded-xl border border-line p-3">
        <p className="text-xs font-semibold text-ink">Manual entry fallback {manualEntry ? <Badge tone="warn">On</Badge> : <Badge tone="muted">Off</Badge>}</p>
        <p className="mt-1 text-[11px] leading-relaxed text-muted">Off by default: patients and caregivers cannot type readings. Switch on only while a device is faulty; readings are then labelled as patient- or caregiver-reported.</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Input className="min-w-0 flex-1 text-xs" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={manualEntry ? "Reason for switching off (e.g. cuff replaced)" : "Reason (e.g. glucose meter not pairing)"} />
          <Button size="sm" disabled={busy || reason.trim().length < 3} onClick={() => run(async () => (await post("manual-entry", { enabled: !manualEntry, reason }), setReason(""), onChange()))}>
            {manualEntry ? "Switch off" : "Allow manual entry"}
          </Button>
        </div>
      </div>
      <ErrorNote>{!open ? error : null}</ErrorNote>

      <Modal open={open} onClose={() => (setOpen(false), setIssued(null))} title={issued ? "Configure the home hub" : "Register home hub"} wide={!!issued}>
        {!issued ? (
          <div className="space-y-3">
            <Field label="Hub name (optional)">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Home hub" maxLength={80} />
            </Field>
            <Field label="Hub serial number (optional)">
              <Input value={serial} onChange={(e) => setSerial(e.target.value)} placeholder="From the label on the hub" maxLength={40} />
            </Field>
            <p className="text-[11px] text-muted">All of this patient&apos;s medical devices are paired with the hub. Readings are matched by each device&apos;s serial number.</p>
            <ErrorNote>{error}</ErrorNote>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={register}>
                <KeyRound className="size-3.5" /> Register
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn">Shown once — enter it in the hub&apos;s installer app now. Only a fingerprint is stored.</p>
            <CopyField label="Upload URL" value={issued.url} />
            <CopyField label="Hub token" value={issued.token} />
            <CopyField label="Test upload (FHIR Observation)" value={example} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={() => (setOpen(false), setIssued(null))}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Patient / caregiver card: devices upload on their own; manual entry only when the team allows it. */
export function AutoDevicesCard({ patientId, devices, manualEntry, now, onDone, forCaregiver = false }: { patientId: string; devices: DeviceDto[]; manualEntry: boolean; now?: string; onDone: () => void; forCaregiver?: boolean }) {
  const medical = devices.filter((d) => !["WEARABLE_SYNC"].includes(d.adapter) && d.deviceType !== "HOME_HUB" && d.status !== "REVOKED");
  const hub = devices.find((d) => d.deviceType === "HOME_HUB" && d.status === "CONNECTED");
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-2 rounded-xl bg-teal-soft px-3 py-2.5 text-[13px] leading-relaxed text-ink">
        <CircleCheck className="mt-0.5 size-4 shrink-0 text-teal" aria-hidden />
        <span>
          {forCaregiver ? "The devices send readings" : "Your devices send your readings"} to the care team automatically — {forCaregiver ? "nobody needs" : "you don't need"} to type anything.
          {medical.some((d) => !d.streaming) && ` For ${medical.filter((d) => !d.streaming).map((d) => d.name).join(" and ")}, just use the device at the scheduled time.`}
        </span>
      </p>
      <ul className="space-y-1.5">
        {hub && (
          <li className="flex items-center gap-2 text-[12px] text-ink">
            <Router className="size-3.5 text-primary" aria-hidden /> {hub.name} <span className="text-muted">· last upload {timeAgo(hub.lastSeenAt, now)}</span>
          </li>
        )}
        {medical.map((d) => (
          <li key={d.id} className="flex items-center gap-2 text-[12px] text-ink">
            <span className={clsx("size-2 rounded-full", d.status === "CONNECTED" ? "bg-ok" : "bg-crit")} aria-hidden /> {d.name}
            <span className="text-muted">· {d.status === "CONNECTED" ? (d.streaming ? "sending continuously" : `last reading ${timeAgo(d.lastSeenAt, now)}`) : "not connected — tell your care team"}</span>
          </li>
        ))}
      </ul>
      {manualEntry && (
        <div className="rounded-xl border border-warn/40 p-3">
          <p className="mb-2 text-xs font-semibold text-warn">Backup entry — your care team switched this on while a device is not working</p>
          <ReadingForm patientId={patientId} onDone={onDone} withComment={forCaregiver} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ smartwatch / phone sync
const SYNC_OVERDUE_MS = 6 * 3600_000; // display hint; the server rule is WEARABLE_SYNC_STALE_MIN

function CopyField({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1500);
    } catch {
      /* clipboard blocked (e.g. plain-http LAN address) — the value is selectable */
    }
  };
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</p>
      <div className="flex items-stretch gap-1.5">
        <code className={clsx("min-w-0 flex-1 select-all break-all rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-[12px] text-ink", !mono && "font-sans")}>{value}</code>
        <Button size="sm" onClick={copy} aria-label={`Copy ${label}`}>
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function SetupSteps({ platform, url, token }: { platform: WearablePlatform; url: string; token: string }) {
  const sample = JSON.stringify({ samples: [{ type: "HR", value: 72, takenAt: new Date().toISOString(), source: "My watch" }] });
  const curl = `curl -X POST ${url} -H "Authorization: Bearer ${token}" -H "content-type: application/json" -d '${sample}'`;
  const local = /\/\/(localhost|127\.0\.0\.1)/.test(url);
  return (
    <div className="space-y-3 text-[13px] leading-relaxed text-ink">
      {platform === "APPLE_HEALTH" && (
        <ol className="list-decimal space-y-1.5 pl-5">
          <li>
            On the iPhone paired with the Apple Watch, install <b>Health Auto Export – JSON+CSV</b> (third-party App Store app; its automations need the premium tier).
          </li>
          <li>
            Open <b>Automations → New automation → REST API</b>. Paste the URL above, add a header <code className="text-[12px]">Authorization</code> = <code className="text-[12px]">Bearer &lt;token&gt;</code>, export format <b>JSON</b>.
          </li>
          <li>
            Data type <b>Health Metrics</b> — pick Heart Rate, Blood Oxygen, Respiratory Rate, Body Temperature, Blood Pressure, Blood Glucose, Weight, Steps, Sleep Analysis (turn on <i>Summarize data</i>), Resting Heart Rate, HRV. Add separate automations for <b>ECG</b> and <b>Heart Rate Notifications</b> if wanted.
          </li>
          <li>Choose a sync interval (e.g. every 15 min), then tap <b>Manual export</b> once — this panel shows the sync within seconds.</li>
        </ol>
      )}
      {platform === "HEALTH_CONNECT" && (
        <p>
          Android only lets installed apps read Health Connect (Wear OS, Galaxy Watch, Fitbit and Garmin data lands there). A small companion app reads it and posts the <b>normalized JSON</b> to the URL above with this token — the design and code outline are in <code className="text-[12px]">docs/WEARABLES.md</code>. Until it exists you can test the link with any HTTP tool:
        </p>
      )}
      {platform === "OTHER" && <p>Any app or service that can POST JSON can use this link. Send the <b>normalized format</b> (documented in <code className="text-[12px]">docs/WEARABLES.md</code>), for example:</p>}
      {platform !== "APPLE_HEALTH" && <CopyField label="Test with curl" value={curl} />}
      {local && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs text-warn">
          This address only works on this computer. A phone needs a reachable address — your computer&apos;s LAN IP (same Wi-Fi) or a deployed HTTPS URL.
        </p>
      )}
    </div>
  );
}

export function WearablePanel({ patientId, devices, canManage, now, onChange, forPatient = false }: { patientId: string; devices: DeviceDto[]; canManage: boolean; now?: string; onChange: () => void; forPatient?: boolean }) {
  const links = devices.filter((d) => d.adapter === "WEARABLE_SYNC").sort((a, b) => (a.status === b.status ? 0 : a.status === "CONNECTED" ? -1 : 1));
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState<WearablePlatform>("APPLE_HEALTH");
  const [label, setLabel] = useState("");
  const [issued, setIssued] = useState<{ token: string; name: string; url: string } | null>(null);
  const [scenario, setScenario] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const nowMs = now ? new Date(now).getTime() : Date.now();

  const close = () => {
    setOpen(false);
    setIssued(null);
    setLabel("");
  };
  const create = () =>
    run(async () => {
      const r = await api<{ token: string; name: string; ingestPath: string }>(`/api/patients/${patientId}/wearable-link`, { body: { platform, label: label.trim() || undefined } });
      setIssued({ token: r.token, name: r.name, url: `${window.location.origin}${r.ingestPath}` });
      onChange();
    });
  const demo = (deviceId: string) =>
    run(async () => {
      const r = await api<{ accepted: number; duplicates: number; alertsRaised: number; eventsRecorded: number; ignoredMetrics: string[] }>(`/api/patients/${patientId}/wearable-demo`, { body: { deviceId, scenario: scenario[deviceId] ?? "NORMAL" } });
      setResult(`Demo sync processed: ${r.accepted} samples stored, ${r.duplicates} duplicates skipped${r.eventsRecorded ? `, ${r.eventsRecorded} rhythm event${r.eventsRecorded > 1 ? "s" : ""}` : ""}${r.alertsRaised ? `, ${r.alertsRaised} alert${r.alertsRaised > 1 ? "s" : ""} raised` : ", no alerts"}${r.ignoredMetrics.length ? ` · ignored: ${r.ignoredMetrics.join(", ")}` : ""}.`);
      onChange();
    });
  const revoke = (deviceId: string) => run(async () => (await api(`/api/patients/${patientId}/wearable-revoke`, { body: { deviceId } }), setResult(null), onChange()));

  return (
    <div>
      <p className="text-[12px] leading-relaxed text-muted">
        {forPatient ? "Share readings from your own smartwatch or phone with your care team." : "Readings pushed from the patient's own smartwatch or phone health app."} Consumer devices are not clinically validated, so their values are always labelled with their source.
      </p>
      <ul className="mt-3 space-y-2">
        {links.length === 0 && <Empty icon={<Watch className="size-5" />}>No smartwatch or phone linked yet</Empty>}
        {links.map((d) => {
          const active = d.status === "CONNECTED";
          const overdue = active && d.lastSeenAt && nowMs - new Date(d.lastSeenAt).getTime() > SYNC_OVERDUE_MS;
          const plat = WEARABLE_PLATFORMS[(d.platform ?? "OTHER") as WearablePlatform] ?? WEARABLE_PLATFORMS.OTHER;
          return (
            <li key={d.id} className={clsx("rounded-xl border border-line p-3", !active && "opacity-70")}>
              <div className="flex flex-wrap items-center gap-3">
                <span className={clsx("flex size-9 shrink-0 items-center justify-center rounded-lg", !active ? "bg-neutral-soft text-muted" : overdue ? "bg-warn-soft text-warn" : "bg-teal-soft text-teal")}>
                  {d.deviceType === "PHONE" ? <Smartphone className="size-4" /> : <Watch className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{d.name}</p>
                  <p className="text-[11px] text-muted">
                    {plat.label} · token …{d.tokenHint ?? "—"} · {active ? (d.lastSeenAt ? `last sync ${timeAgo(d.lastSeenAt, now)}` : "waiting for first sync") : "revoked"} · {d.syncCount ?? 0} samples stored
                  </p>
                </div>
                {!active ? <Badge tone="muted">Revoked</Badge> : overdue ? <Badge tone="warn">Sync overdue</Badge> : d.lastSeenAt ? <Badge tone="teal">Syncing</Badge> : <Badge tone="info">Linked</Badge>}
              </div>
              {canManage && active && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2 border-t border-line pt-2.5">
                  <Select aria-label="Demo scenario" className="w-auto text-xs" value={scenario[d.id] ?? "NORMAL"} onChange={(e) => setScenario((s) => ({ ...s, [d.id]: e.target.value }))}>
                    <option value="NORMAL">Demo: normal day</option>
                    <option value="LOW_SPO2">Demo: low SpO₂ + fast HR</option>
                    <option value="AFIB">Demo: watch ECG flags AFib</option>
                  </Select>
                  <Button size="sm" variant="teal" disabled={busy} onClick={() => demo(d.id)}>
                    Send demo sync
                  </Button>
                  <SimBadge />
                  <span className="flex-1" />
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => revoke(d.id)}>
                    <Unplug className="size-3.5" /> Revoke
                  </Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {result && <p className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-xs font-medium text-ok">{result}</p>}
      <ErrorNote className="mt-2">{!open ? error : null}</ErrorNote>
      {canManage && (
        <Button className="mt-3" variant="primary" size="sm" onClick={() => setOpen(true)}>
          <Link2 className="size-3.5" /> Link a smartwatch or phone
        </Button>
      )}

      <Modal open={open} onClose={close} title={issued ? `Connect ${issued.name}` : "Link a smartwatch or phone"} wide={!!issued}>
        {!issued ? (
          <div className="space-y-3">
            <fieldset>
              <legend className="mb-1 block text-xs font-medium text-muted">Where does the data live?</legend>
              <div className="grid gap-2">
                {(Object.keys(WEARABLE_PLATFORMS) as WearablePlatform[]).map((k) => (
                  <label key={k} className={clsx("flex cursor-pointer gap-2.5 rounded-xl border p-3", platform === k ? "border-primary bg-primary-soft" : "border-line hover:bg-surface-2")}>
                    <input type="radio" name="platform" className="mt-0.5" checked={platform === k} onChange={() => setPlatform(k)} />
                    <span>
                      <span className="block text-sm font-medium text-ink">{WEARABLE_PLATFORMS[k].label}</span>
                      <span className="block text-[11px] text-muted">{WEARABLE_PLATFORMS[k].devices}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <Field label="Name (optional)" hint="So you can tell devices apart, e.g. “Amelia's Apple Watch”">
              <Input value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} placeholder={WEARABLE_PLATFORMS[platform].defaultName} />
            </Field>
            <ErrorNote>{error}</ErrorNote>
            <div className="flex justify-end gap-2">
              <Button onClick={close}>Cancel</Button>
              <Button variant="primary" busy={busy} onClick={create}>
                <KeyRound className="size-3.5" /> Create link
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn">The token is shown only once. Copy it now — the server keeps only a fingerprint. If it is lost, revoke this link and create a new one.</p>
            <CopyField label="Upload URL" value={issued.url} />
            <CopyField label="Device token" value={issued.token} />
            <CopyField label="Header" value={`Authorization: Bearer ${issued.token}`} />
            <SetupSteps platform={platform} url={issued.url} token={issued.token} />
            <div className="flex justify-end">
              <Button variant="primary" onClick={close}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

const ACTIVITY_ICON: Record<ActivityType, typeof Watch> = { STEPS: Footprints, SLEEP: Moon, RESTING_HR: HeartPulse, HRV: HeartPulse };

/** Context metrics from wearables (no alert rules run on these). Renders nothing when empty. */
export function ActivityStrip({ activity, now }: { activity?: ActivitySummary; now?: string }) {
  const types = ACTIVITY_ORDER.filter((t) => activity?.[t]);
  if (!types.length) return null;
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {types.map((t) => {
        const a = activity![t]!;
        const Icon = ACTIVITY_ICON[t];
        const value = t === "STEPS" ? Math.round(a.v).toLocaleString("en-GB") : a.v.toFixed(ACTIVITY[t].decimals);
        return (
          <div key={t} className="rounded-xl border border-line p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
              <Icon className="size-3.5 text-primary" /> {t === "STEPS" ? "Steps · last 24 h" : t === "SLEEP" ? "Sleep · last night" : ACTIVITY[t].label}
            </p>
            <p className="tnum mt-1 text-xl font-semibold text-ink">
              {value} <span className="text-xs font-normal text-muted">{ACTIVITY[t].unit}</span>
            </p>
            <p className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] text-muted">
              {SYNTHETIC_SOURCES.has(a.src) && <SimBadge />} {SOURCE_LABEL[a.src] ?? a.src} · {timeAgo(a.t, now)}
            </p>
          </div>
        );
      })}
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
