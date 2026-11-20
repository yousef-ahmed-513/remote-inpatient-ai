"use client";
import clsx from "clsx";
import { ArrowUpRight, BellRing, CalendarX, Check, CheckCheck, HeartPulse, MessageSquareWarning, TrendingDown, Unplug } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, clock, timeAgo, useAction } from "@/lib/client";
import type { Role } from "@/lib/types";
import { Badge, Button, Empty, ErrorNote, Field, Modal, Textarea } from "./ui";

export type AlertDto = {
  id: string;
  patientId: string;
  patient: { name: string; room: string; mrn: string } | null;
  kind: string;
  vital: string | null;
  severity: string;
  title: string;
  message: string;
  status: string;
  createdAt: string;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
  escalatedAt: string | null;
  escalatedBy: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
};

const KIND_ICON: Record<string, typeof BellRing> = {
  THRESHOLD: BellRing,
  TREND: TrendingDown,
  CONNECTIVITY: Unplug,
  CHECKIN_OVERDUE: CalendarX,
  RHYTHM_FLAG: HeartPulse,
  SYMPTOM: MessageSquareWarning,
};
const KIND_LABEL: Record<string, string> = {
  THRESHOLD: "Limit rule",
  TREND: "Trend rule",
  CONNECTIVITY: "Connectivity",
  CHECKIN_OVERDUE: "Missed check-in",
  RHYTHM_FLAG: "Device flag",
  SYMPTOM: "Symptom",
};
const QUICK_NOTES = ["Contacted patient — reviewed and settled.", "Repeat reading within limits.", "Reviewed by doctor; care plan updated.", "Device issue fixed with patient."];

export function AlertItem({ alert: a, role, now, onChange, showPatient = true, dense }: { alert: AlertDto; role: Role; now?: string; onChange: () => void; showPatient?: boolean; dense?: boolean }) {
  const { busy, error, run } = useAction();
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState("");
  const Icon = KIND_ICON[a.kind] ?? BellRing;
  const crit = a.severity === "CRITICAL";
  const resolved = a.status === "RESOLVED";
  const act = (action: string, extra: Record<string, unknown> = {}) => run(async () => (await api(`/api/alerts/${a.id}`, { method: "PATCH", body: { action, ...extra } }), onChange()));

  return (
    <div className={clsx("rounded-xl border border-line border-l-4 bg-surface", resolved ? "border-l-line opacity-80" : crit ? "border-l-crit" : "border-l-warn", dense ? "p-3" : "p-3.5")}>
      <div className="flex items-start gap-3">
        <span className={clsx("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg", resolved ? "bg-neutral-soft text-muted" : crit ? "bg-crit-soft text-crit" : "bg-warn-soft text-warn")}>
          <Icon className="size-3.5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            {!resolved && <Badge tone={crit ? "crit" : "warn"}>{crit ? "CRITICAL" : "REVIEW"}</Badge>}
            <Badge tone="muted">{KIND_LABEL[a.kind] ?? a.kind}</Badge>
            {a.status === "ACKNOWLEDGED" && <Badge tone="primary">Acknowledged</Badge>}
            {a.status === "ESCALATED" && <Badge tone="info">Escalated to doctor</Badge>}
            {resolved && <Badge tone="ok">Resolved</Badge>}
            <span className="tnum ml-auto text-[11px] text-muted" title={clock(a.createdAt, true)}>
              {timeAgo(a.createdAt, now)}
            </span>
          </div>
          <p className="mt-1.5 text-sm font-semibold leading-snug text-ink">{a.title}</p>
          {showPatient && a.patient && (
            <Link href={`/patients/${a.patientId}`} className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              {a.patient.name} · {a.patient.room} <ArrowUpRight className="size-3" />
            </Link>
          )}
          {!dense && <p className="mt-1 text-xs leading-relaxed text-muted">{a.message}</p>}
          <div className="mt-1.5 space-y-0.5 text-[11px] text-muted">
            {a.acknowledgedAt && (
              <p>
                Acknowledged {clock(a.acknowledgedAt)} by {a.acknowledgedBy ?? "—"}
              </p>
            )}
            {a.escalatedAt && (
              <p>
                Escalated {clock(a.escalatedAt)} by {a.escalatedBy ?? "—"}
              </p>
            )}
            {a.resolvedAt && (
              <p>
                Resolved {clock(a.resolvedAt)} by {a.resolvedBy ?? "—"}
                {a.resolutionNote ? ` — “${a.resolutionNote}”` : ""}
              </p>
            )}
          </div>
          {!resolved && (
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {!a.acknowledgedAt && (
                <Button size="sm" variant="primary" busy={busy} onClick={() => act("acknowledge")}>
                  <Check className="size-3.5" /> Acknowledge
                </Button>
              )}
              {role === "NURSE" && a.status !== "ESCALATED" && (
                <Button size="sm" disabled={busy} onClick={() => act("escalate")}>
                  <ArrowUpRight className="size-3.5" /> Escalate to doctor
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => setResolving(true)}>
                <CheckCheck className="size-3.5" /> Resolve…
              </Button>
            </div>
          )}
          <ErrorNote className="mt-2">{error}</ErrorNote>
        </div>
      </div>

      <Modal open={resolving} onClose={() => setResolving(false)} title="Resolve alert">
        <p className="text-sm font-semibold text-ink">{a.title}</p>
        {a.patient && <p className="text-xs text-muted">{a.patient.name} · {a.patient.room}</p>}
        <Field label="Resolution note (required — stored in the clinical record)" className="mt-4">
          <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you check or do?" />
        </Field>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {QUICK_NOTES.map((q) => (
            <button key={q} type="button" onClick={() => setNote(q)} className="rounded-full border border-line px-2.5 py-1 text-[11px] text-muted hover:bg-surface-2 hover:text-ink">
              {q}
            </button>
          ))}
        </div>
        <ErrorNote className="mt-3">{error}</ErrorNote>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setResolving(false)}>Cancel</Button>
          <Button variant="primary" busy={busy} disabled={note.trim().length < 3} onClick={async () => (await act("resolve", { note: note.trim() })) && (setResolving(false), setNote(""))}>
            Resolve alert
          </Button>
        </div>
      </Modal>
    </div>
  );
}

export function AlertList({ alerts, role, now, onChange, showPatient, dense, empty = "No active alerts" }: { alerts: AlertDto[]; role: Role; now?: string; onChange: () => void; showPatient?: boolean; dense?: boolean; empty?: string }) {
  if (alerts.length === 0) return <Empty icon={<CheckCheck className="size-6" />}>{empty}</Empty>;
  const sorted = [...alerts].sort((a, b) => {
    const rank = (x: AlertDto) => (x.status === "RESOLVED" ? 3 : x.severity === "CRITICAL" ? 0 : x.status === "OPEN" ? 1 : 2);
    return rank(a) - rank(b) || +new Date(b.createdAt) - +new Date(a.createdAt);
  });
  return (
    <div className="space-y-2">
      {sorted.map((a) => (
        <AlertItem key={a.id} alert={a} role={role} now={now} onChange={onChange} showPatient={showPatient} dense={dense} />
      ))}
    </div>
  );
}
