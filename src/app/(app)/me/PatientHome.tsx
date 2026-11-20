"use client";
// Patient app. Plain language throughout: the patient sees their own data and what to do
// next — never alert internals, clinician notes or AI summaries (the API does not send them).
import clsx from "clsx";
import {
  Activity,
  BellRing,
  CalendarClock,
  ClipboardCheck,
  ClipboardList,
  HeartPulse,
  History,
  MessageSquare,
  PhoneCall,
  Siren,
  Smile,
  Stethoscope,
  Unplug,
  Video,
  Smartphone,
  Watch,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { PatientTransferCard, UrgentHelpButton } from "@/components/TransferWidgets";
import { ActivityStrip, AutoDevicesCard, ConsultRoom, DevicePanel, MedicationList, MessageThread, SymptomForm, TaskList, WearablePanel } from "@/components/CareWidgets";
import { VitalChart, type Point } from "@/components/VitalChart";
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, PageError, PageLoading, SimBadge, Textarea, type Tone } from "@/components/ui";
import { api, clock, dateTime, timeAgo, useAction, useLive } from "@/lib/client";
import { SOURCE_LABEL, SYNTHETIC_SOURCES, VITALS, VITAL_ORDER, formatVital, mgdlToMmol, type LatestMap, type MonitoringState, type VitalType } from "@/lib/types";

// ------------------------------------------------------------------ shared with the caregiver page

/** Patient-facing wording for each monitoring state. Never says the patient "is fine". */
export function plainStatus(state: MonitoringState, checkInOverdue: boolean, forCaregiver = false): { title: string; body: string; tone: Tone; icon: ReactNode } {
  const your = forCaregiver ? "Their" : "Your";
  const you = forCaregiver ? "them" : "you";
  switch (state) {
    case "STABLE":
      return { title: "Monitoring is running", body: `${your} latest readings are inside the range ${forCaregiver ? "the" : "your"} care team set.`, tone: "ok", icon: <Activity className="size-5" /> };
    case "NEEDS_REVIEW":
    case "CRITICAL":
      return {
        title: "The care team is reviewing",
        body: `${forCaregiver ? "The" : "Your"} care team has been notified and is reviewing ${forCaregiver ? "the" : "your"} readings. They will contact ${you} if anything is needed.`,
        tone: "info",
        icon: <BellRing className="size-5" />,
      };
    case "DEVICE_DISCONNECTED":
      return {
        title: "Device not sending data",
        body: forCaregiver
          ? "The monitoring device isn't sending data. Please help reconnect it so the team can see the readings."
          : "Your monitoring device isn't sending data. Please reconnect it below so your team can see your readings.",
        tone: "warn",
        icon: <Unplug className="size-5" />,
      };
    case "NO_RECENT_DATA":
      return checkInOverdue
        ? { title: "Check-in overdue", body: forCaregiver ? "A check-in is overdue — please help send the readings now." : "Your check-in is overdue — please send your readings now.", tone: "warn", icon: <CalendarClock className="size-5" /> }
        : { title: "No recent readings", body: `${forCaregiver ? "The" : "Your"} care team hasn't received any recent readings. Please check the device or send readings below.`, tone: "warn", icon: <CalendarClock className="size-5" /> };
    case "AWAITING_ASSESSMENT":
      return { title: "Admission review pending", body: forCaregiver ? "The doctor will complete the admission review shortly." : "Your doctor will complete your admission review shortly.", tone: "info", icon: <Stethoscope className="size-5" /> };
  }
}

const TONE_BOX: Record<string, string> = {
  ok: "border-ok/30 bg-ok-soft text-ok",
  warn: "border-warn/30 bg-warn-soft text-warn",
  info: "border-info/30 bg-info-soft text-info",
};

export function StatusCard({ state, checkInOverdue, forCaregiver }: { state: MonitoringState; checkInOverdue: boolean; forCaregiver?: boolean }) {
  const s = plainStatus(state, checkInOverdue, forCaregiver);
  return (
    <div role="status" className={clsx("flex items-start gap-3 rounded-2xl border p-4", TONE_BOX[s.tone] ?? TONE_BOX.info)}>
      <span className="mt-0.5 shrink-0" aria-hidden>
        {s.icon}
      </span>
      <div>
        <p className="text-base font-semibold">{s.title}</p>
        <p className="mt-0.5 text-sm leading-relaxed text-ink">{s.body}</p>
      </div>
    </div>
  );
}

export function SafetyLine({ patientId, emergencyNumber, onChange, forCaregiver = false }: { patientId: string; emergencyNumber: string; onChange?: () => void; forCaregiver?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-crit/30 bg-crit-soft px-3.5 py-2.5 text-[13px] leading-relaxed text-ink">
      <Siren className="size-4 shrink-0 text-crit" aria-hidden />
      <span className="min-w-0 flex-1">
        <span className="font-semibold">This service does not replace emergency care.</span> In an emergency call{" "}
        <a href={`tel:${emergencyNumber}`} className="font-semibold text-crit underline">
          {emergencyNumber}
        </a>
        . Need the care team right now? Use the urgent help button.
      </span>
      <UrgentHelpButton patientId={patientId} emergencyNumber={emergencyNumber} onDone={onChange} forCaregiver={forCaregiver} />
    </div>
  );
}

/** Latest value per vital. Old values are labelled "last received" and greyed when nothing is transmitting. */
export function LatestTiles({ latest, stale, now }: { latest: LatestMap; stale: boolean; now?: string }) {
  const types = VITAL_ORDER.filter((t) => latest[t]);
  if (types.length === 0) return <Empty icon={<HeartPulse className="size-6" />}>No readings on record yet</Empty>;
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {types.map((t) => {
        const l = latest[t]!;
        const m = VITALS[t];
        return (
          <div key={t} className={clsx("rounded-xl border border-line p-3", stale ? "bg-neutral-soft" : "bg-surface")}>
            <p className="flex items-center justify-between gap-1 text-xs font-medium text-muted">
              <span>{m.label}</span>
              {SYNTHETIC_SOURCES.has(l.src) && <SimBadge />}
            </p>
            <p className={clsx("tnum mt-1 text-2xl font-bold leading-tight", stale ? "text-muted" : "text-ink")}>
              {formatVital(t, l.v, l.v2)} <span className="text-xs font-medium text-muted">{m.unit}</span>
            </p>
            {t === "GLUCOSE" && <p className="tnum text-[11px] text-muted">{mgdlToMmol(l.v)} mmol/L</p>}
            <p className="mt-1 text-[11px] leading-snug text-muted">
              {stale ? <span className="font-semibold text-warn">Last received </span> : null}
              {timeAgo(l.t, now)} · {SOURCE_LABEL[l.src] ?? l.src}
            </p>
          </div>
        );
      })}
    </div>
  );
}

type ConsultDto = { id: string; status: string; reason: string; requestedBy: string; createdAt: string; startedAt: string | null; endedAt: string | null };

export function ConsultCard({ patientId, consults, onChange, forCaregiver }: { patientId: string; consults: ConsultDto[]; onChange: () => void; forCaregiver?: boolean }) {
  const [reason, setReason] = useState("");
  const [room, setRoom] = useState(false);
  const { busy, error, run } = useAction();
  const current = consults[0];
  const open = current && current.status !== "COMPLETED" ? current : null;
  const request = () => run(async () => (await api(`/api/patients/${patientId}/consult`, { body: { status: "REQUESTED", reason: reason.trim() } }), setReason(""), onChange()));

  return (
    <Card>
      <CardHeader icon={<PhoneCall className="size-4" />} title={forCaregiver ? "Ask for a consultation" : "Talk to my care team"} subtitle="Ask for a phone or video call with a doctor or nurse" />
      <div className="px-5 pb-5">
        {open?.status === "REQUESTED" && (
          <div className="rounded-xl bg-primary-soft p-3.5">
            <p className="text-sm font-semibold text-primary">Requested — {forCaregiver ? "the" : "your"} team will call you</p>
            <p className="mt-0.5 text-xs text-muted">
              Asked {timeAgo(open.createdAt)} by {open.requestedBy}
              {open.reason ? ` — “${open.reason}”` : ""}
            </p>
          </div>
        )}
        {open?.status === "IN_PROGRESS" && (
          <div className="rounded-xl bg-teal-soft p-3.5">
            <p className="text-sm font-semibold text-teal">Your consultation has started</p>
            <p className="mt-0.5 text-xs text-muted">Started {clock(open.startedAt)}. Join when you are ready.</p>
            <Button variant="teal" className="mt-3" onClick={() => setRoom(true)}>
              <Video className="size-3.5" /> Join consultation room
            </Button>
          </div>
        )}
        {!open && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              request();
            }}
          >
            <Field label="What would you like to talk about? (optional)">
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} placeholder="e.g. I have a question about my inhaler" />
            </Field>
            <Button type="submit" variant="primary" busy={busy} className="mt-3">
              <PhoneCall className="size-3.5" /> Request a consultation
            </Button>
            {current?.status === "COMPLETED" && <p className="mt-3 text-xs text-muted">Last consultation finished {dateTime(current.endedAt ?? current.createdAt)}.</p>}
          </form>
        )}
        <ErrorNote className="mt-3">{error}</ErrorNote>
      </div>
      <ConsultRoom open={room} onClose={() => setRoom(false)} title="Consultation room" />
    </Card>
  );
}

// ------------------------------------------------------------------ patient page

const WINDOWS = [
  { id: 15, label: "15 min" },
  { id: 60, label: "1 hour" },
  { id: 360, label: "6 hours" },
];

function Chip({ on, children, onClick }: { on: boolean; children: ReactNode; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={on} onClick={onClick} className={clsx("rounded-full border px-3 py-1 text-xs font-semibold transition-colors", on ? "border-primary bg-primary-soft text-primary" : "border-line text-muted hover:bg-surface-2 hover:text-ink")}>
      {children}
    </button>
  );
}

export function PatientHome({ patientId }: { patientId: string }) {
  const [win, setWin] = useState(60);
  const [vital, setVital] = useState<VitalType | null>(null);
  const { data, error, refresh } = useLive<any>(`/api/patients/${patientId}?window=${win}`, 3000);
  const formRef = useRef<HTMLDivElement>(null);

  if (!data) return error ? <PageError message={error.message} onRetry={refresh} /> : <PageLoading />;

  const p = data.patient;
  const now: string = data.now;
  const first = String(p.name).split(" ")[0];
  const stale = data.connectivity === "DISCONNECTED";
  const series: Record<string, Point[]> = data.series ?? {};
  const present = VITAL_ORDER.filter((t) => series[t]?.length);
  const shown: VitalType | null = vital && present.includes(vital) ? vital : (present[0] ?? null);
  const recent = shown ? [...series[shown]].slice(-8).reverse() : [];
  const symptoms: { id: string; text: string; severity: string; reportedBy: string; createdAt: string; reviewedAt: string | null }[] = data.symptoms ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Hello, {first}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Your care team: <span className="font-medium text-ink">{p.doctor?.name ?? "Doctor to be assigned"}</span> and <span className="font-medium text-ink">{p.nurse?.name ?? "nurse to be assigned"}</span> · Virtual room{" "}
          <span className="font-medium text-ink">{p.room}</span> · {p.wardName}
        </p>
      </header>

      {data.transfer && <PatientTransferCard t={data.transfer} now={now} />}

      {/* When the only issue is an overdue check-in, the banner below says it once. */}
      {!(p.checkInOverdue && data.state === "NO_RECENT_DATA") && <StatusCard state={data.state} checkInOverdue={p.checkInOverdue} />}

      {p.checkInOverdue ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn/40 bg-warn-soft p-4">
          <CalendarClock className="size-5 shrink-0 text-warn" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold text-warn">Time for your scheduled measurement</p>
            <p className="text-sm text-ink">
              It was due at {clock(p.nextCheckInDueAt)} ({timeAgo(p.nextCheckInDueAt, now)}). Please use your {(data.devices ?? []).filter((d: { streaming: boolean; deviceType: string; adapter: string }) => !d.streaming && d.deviceType !== "HOME_HUB" && d.adapter !== "WEARABLE_SYNC").map((d: { name: string }) => d.name).join(" and ") || "devices"} — the reading is sent automatically.
            </p>
          </div>
          <Button onClick={() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}>
            Check my devices
          </Button>
        </div>
      ) : p.nextCheckInDueAt ? (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink">
          <CalendarClock className="size-4 shrink-0 text-primary" aria-hidden />
          Your next scheduled measurement is at <span className="font-semibold">{clock(p.nextCheckInDueAt)}</span> <span className="text-muted">({timeAgo(p.nextCheckInDueAt, now)})</span>
        </p>
      ) : null}

      <SafetyLine patientId={patientId} emergencyNumber={data.emergencyNumber} onChange={refresh} />

      <div className="grid gap-5 lg:grid-cols-2">
        {/* left column */}
        <div className="space-y-5">
          <Card>
            <CardHeader icon={<HeartPulse className="size-4" />} title="My latest readings" subtitle={stale ? "Your device is not sending data — these are the last values received, not current ones" : "The most recent value for each measurement"} />
            <div className="px-5 pb-5">
              <LatestTiles latest={data.latest ?? {}} stale={stale} now={now} />
              {data.activity && Object.keys(data.activity).length > 0 && (
                <div className="mt-4">
                  <p className="mb-2 text-xs font-semibold text-muted">From my smartwatch &amp; phone</p>
                  <ActivityStrip activity={data.activity} now={now} />
                </div>
              )}
            </div>
          </Card>

          <div ref={formRef} className="scroll-mt-20">
            <Card>
              <CardHeader icon={<ClipboardCheck className="size-4" />} title="My monitoring devices" subtitle="Readings reach your care team automatically" />
              <div className="px-5 pb-5">
                <AutoDevicesCard patientId={patientId} devices={data.devices ?? []} manualEntry={!!p.manualEntry} now={now} onDone={refresh} />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader icon={<Smile className="size-4" />} title="Tell us how you feel" subtitle="Your care team reads every report" />
            <div className="px-5 pb-5">
              <SymptomForm patientId={patientId} onDone={refresh} />
              {symptoms.length > 0 && (
                <div className="mt-5">
                  <h4 className="text-[11px] font-bold uppercase tracking-wide text-muted">What you have reported</h4>
                  <ul className="mt-2 space-y-2">
                    {symptoms.slice(0, 6).map((s) => (
                      <li key={s.id} className="rounded-xl border border-line p-3">
                        <p className="text-sm leading-relaxed text-ink">{s.text}</p>
                        <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                          <Badge tone="muted">{s.severity.charAt(0) + s.severity.slice(1).toLowerCase()}</Badge>
                          {s.reviewedAt ? <Badge tone="ok">Reviewed by your team</Badge> : <Badge tone="primary">Not yet reviewed</Badge>}
                          <span>
                            {timeAgo(s.createdAt, now)} · {s.reportedBy}
                          </span>
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader
              icon={<History className="size-4" />}
              title="Reading history"
              action={
                <div className="flex gap-1">
                  {WINDOWS.map((w) => (
                    <Chip key={w.id} on={win === w.id} onClick={() => setWin(w.id)}>
                      {w.label}
                    </Chip>
                  ))}
                </div>
              }
            />
            <div className="px-5 pb-5">
              {shown ? (
                <>
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {present.map((t) => (
                      <Chip key={t} on={shown === t} onClick={() => setVital(t)}>
                        {VITALS[t].label}
                      </Chip>
                    ))}
                  </div>
                  <VitalChart type={shown} points={series[shown]} limits={data.limits} height={210} />
                  <div className="mt-3 overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="text-[11px] uppercase tracking-wide text-muted">
                          <th className="py-1.5 pr-3 font-semibold">Time</th>
                          <th className="py-1.5 pr-3 font-semibold">{VITALS[shown].label}</th>
                          <th className="py-1.5 font-semibold">Source</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-line">
                        {recent.map((r, i) => (
                          <tr key={`${r.t}-${i}`}>
                            <td className="tnum whitespace-nowrap py-1.5 pr-3 text-muted">{dateTime(r.t)}</td>
                            <td className="tnum py-1.5 pr-3 font-medium text-ink">
                              {formatVital(shown, r.v, r.v2)} <span className="text-xs font-normal text-muted">{VITALS[shown].unit}</span>
                            </td>
                            <td className="py-1.5 text-xs text-muted">{SOURCE_LABEL[r.src] ?? r.src}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              ) : (
                <Empty icon={<History className="size-6" />}>No readings in this time window — try a longer one.</Empty>
              )}
            </div>
          </Card>
        </div>

        {/* right column */}
        <div className="space-y-5">
          <Card>
            <CardHeader icon={<ClipboardList className="size-4" />} title="Check-ins & reminders" subtitle="Tick things off as you do them" />
            <div className="px-5 pb-4">
              <TaskList tasks={data.tasks ?? []} role="PATIENT" now={now} onChange={refresh} empty="Nothing to do right now" />
              <h4 className="mt-4 text-[11px] font-bold uppercase tracking-wide text-muted">My medications</h4>
              <MedicationList patientId={patientId} meds={data.medications ?? []} canLog now={now} onChange={refresh} />
            </div>
          </Card>

          <Card>
            <CardHeader icon={<MessageSquare className="size-4" />} title="Messages with my care team" />
            <div className="px-5 pb-5">
              <MessageThread patientId={patientId} messages={data.messages ?? []} meId={data.me.id} onSent={refresh} />
            </div>
          </Card>

          <ConsultCard patientId={patientId} consults={data.consults ?? []} onChange={refresh} />

          <Card>
            <CardHeader icon={<Stethoscope className="size-4" />} title="My care plan" action={<Badge tone="ok">Approved by your care team</Badge>} />
            <div className="px-5 pb-5">
              {p.carePlan?.length ? (
                <ul className="space-y-2">
                  {(p.carePlan as string[]).map((c, i) => (
                    <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-ink">
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-teal" aria-hidden />
                      {c}
                    </li>
                  ))}
                </ul>
              ) : (
                <Empty>Your care plan will appear here once your team has approved it</Empty>
              )}
              <p className="mt-3 text-[11px] text-muted">
                {p.pathway} · admitted {dateTime(p.admittedAt)}
              </p>
            </div>
          </Card>

          <Card>
            <CardHeader icon={<Smartphone className="size-4" />} title="My smartwatch & phone" subtitle="Apple Watch, Android / Wear OS and other health apps" />
            <div className="px-5 pb-5">
              <WearablePanel patientId={patientId} devices={data.devices ?? []} canManage now={now} onChange={refresh} forPatient />
            </div>
          </Card>

          <Card>
            <CardHeader icon={<Watch className="size-4" />} title="My devices" subtitle="Connect or reconnect your monitoring devices" />
            <div className="px-5 pb-5">
              <DevicePanel patientId={patientId} devices={data.devices ?? []} canManage now={now} onChange={refresh} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
