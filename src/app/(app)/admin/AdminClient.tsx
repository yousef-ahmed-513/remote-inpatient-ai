"use client";
import clsx from "clsx";
import { Activity, BedDouble, Bell, Building2, CalendarX, ClipboardList, Gauge, Hourglass, ScrollText, ShieldCheck, SlidersHorizontal, Sparkles, Stethoscope, Timer, UserPlus, Users } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { SimControls, type SimDto } from "@/components/SimControls";
import { Badge, Button, Card, CardHeader, Empty, ErrorNote, Field, Input, PageError, PageLoading, Select, TONE, type Tone } from "@/components/ui";
import { api, dateTime, duration, useAction, useLive } from "@/lib/client";
import { ROLE_LABEL, STATE_META, STATE_PRIORITY, THRESHOLD_VITALS, type Limits, type MonitoringState, type Role, type ThresholdVital } from "@/lib/types";

type AdminData = {
  sim: SimDto;
  now: string;
  aiProvider: string;
  kpis: {
    admitted: number;
    activeBeds: number;
    capacity: number;
    available: number;
    monitored: number;
    activeAlerts: number;
    criticalAlerts: number;
    overdueCheckIns: number;
    avgAckSeconds: number | null;
    ackSample: number;
    avgResolveSeconds: number | null;
    resolveSample: number;
    alerts24h: number;
  };
  states: Record<string, number>;
  alertsByKind: Record<string, number>;
  wards: { id: string; name: string; capacity: number; occupied: number }[];
  clinicians: { id: string; name: string; role: string; title: string; patients: { id: string; name: string; room: string; state?: MonitoringState }[]; openAlerts: number }[];
  patients: { id: string; name: string; room: string; mrn: string; wardId: string; doctorId: string | null; nurseId: string | null; state?: MonitoringState }[];
  users: { id: string; name: string; role: string; title: string }[];
  defaults: Record<ThresholdVital, Limits>;
  logs: { id: string; at: string; who: string; role: string; action: string; detail: string; patientId: string | null }[];
};

const KIND_LABEL: Record<string, string> = {
  THRESHOLD: "Limit rule",
  TREND: "Trend rule",
  CONNECTIVITY: "Connectivity",
  CHECKIN_OVERDUE: "Missed check-in",
  RHYTHM_FLAG: "Device flag",
  SYMPTOM: "Symptom",
};
const ROLE_TONE: Record<string, Tone> = { ADMIN: "primary", DOCTOR: "info", NURSE: "teal", PATIENT: "ok", CAREGIVER: "warn", SYSTEM: "muted" };
const BAR: Record<Tone, string> = { ok: "bg-ok", warn: "bg-warn", crit: "bg-crit", muted: "bg-muted", info: "bg-info", primary: "bg-primary", teal: "bg-teal" };

function humanise(action: string) {
  const s = action.toLowerCase().replace(/_/g, " ");
  return (s.charAt(0).toUpperCase() + s.slice(1)).replace(/\bai\b/gi, "AI").replace(/\becg\b/gi, "ECG").replace(/\bsim\b/gi, "Simulator");
}
const roleLabel = (r: string) => (r === "SYSTEM" ? "System" : (ROLE_LABEL[r as Role] ?? r));

function Kpi({ icon, label, value, sub, tone = "primary" }: { icon: ReactNode; label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) {
  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <span className={clsx("flex size-9 shrink-0 items-center justify-center rounded-xl", TONE[tone])}>{icon}</span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-muted">{label}</p>
          <p className="tnum mt-0.5 text-2xl font-bold leading-tight tracking-tight text-ink">{value}</p>
          {sub && <p className="mt-0.5 text-[11px] leading-snug text-muted">{sub}</p>}
        </div>
      </div>
    </Card>
  );
}

function BarRow({ label, count, total, tone }: { label: string; count: number; total: number; tone: Tone }) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="font-medium text-ink">{label}</span>
        <span className="tnum text-muted">
          {count} <span className="text-muted/70">· {pct}%</span>
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded-full bg-neutral-soft" role="img" aria-label={`${label}: ${count} of ${total}`}>
        <div className={clsx("h-full rounded-full transition-[width] duration-500", BAR[tone])} style={{ width: `${count > 0 ? Math.max(pct, 3) : 0}%` }} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ wards
function WardsCard({ wards, refresh }: { wards: AdminData["wards"]; refresh: () => void }) {
  const { busy, error, run } = useAction();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [cap, setCap] = useState("6");

  const saveCap = (id: string) =>
    run(async () => {
      const n = Number(draft[id]);
      if (!Number.isInteger(n) || n < 1) throw new Error("Capacity must be a whole number of at least 1.");
      await api("/api/admin", { body: { action: "setWardCapacity", wardId: id, capacity: n } });
      setDraft(({ [id]: _drop, ...rest }) => rest);
      refresh();
    });
  const addWard = () =>
    run(async () => {
      const n = Number(cap);
      if (!Number.isInteger(n) || n < 1) throw new Error("Capacity must be a whole number of at least 1.");
      await api("/api/admin", { body: { action: "addWard", name: name.trim(), capacity: n } });
      setName("");
      refresh();
    });

  return (
    <Card>
      <CardHeader title="Virtual wards & capacity" icon={<Building2 className="size-4" />} subtitle="Virtual beds in use against configured capacity" />
      <div className="space-y-4 px-5 pb-5">
        {wards.map((w) => {
          const pct = w.capacity > 0 ? Math.min(100, Math.round((w.occupied / w.capacity) * 100)) : 0;
          const editing = draft[w.id] !== undefined;
          return (
            <div key={w.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <p className="min-w-0 flex-1 text-sm font-semibold text-ink">{w.name}</p>
                <span className="tnum text-xs text-muted">
                  {w.occupied} of {w.capacity} beds · {Math.max(0, w.capacity - w.occupied)} free
                </span>
                <span className="flex items-center gap-1.5">
                  <Input
                    type="number"
                    min={1}
                    max={200}
                    aria-label={`Capacity for ${w.name}`}
                    className="tnum h-8 w-20"
                    value={draft[w.id] ?? String(w.capacity)}
                    onChange={(e) => setDraft((d) => ({ ...d, [w.id]: e.target.value }))}
                  />
                  <Button size="sm" disabled={!editing || busy || draft[w.id] === String(w.capacity)} onClick={() => saveCap(w.id)}>
                    Save
                  </Button>
                </span>
              </div>
              <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-neutral-soft" role="img" aria-label={`${w.name} occupancy ${pct}%`}>
                <div className={clsx("h-full rounded-full transition-[width] duration-500", pct >= 90 ? "bg-crit" : pct >= 70 ? "bg-warn" : "bg-teal")} style={{ width: `${pct}%` }} />
              </div>
            </div>
          );
        })}
        {wards.length === 0 && <Empty>No wards configured</Empty>}

        <form
          className="flex flex-wrap items-end gap-3 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            addWard();
          }}
        >
          <Field label="New ward name" className="min-w-48 flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Virtual Ward C — Cardiac" maxLength={80} />
          </Field>
          <Field label="Virtual beds" className="w-28">
            <Input type="number" min={1} max={200} className="tnum" value={cap} onChange={(e) => setCap(e.target.value)} />
          </Field>
          <Button type="submit" variant="primary" busy={busy} disabled={name.trim().length < 2}>
            Add ward
          </Button>
        </form>
        <ErrorNote>{error}</ErrorNote>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ staffing
function StaffingCard({ data, refresh }: { data: AdminData; refresh: () => void }) {
  const assign = useAction();
  const add = useAction();
  const [name, setName] = useState("");
  const [role, setRole] = useState<"DOCTOR" | "NURSE">("NURSE");
  const [title, setTitle] = useState("");
  const [added, setAdded] = useState<string | null>(null);
  const doctors = data.users.filter((u) => u.role === "DOCTOR");
  const nurses = data.users.filter((u) => u.role === "NURSE");
  const wardName = (id: string) => data.wards.find((w) => w.id === id)?.name.split(" — ")[0] ?? "—";

  const reassign = (patientId: string, patch: { doctorId?: string; nurseId?: string }) => assign.run(async () => (await api("/api/admin", { body: { action: "assign", patientId, ...patch } }), refresh()));
  const addClinician = () =>
    add.run(async () => {
      await api("/api/admin", { body: { action: "addClinician", name: name.trim(), role, title: title.trim() } });
      setAdded(`${name.trim()} added as ${role.toLowerCase()} — now available for assignment and on the sign-in screen.`);
      setName("");
      setTitle("");
      refresh();
    });

  return (
    <Card>
      <CardHeader title="Clinician assignments" icon={<Stethoscope className="size-4" />} subtitle="Who is covering which virtual beds" />
      <div className="px-5 pb-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-semibold">Clinician</th>
                <th className="py-2 pr-3 font-semibold">Role</th>
                <th className="py-2 pr-3 font-semibold">Assigned patients</th>
                <th className="py-2 text-right font-semibold">Open alerts</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.clinicians.map((c) => (
                <tr key={c.id} className="align-top">
                  <td className="py-2.5 pr-3">
                    <p className="font-medium text-ink">{c.name}</p>
                    <p className="text-[11px] text-muted">{c.title}</p>
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge tone={ROLE_TONE[c.role] ?? "muted"}>{roleLabel(c.role)}</Badge>
                  </td>
                  <td className="py-2.5 pr-3">
                    {c.patients.length === 0 ? (
                      <span className="text-xs text-muted">No patients assigned</span>
                    ) : (
                      <ul className="space-y-1">
                        {c.patients.map((p) => (
                          <li key={p.id} className="flex flex-wrap items-center gap-1.5 text-xs text-ink">
                            <span className="font-medium">{p.name}</span>
                            <span className="tnum text-muted">· {p.room}</span>
                            {p.state && <Badge tone={STATE_META[p.state].tone}>{STATE_META[p.state].label}</Badge>}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                  <td className="tnum py-2.5 text-right">
                    {c.openAlerts > 0 ? <Badge tone="warn">{c.openAlerts}</Badge> : <span className="text-xs text-muted">0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <h4 className="mt-6 text-xs font-semibold text-ink">Reassign care team</h4>
        <p className="text-[11px] text-muted">Changes apply immediately and are written to the activity log.</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-semibold">Patient (synthetic)</th>
                <th className="py-2 pr-3 font-semibold">Ward · room</th>
                <th className="py-2 pr-3 font-semibold">Doctor</th>
                <th className="py-2 font-semibold">Nurse</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {data.patients.map((p) => (
                <tr key={p.id}>
                  <td className="py-2 pr-3">
                    <p className="font-medium text-ink">{p.name}</p>
                    <p className="tnum text-[11px] text-muted">{p.mrn}</p>
                  </td>
                  <td className="tnum py-2 pr-3 text-xs text-muted">
                    {wardName(p.wardId)} · {p.room}
                  </td>
                  <td className="py-2 pr-3">
                    <Select className="h-8 min-w-40 text-xs" aria-label={`Doctor for ${p.name}`} disabled={assign.busy} value={p.doctorId ?? ""} onChange={(e) => e.target.value && reassign(p.id, { doctorId: e.target.value })}>
                      {!p.doctorId && <option value="">Unassigned</option>}
                      {doctors.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="py-2">
                    <Select className="h-8 min-w-40 text-xs" aria-label={`Nurse for ${p.name}`} disabled={assign.busy} value={p.nurseId ?? ""} onChange={(e) => e.target.value && reassign(p.id, { nurseId: e.target.value })}>
                      {!p.nurseId && <option value="">Unassigned</option>}
                      {nurses.map((n) => (
                        <option key={n.id} value={n.id}>
                          {n.name}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorNote className="mt-2">{assign.error}</ErrorNote>

        <form
          className="mt-6 flex flex-wrap items-end gap-3 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            addClinician();
          }}
        >
          <span className="flex w-full items-center gap-1.5 text-xs font-semibold text-ink">
            <UserPlus className="size-3.5 text-primary" aria-hidden /> Add clinician
          </span>
          <Field label="Full name" className="min-w-44 flex-1">
            <Input value={name} onChange={(e) => (setAdded(null), setName(e.target.value))} placeholder="Dr. Alex Morgan" maxLength={80} />
          </Field>
          <Field label="Role" className="w-32">
            <Select value={role} onChange={(e) => setRole(e.target.value as "DOCTOR" | "NURSE")}>
              <option value="NURSE">Nurse</option>
              <option value="DOCTOR">Doctor</option>
            </Select>
          </Field>
          <Field label="Title (optional)" className="min-w-40 flex-1">
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Virtual ward nurse" maxLength={80} />
          </Field>
          <Button type="submit" variant="primary" busy={add.busy} disabled={name.trim().length < 2}>
            Add clinician
          </Button>
        </form>
        <ErrorNote className="mt-2">{add.error}</ErrorNote>
        {added && <p className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-xs font-medium text-ok">{added}</p>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ defaults
const LIMIT_KEYS = ["critLow", "warnLow", "warnHigh", "critHigh"] as const;
const LIMIT_HEAD: Record<(typeof LIMIT_KEYS)[number], string> = { critLow: "Critical below", warnLow: "Review below", warnHigh: "Review above", critHigh: "Critical above" };

function DefaultsCard({ defaults, refresh }: { defaults: AdminData["defaults"]; refresh: () => void }) {
  const { busy, error, run } = useAction();
  const [draft, setDraft] = useState<Partial<Record<ThresholdVital, Record<string, string>>>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const shown = (vital: ThresholdVital, key: (typeof LIMIT_KEYS)[number]) => draft[vital]?.[key] ?? (defaults[vital]?.[key] != null ? String(defaults[vital][key]) : "");
  const edit = (vital: ThresholdVital, key: string, value: string) => {
    setSaved(null);
    setDraft((d) => {
      const base = d[vital] ?? Object.fromEntries(LIMIT_KEYS.map((k) => [k, defaults[vital]?.[k] != null ? String(defaults[vital][k]) : ""]));
      return { ...d, [vital]: { ...base, [key]: value } };
    });
  };
  const save = (vital: ThresholdVital) =>
    run(async () => {
      const row = draft[vital];
      if (!row) return;
      const body: Record<string, unknown> = { action: "setDefault", vital };
      for (const k of LIMIT_KEYS) {
        const raw = row[k].trim();
        if (raw === "") body[k] = null;
        else if (Number.isNaN(Number(raw))) throw new Error(`${LIMIT_HEAD[k]} for ${THRESHOLD_VITALS[vital].label} must be a number or left blank.`);
        else body[k] = Number(raw);
      }
      await api("/api/admin", { body });
      setDraft(({ [vital]: _drop, ...rest }) => rest);
      setSaved(`${THRESHOLD_VITALS[vital].label} programme default saved.`);
      refresh();
    });

  return (
    <Card>
      <CardHeader title="Demo monitoring defaults" icon={<SlidersHorizontal className="size-4" />} subtitle="Programme-wide limits used by the rule-based alert engine" />
      <div className="px-5 pb-5">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] font-semibold uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-semibold">Vital sign</th>
                {LIMIT_KEYS.map((k) => (
                  <th key={k} className={clsx("py-2 pr-2 font-semibold", k.startsWith("crit") ? "text-crit" : "text-warn")}>
                    {LIMIT_HEAD[k]}
                  </th>
                ))}
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(Object.keys(THRESHOLD_VITALS) as ThresholdVital[]).map((vital) => (
                <tr key={vital}>
                  <td className="py-2 pr-3">
                    <p className="font-medium text-ink">{THRESHOLD_VITALS[vital].label}</p>
                    <p className="text-[11px] text-muted">{THRESHOLD_VITALS[vital].unit}</p>
                  </td>
                  {LIMIT_KEYS.map((k) => (
                    <td key={k} className="py-2 pr-2">
                      <Input
                        type="number"
                        step={THRESHOLD_VITALS[vital].step}
                        inputMode="decimal"
                        placeholder="—"
                        aria-label={`${THRESHOLD_VITALS[vital].label} ${LIMIT_HEAD[k].toLowerCase()}`}
                        className="tnum h-8 w-24"
                        value={shown(vital, k)}
                        onChange={(e) => edit(vital, k, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className="py-2 text-right">
                    <Button size="sm" variant={draft[vital] ? "primary" : "secondary"} disabled={!draft[vital] || busy} onClick={() => save(vital)}>
                      Save
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <ErrorNote className="mt-2">{error}</ErrorNote>
        {saved && <p className="mt-2 rounded-lg bg-ok-soft px-3 py-2 text-xs font-medium text-ok">{saved}</p>}
        <p className="mt-3 text-[11px] leading-relaxed text-muted">Demo monitoring limits — not clinical guidance. Doctors can override per patient. Leave a box blank for no limit on that side.</p>
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ log
function LogCard({ logs }: { logs: AdminData["logs"] }) {
  const [role, setRole] = useState("ALL");
  const roles = useMemo(() => Array.from(new Set(logs.map((l) => l.role))).sort(), [logs]);
  const rows = role === "ALL" ? logs : logs.filter((l) => l.role === role);
  return (
    <Card>
      <CardHeader
        title="Access & activity log"
        icon={<ScrollText className="size-4" />}
        subtitle={`Latest ${logs.length} recorded events — sign-ins, record access and clinician actions`}
        action={
          <Select className="h-8 w-44 text-xs" aria-label="Filter log by role" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="ALL">All roles</option>
            {roles.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </Select>
        }
      />
      <div className="px-5 pb-5">
        <p className="mb-3 flex items-start gap-2 rounded-lg bg-neutral-soft px-3 py-2 text-[11px] leading-relaxed text-muted">
          <ShieldCheck className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>Administrators see operational data only. Clinical record content — notes, readings and AI summaries — is not available to this role; the server refuses those requests.</span>
        </p>
        {rows.length === 0 ? (
          <Empty>No log entries for this role</Empty>
        ) : (
          <div className="max-h-[440px] overflow-auto rounded-xl border border-line">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface-2">
                <tr className="text-[11px] font-semibold uppercase tracking-wide text-muted">
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Who</th>
                  <th className="px-3 py-2 font-semibold">Role</th>
                  <th className="px-3 py-2 font-semibold">Action</th>
                  <th className="px-3 py-2 font-semibold">Detail</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((l) => (
                  <tr key={l.id} className="align-top">
                    <td className="tnum whitespace-nowrap px-3 py-2 text-xs text-muted">{dateTime(l.at)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs font-medium text-ink">{l.who}</td>
                    <td className="px-3 py-2">
                      <Badge tone={ROLE_TONE[l.role] ?? "muted"}>{roleLabel(l.role)}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs font-medium text-ink">{humanise(l.action)}</td>
                    <td className="px-3 py-2 text-xs leading-relaxed text-muted">{l.detail || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ page
export function AdminClient() {
  const { data, error, loading, refresh } = useLive<AdminData>("/api/admin", 3000);
  if (!data) return loading ? <PageLoading /> : <PageError message={error?.message ?? "No data returned"} onRetry={refresh} />;

  const k = data.kpis;
  const stateTotal = Object.values(data.states).reduce((a, b) => a + b, 0);
  const kindTotal = Object.values(data.alertsByKind).reduce((a, b) => a + b, 0);
  const kinds = Object.entries(data.alertsByKind).sort((a, b) => b[1] - a[1]);
  const aiLabel =
    data.aiProvider === "deterministic"
      ? "Built-in rule-based summariser (no external AI key configured)"
      : data.aiProvider === "bedrock"
        ? "Amazon Bedrock (falls back to the built-in summariser on any error)"
        : data.aiProvider === "openai"
          ? "OpenAI (falls back to the built-in summariser on any error)"
          : data.aiProvider;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Hospital-at-home operations</h1>
          <p className="mt-1 text-sm text-muted">Capacity, staffing and alert performance across the virtual wards. All figures are calculated from synthetic demo records.</p>
        </div>
        <p className="flex items-center gap-1.5 rounded-full bg-neutral-soft px-3 py-1.5 text-[11px] font-medium text-muted">
          <Sparkles className="size-3.5 text-teal" aria-hidden /> AI engine: {aiLabel}
        </p>
      </div>

      {error && <ErrorNote>{error.message} Showing the last data received.</ErrorNote>}

      <SimControls sim={data.sim} onChange={refresh} />

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi icon={<Users className="size-4" />} label="Admitted virtual patients" value={k.admitted} sub="Currently on a hospital-at-home pathway" />
        <Kpi icon={<BedDouble className="size-4" />} label="Active virtual beds" value={<>{k.activeBeds} <span className="text-base font-semibold text-muted">/ {k.capacity}</span></>} sub={`${k.capacity > 0 ? Math.round((k.activeBeds / k.capacity) * 100) : 0}% of configured capacity in use`} />
        <Kpi icon={<Gauge className="size-4" />} label="Available capacity" value={k.available} sub="Virtual beds free across all wards" tone="teal" />
        <Kpi
          icon={<Activity className="size-4" />}
          label="Patients currently monitored"
          value={<>{k.monitored} <span className="text-base font-semibold text-muted">of {k.admitted}</span></>}
          sub={k.monitored < k.admitted ? `${k.admitted - k.monitored} with no recent data or a disconnected device` : "All patients have recent data"}
          tone={k.monitored < k.admitted ? "warn" : "ok"}
        />
        <Kpi icon={<Bell className="size-4" />} label="Active alerts" value={k.activeAlerts} sub={k.criticalAlerts > 0 ? `${k.criticalAlerts} critical demo alert${k.criticalAlerts > 1 ? "s" : ""}` : "No critical alerts open"} tone={k.criticalAlerts > 0 ? "crit" : k.activeAlerts > 0 ? "warn" : "ok"} />
        <Kpi icon={<CalendarX className="size-4" />} label="Overdue check-ins" value={k.overdueCheckIns} sub="Scheduled observations not yet received" tone={k.overdueCheckIns > 0 ? "warn" : "ok"} />
        <Kpi icon={<Timer className="size-4" />} label="Average alert response time" value={duration(k.avgAckSeconds)} sub={`Raised → acknowledged, from ${k.ackSample} acknowledged alert${k.ackSample === 1 ? "" : "s"} in demo records`} tone="info" />
        <Kpi icon={<Hourglass className="size-4" />} label="Average time to resolve" value={duration(k.avgResolveSeconds)} sub={`Raised → resolved by a clinician, from ${k.resolveSample} alert${k.resolveSample === 1 ? "" : "s"}`} tone="info" />
        <Kpi icon={<ClipboardList className="size-4" />} label="Alerts in the last 24 h" value={k.alerts24h} sub="All rule-based alerts raised, any status" />
      </div>

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-1">
          <WardsCard wards={data.wards} refresh={refresh} />
        </div>
        <Card>
          <CardHeader title="Monitoring status" icon={<Activity className="size-4" />} subtitle="Where every admitted patient stands right now" />
          <div className="space-y-3 px-5 pb-5">
            {STATE_PRIORITY.map((s) => (
              <BarRow key={s} label={STATE_META[s].label} count={data.states[s] ?? 0} total={stateTotal} tone={STATE_META[s].tone} />
            ))}
            <p className="pt-1 text-[11px] leading-relaxed text-muted">Missing or stale data is never counted as stable.</p>
          </div>
        </Card>
        <Card>
          <CardHeader title="Alerts by type" icon={<Bell className="size-4" />} subtitle="Raised in the last 24 hours" />
          <div className="space-y-3 px-5 pb-5">
            {kinds.length === 0 ? <Empty>No alerts raised in the last 24 hours</Empty> : kinds.map(([kind, n]) => <BarRow key={kind} label={KIND_LABEL[kind] ?? humanise(kind)} count={n} total={kindTotal} tone={kind === "THRESHOLD" ? "warn" : kind === "CONNECTIVITY" || kind === "CHECKIN_OVERDUE" ? "muted" : kind === "RHYTHM_FLAG" ? "crit" : kind === "TREND" ? "info" : "primary"} />)}
          </div>
        </Card>
      </div>

      <StaffingCard data={data} refresh={refresh} />
      <DefaultsCard defaults={data.defaults} refresh={refresh} />
      <LogCard logs={data.logs} />
    </div>
  );
}
