"use client";
// Caregiver app: a restricted overview of one patient. The API returns no history,
// symptoms, clinician notes, alert details or AI summaries for this role.
import { CalendarClock, ClipboardCheck, ClipboardList, HeartPulse, Lock, MessageSquare, Pill } from "lucide-react";
import { MedicationList, MessageThread, ReadingForm, TaskList } from "@/components/CareWidgets";
import { Card, CardHeader, PageError, PageLoading } from "@/components/ui";
import { clock, timeAgo, useLive } from "@/lib/client";
import { ConsultCard, LatestTiles, SafetyLine, StatusCard } from "../me/PatientHome";

export function CaregiverHome({ patientId }: { patientId: string }) {
  const { data, error, refresh } = useLive<any>(`/api/patients/${patientId}`, 3000);

  if (!data) return error ? <PageError message={error.message} onRetry={refresh} /> : <PageLoading />;

  const p = data.patient;
  const now: string = data.now;
  const stale = data.connectivity === "DISCONNECTED";

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-ink sm:text-3xl">Caring for {p.name}</h1>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Care team: <span className="font-medium text-ink">{p.doctor?.name ?? "Doctor to be assigned"}</span> and <span className="font-medium text-ink">{p.nurse?.name ?? "nurse to be assigned"}</span> · Virtual room{" "}
          <span className="font-medium text-ink">{p.room}</span>
        </p>
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-dashed border-line bg-surface px-3.5 py-2.5 text-[13px] leading-relaxed text-muted">
          <Lock className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span>
            <span className="font-semibold text-ink">Restricted caregiver view</span> — you can see the overview and help with check-ins. Clinical notes and history are not shown.
          </span>
        </p>
      </header>

      <StatusCard state={data.state} checkInOverdue={p.checkInOverdue} forCaregiver />

      {p.nextCheckInDueAt && (
        <p className="flex items-center gap-2 rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink">
          <CalendarClock className={p.checkInOverdue ? "size-4 shrink-0 text-warn" : "size-4 shrink-0 text-primary"} aria-hidden />
          {p.checkInOverdue ? "Check-in was due at" : "Next check-in is due at"} <span className="font-semibold">{clock(p.nextCheckInDueAt)}</span>
          <span className="text-muted">({timeAgo(p.nextCheckInDueAt, now)})</span>
        </p>
      )}

      <SafetyLine />

      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-5">
          <Card>
            <CardHeader icon={<HeartPulse className="size-4" />} title="Latest readings" subtitle={stale ? "The device is not sending data — these are the last values received, not current ones" : "The most recent value for each measurement"} />
            <div className="px-5 pb-5">
              <LatestTiles latest={data.latest ?? {}} stale={stale} now={now} />
            </div>
          </Card>

          <Card>
            <CardHeader icon={<ClipboardCheck className="size-4" />} title="Record a check-in" subtitle={`Help ${String(p.name).split(" ")[0]} measure, then send the numbers to the care team`} />
            <div className="px-5 pb-5">
              <ReadingForm patientId={patientId} onDone={refresh} withComment />
            </div>
          </Card>

          <ConsultCard patientId={patientId} consults={data.consults ?? []} onChange={refresh} forCaregiver />
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader icon={<ClipboardList className="size-4" />} title="My monitoring tasks" subtitle="Tasks the care team has assigned to you" />
            <div className="px-5 pb-4">
              <TaskList tasks={data.tasks ?? []} role="CAREGIVER" now={now} onChange={refresh} empty="No tasks assigned to you right now" />
            </div>
          </Card>

          <Card>
            <CardHeader icon={<Pill className="size-4" />} title="Medications" subtitle="Record a dose when you have seen it taken" />
            <div className="px-5 pb-4">
              <MedicationList patientId={patientId} meds={data.medications ?? []} canLog now={now} onChange={refresh} />
            </div>
          </Card>

          <Card>
            <CardHeader icon={<MessageSquare className="size-4" />} title="Messages with the care team" />
            <div className="px-5 pb-5">
              <MessageThread patientId={patientId} messages={data.messages ?? []} meId={data.me.id} onSent={refresh} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
