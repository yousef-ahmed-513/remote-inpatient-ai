"use client";
// Emergency transfer UI: clinician request dialog + live tracker, patient/caregiver status card,
// and the "I need urgent help" button. Server logic: src/lib/transfers.ts
import clsx from "clsx";
import { Ambulance, BedDouble, Check, ChevronDown, CircleAlert, Clock, FastForward, Hospital, MapPin, Phone, Siren, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, clock, useAction } from "@/lib/client";
import { TRANSFER_PATHWAYS, TRANSFER_PRIORITY, TRANSFER_STAGES, TRANSFER_STATUS, type TransferPathway, type TransferPriority, type TransferStatus } from "@/lib/types";
import { Badge, Button, Card, CardHeader, ErrorNote, Field, Modal, SimBadge, Textarea } from "./ui";

type ChecklistItem = { id: string; label: string; owner: "VIRTUAL_WARD" | "RECEIVING_UNIT"; done: boolean; doneAt: string | null; doneBy: string | null };
type Handover = {
  identify: { name: string; mrn: string; age: number; sex: string; address: string; accessNotes: string; virtualWard: string; responsibleDoctor: string | null; nurse: string | null };
  situation: { reason: string; priority: string; activeAlerts: { severity: string; title: string; at: string }[] };
  background: { condition: string; programme: string; admittedAt: string; carePlan: string[]; medications: { name: string; dose: string; schedule: string; lastTakenAt: string | null }[]; allergies: string };
  assessment: { vitals: { vital: string; value: string; unit: string; at: string; source: string }[]; symptoms: { text: string; severity: string; at: string }[]; devices: string };
  recommendation: { pathway: string; destination: string; hospital: string; requests: string[] };
  disclaimer: string;
};
export type TransferDto = {
  id: string;
  status: TransferStatus;
  statusLabel: string;
  open: boolean;
  priority: TransferPriority;
  destination: string;
  hospital: string;
  directAdmission: boolean;
  unitStatus: "PENDING" | "ACCEPTED" | "DECLINED";
  vehicle: string | null;
  etaAt: string | null;
  etaKind: "AT_PATIENT" | "AT_HOSPITAL" | null;
  timeScale: number;
  createdAt: string;
  closedAt: string | null;
  emergencyNumber: string;
  ambulanceService: string;
  instructions?: string[];
  // clinical only
  pathway?: TransferPathway;
  suggestedPathway?: TransferPathway;
  reason?: string;
  bed?: string | null;
  incidentRef?: string | null;
  pickupAddress?: string;
  accessNotes?: string;
  requestedByName?: string;
  cancelReason?: string | null;
  stageTimes?: Partial<Record<TransferStatus, string | null>>;
  checklist?: ChecklistItem[];
  unitReady?: { done: number; total: number };
  handover?: Handover | null;
  timeline?: { t: string; text: string; kind: string }[];
};

function countdown(etaAt: string | null, now?: string) {
  if (!etaAt) return null;
  const ms = new Date(etaAt).getTime() - (now ? new Date(now).getTime() : Date.now());
  if (ms <= 0) return "any moment";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s` : `${s} s`;
}

function Stepper({ status }: { status: TransferStatus }) {
  const idx = TRANSFER_STAGES.indexOf(status);
  return (
    <ol className="grid grid-cols-3 gap-1.5 sm:grid-cols-6" aria-label="Transfer progress">
      {TRANSFER_STAGES.map((s, i) => (
        <li key={s} className={clsx("rounded-lg px-2 py-1.5 text-[11px] font-medium leading-tight", status === "CANCELLED" ? "bg-neutral-soft text-muted line-through" : i < idx ? "bg-ok-soft text-ok" : i === idx ? "bg-crit text-white dark:text-[#06131f]" : "bg-surface-2 text-muted")} aria-current={i === idx ? "step" : undefined}>
          {i < idx && <Check className="mr-0.5 inline size-3" aria-hidden />}
          {TRANSFER_STATUS[s].label}
        </li>
      ))}
    </ol>
  );
}

// ------------------------------------------------------------------ clinician: request dialog
type Suggestion = { priority: TransferPriority; pathway: TransferPathway; reasons: string[]; alternatives: TransferPathway[]; pickupAddress: string; accessNotes: string; hospital: string; ambulanceService: string; timeScale: number };

export function TransferRequestDialog({ patientId, patientName, open, onClose, onDone }: { patientId: string; patientName: string; open: boolean; onClose: () => void; onDone: () => void }) {
  const [s, setS] = useState<Suggestion | null>(null);
  const [priority, setPriority] = useState<TransferPriority>("URGENT");
  const [pathway, setPathway] = useState<TransferPathway>("GENERAL_MEDICAL");
  const [reason, setReason] = useState("");
  const [access, setAccess] = useState("");
  const load = useAction();
  const send = useAction();

  useEffect(() => {
    if (!open) return;
    setS(null);
    load.run(async () => {
      const r = await api<Suggestion>(`/api/patients/${patientId}/transfer-suggest`, { body: {} });
      setS(r);
      setPriority(r.priority);
      setPathway(r.pathway);
      setAccess(r.accessNotes);
      setReason("");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, patientId]);

  const submit = () =>
    send.run(async () => {
      await api(`/api/patients/${patientId}/transfer-request`, { body: { priority, pathway, reason, accessNotes: access } });
      onDone();
      onClose();
    });

  const meta = TRANSFER_PATHWAYS[pathway];
  return (
    <Modal open={open} onClose={onClose} title={`Emergency transfer — ${patientName}`} wide>
      {!s ? (
        <p className="py-6 text-center text-sm text-muted">{load.error ?? "Checking alerts, vitals and symptoms…"}</p>
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-info/40 bg-info-soft px-3 py-2.5">
            <p className="text-xs font-semibold text-info">Suggested by the rules engine — you decide</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-ink">
              {s.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>

          <fieldset>
            <legend className="mb-1 block text-xs font-medium text-muted">Priority</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {(Object.keys(TRANSFER_PRIORITY) as TransferPriority[]).map((k) => (
                <label key={k} className={clsx("flex cursor-pointer gap-2 rounded-xl border p-3", priority === k ? (k === "EMERGENCY" ? "border-crit bg-crit-soft" : "border-warn bg-warn-soft") : "border-line hover:bg-surface-2")}>
                  <input type="radio" name="priority" checked={priority === k} onChange={() => setPriority(k)} className="mt-0.5" />
                  <span>
                    <span className="block text-sm font-semibold text-ink">
                      {TRANSFER_PRIORITY[k].label} {s.priority === k && <Badge tone="info">Suggested</Badge>}
                    </span>
                    <span className="block text-[11px] text-muted">{TRANSFER_PRIORITY[k].hint}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="mb-1 block text-xs font-medium text-muted">Receiving pathway at {s.hospital}</legend>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {(Object.keys(TRANSFER_PATHWAYS) as TransferPathway[]).map((k) => (
                <label key={k} className={clsx("flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2", pathway === k ? "border-primary bg-primary-soft" : "border-line hover:bg-surface-2")}>
                  <input type="radio" name="pathway" checked={pathway === k} onChange={() => setPathway(k)} className="mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium text-ink">
                      {TRANSFER_PATHWAYS[k].label} {s.pathway === k && <Badge tone="info">Suggested</Badge>}
                    </span>
                    <span className="block text-[11px] text-muted">{TRANSFER_PATHWAYS[k].unit}</span>
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted">
              {meta.direct
                ? `Direct admission: the unit receives the handover now. The ambulance goes straight to ${meta.unit} only after the unit accepts; if it declines, the patient goes to the emergency department, pre-alerted.`
                : "The emergency department receives the full handover before arrival."}
            </p>
          </fieldset>

          <Field label="Reason for the crew and receiving team" hint="Short and specific — this is the first line of the handover">
            <Textarea rows={2} value={reason} maxLength={400} onChange={(e) => setReason(e.target.value)} placeholder="e.g. SpO₂ 86 % on home oxygen, RR 30, increasingly breathless" />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-xs font-medium text-muted">Pickup address</p>
              <p className="flex items-start gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[13px] text-ink">
                <MapPin className="mt-0.5 size-3.5 shrink-0 text-muted" /> {s.pickupAddress || "No address on record"}
              </p>
            </div>
            <Field label="Access notes for the crew">
              <Textarea rows={2} value={access} maxLength={300} onChange={(e) => setAccess(e.target.value)} />
            </Field>
          </div>
          <p className="flex items-center gap-1.5 text-[11px] text-muted">
            <SimBadge /> {s.ambulanceService} and {s.hospital} are simulated. Demo clock runs {Math.round(1 / s.timeScale)}× faster than a real call-out.
          </p>
          <ErrorNote>{send.error}</ErrorNote>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" busy={send.busy} disabled={reason.trim().length < 5} onClick={submit}>
              <Ambulance className="size-4" /> Request ambulance
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ------------------------------------------------------------------ clinician: live tracker
export function TransferPanel({ t, patientId, now, onChange }: { t: TransferDto; patientId: string; now?: string; onChange: () => void }) {
  const act = useAction();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [showHandover, setShowHandover] = useState(false);
  const post = (action: string, body: unknown = {}) => act.run(async () => (await api(`/api/patients/${patientId}/${action}`, { body }), onChange()));
  const eta = countdown(t.etaAt, now);
  const list = t.checklist ?? [];
  const h = t.handover;

  return (
    <Card className={clsx("border-l-4", t.open ? "border-l-crit" : t.status === "CANCELLED" ? "border-l-muted" : "border-l-ok")}>
      <CardHeader
        icon={<Ambulance className="size-4" />}
        title={
          <span className="flex flex-wrap items-center gap-2">
            Emergency transfer · {t.statusLabel}
            <Badge tone={t.priority === "EMERGENCY" ? "crit" : "warn"}>{t.priority === "EMERGENCY" ? "Emergency" : "Urgent"}</Badge>
            <SimBadge />
          </span>
        }
        subtitle={`${t.ambulanceService} · incident ${t.incidentRef ?? "—"} · ${t.vehicle ?? ""} · requested by ${t.requestedByName} at ${clock(t.createdAt)}`}
      />
      <div className="space-y-4 px-5 pb-5">
        <Stepper status={t.status} />

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-line p-3">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
              <Clock className="size-3.5" /> {t.etaKind === "AT_PATIENT" ? "Ambulance at patient in" : t.etaKind === "AT_HOSPITAL" ? "At hospital in" : "Status"}
            </p>
            <p className="tnum mt-1 text-xl font-semibold text-ink">{eta ?? t.statusLabel}</p>
            {t.etaAt && <p className="text-[10px] text-muted">≈ {clock(t.etaAt, true)} · demo clock ×{Math.round(1 / t.timeScale)}</p>}
          </div>
          <div className="rounded-xl border border-line p-3 md:col-span-2">
            <p className="flex items-center gap-1.5 text-[11px] font-medium text-muted">
              <Hospital className="size-3.5" /> Destination · {t.hospital}
            </p>
            <p className="mt-1 text-sm font-semibold text-ink">
              {t.destination} {t.bed && <span className="font-normal text-muted">· {t.bed}</span>}
            </p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {t.unitStatus === "PENDING" && <Badge tone="info">Awaiting unit acceptance</Badge>}
              {t.unitStatus === "ACCEPTED" && t.directAdmission && <Badge tone="ok">Direct admission — bypasses the emergency department</Badge>}
              {t.unitStatus === "DECLINED" && <Badge tone="warn">Unit declined → emergency department, pre-alerted</Badge>}
              {t.unitStatus === "ACCEPTED" && !t.directAdmission && <Badge tone="muted">Emergency department, pre-alerted</Badge>}
              {t.unitReady && (
                <Badge tone={t.unitReady.done === t.unitReady.total ? "ok" : "muted"}>
                  <BedDouble className="size-3" /> Unit ready {t.unitReady.done}/{t.unitReady.total}
                </Badge>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink">Preparation</p>
            <ul className="space-y-1">
              {list.map((c) => {
                const mine = c.owner === "VIRTUAL_WARD";
                return (
                  <li key={c.id} className="flex items-start gap-2 text-[13px]">
                    <button
                      type="button"
                      disabled={!mine || !t.open || act.busy}
                      onClick={() => post("transfer-prep", { itemId: c.id, done: !c.done })}
                      aria-label={`${c.done ? "Re-open" : "Mark done"}: ${c.label}`}
                      className={clsx("mt-0.5 flex size-4 shrink-0 items-center justify-center rounded border", c.done ? "border-ok bg-ok text-white" : "border-line bg-surface", mine && t.open ? "cursor-pointer" : "cursor-default")}
                    >
                      {c.done && <Check className="size-3" />}
                    </button>
                    <span className="min-w-0">
                      <span className={clsx("text-ink", c.done && "text-muted")}>{c.label}</span>
                      <span className="block text-[10px] text-muted">
                        {mine ? "Virtual ward" : "Receiving unit"}
                        {c.done && c.doneBy ? ` · ${c.doneBy} ${clock(c.doneAt)}` : ""}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-semibold text-ink">Timeline</p>
            <ol className="max-h-64 space-y-1.5 overflow-y-auto border-l border-line pl-3">
              {[...(t.timeline ?? [])].reverse().map((e, i) => (
                <li key={i} className="text-[12px] leading-snug text-ink">
                  <span className="tnum mr-1.5 text-[10px] text-muted">{clock(e.t, true)}</span>
                  <span className={clsx(e.kind === "UNIT" && /DECLINED/.test(e.text) && "font-medium text-warn")}>{e.text}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {h && (
          <div className="rounded-xl border border-line">
            <button type="button" onClick={() => setShowHandover((x) => !x)} className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold text-ink" aria-expanded={showHandover}>
              Handover sent to crew and unit (ISBAR snapshot, {clock(t.createdAt)})
              <ChevronDown className={clsx("size-4 text-muted transition", showHandover && "rotate-180")} />
            </button>
            {showHandover && (
              <div className="grid gap-3 border-t border-line px-3 py-3 text-[12px] leading-relaxed text-ink md:grid-cols-2">
                <div>
                  <p className="font-semibold">I — Identify</p>
                  <p>
                    {h.identify.name} · {h.identify.mrn} · {h.identify.age} y {h.identify.sex} · {h.identify.virtualWard}
                  </p>
                  <p className="text-muted">
                    {h.identify.address}
                    {h.identify.accessNotes ? ` — ${h.identify.accessNotes}` : ""}
                  </p>
                  <p className="mt-2 font-semibold">S — Situation</p>
                  <p>{h.situation.reason}</p>
                  <ul className="list-disc pl-4 text-muted">
                    {h.situation.activeAlerts.map((a, i) => (
                      <li key={i}>
                        {a.severity === "CRITICAL" ? "Critical" : "Review"}: {a.title}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 font-semibold">B — Background</p>
                  <p>
                    {h.background.condition} · {h.background.programme}
                  </p>
                  <p className="text-muted">Medicines: {h.background.medications.map((m) => `${m.name} ${m.dose}`).join("; ") || "none recorded"}</p>
                  <p className="text-muted">Allergies: {h.background.allergies}</p>
                </div>
                <div>
                  <p className="font-semibold">A — Assessment</p>
                  <ul className="text-muted">
                    {h.assessment.vitals.map((x) => (
                      <li key={x.vital}>
                        <span className="text-ink">
                          {x.vital} {x.value} {x.unit}
                        </span>{" "}
                        · {clock(x.at)} · {x.source}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted">{h.assessment.devices}</p>
                  {h.assessment.symptoms.length > 0 && <p className="text-muted">Symptoms: {h.assessment.symptoms.map((x) => `"${x.text}" (${x.severity.toLowerCase()})`).join("; ")}</p>}
                  <p className="mt-2 font-semibold">R — Recommendation</p>
                  <p>
                    {h.recommendation.pathway} → {h.recommendation.destination}, {h.recommendation.hospital}
                  </p>
                  <p className="mt-2 text-[10px] text-muted">{h.disclaimer}</p>
                </div>
              </div>
            )}
          </div>
        )}

        {t.status === "CANCELLED" && t.cancelReason && <p className="text-xs text-muted">Cancelled: {t.cancelReason}</p>}
        <ErrorNote>{act.error}</ErrorNote>
        {t.open && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-line pt-3">
            <Button size="sm" variant="ghost" busy={act.busy} onClick={() => post("transfer-advance")}>
              <FastForward className="size-3.5" /> Next stage (demo)
            </Button>
            {t.status !== "ARRIVED" && (
              <Button size="sm" onClick={() => setCancelOpen(true)}>
                <X className="size-3.5" /> Stand down ambulance
              </Button>
            )}
          </div>
        )}
      </div>
      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title="Stand down the ambulance?">
        <div className="space-y-3">
          <p className="text-sm text-ink">The ambulance service and the receiving unit are told immediately and the reserved bed is released.</p>
          <Field label="Reason">
            <Textarea rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. Reassessed on video call — symptoms resolved, GP visit arranged" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setCancelOpen(false)}>Keep transfer</Button>
            <Button variant="danger" busy={act.busy} disabled={cancelReason.trim().length < 3} onClick={async () => (await post("transfer-cancel", { reason: cancelReason })) && setCancelOpen(false)}>
              Stand down
            </Button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

// ------------------------------------------------------------------ patient / caregiver
export function PatientTransferCard({ t, now, forCaregiver = false }: { t: TransferDto; now?: string; forCaregiver?: boolean }) {
  const eta = countdown(t.etaAt, now);
  return (
    <div role="status" aria-live="polite" className={clsx("rounded-2xl border-2 p-5", t.open ? "border-crit bg-crit-soft" : "border-line bg-surface")}>
      <div className="flex flex-wrap items-start gap-4">
        <span className={clsx("flex size-12 shrink-0 items-center justify-center rounded-2xl", t.open ? "bg-crit text-white dark:text-[#06131f]" : "bg-neutral-soft text-muted")}>
          <Ambulance className="size-6" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-lg font-bold text-ink">{t.statusLabel}</p>
          {eta && (
            <p className="tnum text-sm text-ink">
              {t.etaKind === "AT_PATIENT" ? "Arriving" : "At hospital"} in about <b>{eta}</b>
            </p>
          )}
          <p className="mt-1 text-sm text-ink">
            {t.destination} · {t.hospital}
            {t.directAdmission && t.unitStatus === "ACCEPTED" && <span className="text-ok"> — {forCaregiver ? "they" : "you"} will go straight to the unit, not the emergency department</span>}
          </p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-ink">
            {(t.instructions ?? []).map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <a href={`tel:${t.emergencyNumber}`} className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-crit px-3 text-sm font-semibold text-white dark:text-[#06131f]">
              <Phone className="size-4" /> Call {t.emergencyNumber}
            </a>
            <SimBadge />
          </div>
        </div>
      </div>
    </div>
  );
}

export function UrgentHelpButton({ patientId, emergencyNumber, onDone, forCaregiver = false }: { patientId: string; emergencyNumber: string; onDone?: () => void; forCaregiver?: boolean }) {
  const act = useAction();
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const press = () =>
    act.run(async () => {
      await api(`/api/patients/${patientId}/urgent-help`, { body: {} });
      setSent(true);
      onDone?.();
    });
  return (
    <>
      <Button variant="danger" onClick={() => (setSent(false), setOpen(true))}>
        <Siren className="size-4" /> I need urgent help
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Urgent help">
        <div className="space-y-4">
          <div className="rounded-xl border-2 border-crit bg-crit-soft p-4">
            <p className="flex items-center gap-2 text-base font-bold text-crit">
              <CircleAlert className="size-5" /> Life-threatening? Call {emergencyNumber} now
            </p>
            <p className="mt-1 text-sm text-ink">Chest pain, severe difficulty breathing, fainting, confusion, signs of a stroke or heavy bleeding — do not wait for the app.</p>
            <a href={`tel:${emergencyNumber}`} className="mt-3 inline-flex h-10 items-center gap-2 rounded-lg bg-crit px-4 text-sm font-semibold text-white dark:text-[#06131f]">
              <Phone className="size-4" /> Call {emergencyNumber}
            </a>
          </div>
          {sent ? (
            <p className="rounded-lg bg-ok-soft px-3 py-2 text-sm font-medium text-ok">Your care team has been alerted and will contact you straight away. Keep your phone close.</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-ink">Not an emergency but you need the care team now?</p>
              <Button variant="primary" busy={act.busy} onClick={press}>
                Alert my care team now
              </Button>
            </div>
          )}
          <ErrorNote>{act.error}</ErrorNote>
        </div>
      </Modal>
    </>
  );
}
