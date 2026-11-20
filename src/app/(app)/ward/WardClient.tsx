"use client";
import clsx from "clsx";
import { ArrowRight, BedDouble, BellRing, CalendarX, CircleAlert, Clock, HeartPulse, PenLine, PlugZap, Radio, Stethoscope, Syringe, Unplug, UsersRound, Watch, Ambulance } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AlertList, type AlertDto } from "@/components/AlertList";
import { Sparkline } from "@/components/EcgMonitor";
import { SimControls, type SimDto } from "@/components/SimControls";
import { Badge, Card, CardHeader, Empty, PageError, PageLoading, Select, StatePill, TONE_BORDER } from "@/components/ui";
import { clock, timeAgo, useLive } from "@/lib/client";
import { STATE_META, STATE_PRIORITY, VITALS, formatVital, type LatestMap, type MonitoringState, type Role, type VitalType } from "@/lib/types";

type Who = { id: string; name: string; role: string } | null;
type PatientCard = {
  id: string;
  mrn: string;
  name: string;
  age: number;
  sex: string;
  condition: string;
  room: string;
  wardId: string;
  wardName: string;
  doctor: Who;
  nurse: Who;
  lastContactAt: string | null;
  lastReadingAt: string | null;
  nextCheckInDueAt: string | null;
  checkInOverdue: boolean;
  latest: LatestMap;
  connectivity: "CONNECTED" | "PARTIAL" | "DISCONNECTED" | "MANUAL";
  wearableLinks?: { name: string; lastSyncAt: string | null }[];
  transfer?: { status: string; statusLabel: string; open: boolean; priority: string; destination: string; directAdmission: boolean; unitStatus: string; etaAt: string | null; etaKind: string | null; incidentRef: string | null } | null;
  state: MonitoringState;
  stateReason: string;
  openAlerts: number;
  criticalAlerts: number;
  topAlert: string | null;
  spark: { HR: number[]; SPO2: number[] };
};
type WardData = {
  me: { id: string; name: string; role: Role };
  sim: SimDto;
  now: string;
  wards: { id: string; name: string }[];
  clinicians: { id: string; name: string; role: string }[];
  patients: PatientCard[];
  alerts: AlertDto[];
};

const FILTERS = [
  { id: "all", label: "All patients" },
  { id: "attention", label: "Needs attention" },
  { id: "critical", label: "Critical alerts" },
  { id: "missing", label: "Missing readings" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

const match: Record<FilterId, (p: PatientCard) => boolean> = {
  all: () => true,
  attention: (p) => p.state !== "STABLE",
  critical: (p) => p.state === "CRITICAL",
  missing: (p) => p.state === "NO_RECENT_DATA" || p.state === "DEVICE_DISCONNECTED",
};

const CARD_VITALS: VitalType[] = ["HR", "SPO2", "BP", "RR", "TEMP", "GLUCOSE"];

function Connectivity({ c }: { c: PatientCard["connectivity"] }) {
  if (c === "CONNECTED") return <span className="inline-flex items-center gap-1 text-teal"><PlugZap className="size-3.5" /> Devices transmitting</span>;
  if (c === "PARTIAL") return <span className="inline-flex items-center gap-1 text-warn"><PlugZap className="size-3.5" /> Some devices offline</span>;
  if (c === "DISCONNECTED") return <span className="inline-flex items-center gap-1 font-semibold text-crit"><Unplug className="size-3.5" /> Device disconnected</span>;
  return <span className="inline-flex items-center gap-1 text-muted"><PenLine className="size-3.5" /> Manual check-ins</span>;
}

function PatientCardView({ p, now }: { p: PatientCard; now: string }) {
  const tone = STATE_META[p.state].tone;
  // Old values must never look current.
  const stale = p.state === "DEVICE_DISCONNECTED" || p.state === "NO_RECENT_DATA";
  const vitals = CARD_VITALS.filter((v) => p.latest[v]).slice(0, 5);
  return (
    <Card className={clsx("fade-up flex flex-col border-l-4 transition-shadow hover:shadow-lg", TONE_BORDER[tone])}>
      <div className="flex items-start justify-between gap-3 px-4 pt-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[15px] font-semibold leading-tight text-ink">{p.name}</h3>
            <Badge tone="primary">
              <BedDouble className="size-3" aria-hidden /> {p.room}
            </Badge>
          </div>
          <p className="tnum mt-0.5 text-[11px] text-muted">
            {p.mrn} · synthetic · {p.age} y · {p.sex}
          </p>
        </div>
        {p.openAlerts > 0 && (
          <Badge tone={p.criticalAlerts ? "crit" : "warn"} title={`${p.openAlerts} open alert${p.openAlerts > 1 ? "s" : ""}`}>
            <BellRing className="size-3" aria-hidden /> {p.openAlerts}
          </Badge>
        )}
      </div>
      <p className="mt-2 line-clamp-1 px-4 text-xs text-muted" title={p.condition}>
        {p.condition}
      </p>
      <div className="mt-2.5 px-4">
        <StatePill state={p.state} />
        <p className="mt-1.5 text-xs leading-snug text-muted">{p.topAlert && p.state !== "STABLE" ? p.topAlert : p.stateReason}</p>
        {p.transfer && (
          <p className={clsx("mt-2 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11px] font-medium leading-snug", p.transfer.open ? "bg-crit-soft text-crit" : "bg-neutral-soft text-muted")}>
            <Ambulance className="mt-px size-3.5 shrink-0" aria-hidden />
            <span>
              {p.transfer.statusLabel} → {p.transfer.destination}
              {p.transfer.open && p.transfer.etaAt ? ` · ETA ${clock(p.transfer.etaAt)}` : ""}
              {p.transfer.unitStatus === "ACCEPTED" && p.transfer.directAdmission ? " · direct admission" : p.transfer.unitStatus === "DECLINED" ? " · unit declined → ED" : ""}
            </span>
          </p>
        )}
      </div>

      <div className={clsx("mx-4 mt-3 rounded-xl bg-surface-2 p-3", stale && "opacity-70")}>
        {stale && (
          <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold text-muted">
            <CircleAlert className="size-3.5" aria-hidden /> Last received values — not current
          </p>
        )}
        {vitals.length === 0 ? (
          <p className="py-2 text-center text-xs text-muted">No readings on record</p>
        ) : (
          <dl className="grid grid-cols-3 gap-x-3 gap-y-2.5">
            {vitals.map((v) => {
              const l = p.latest[v]!;
              return (
                <div key={v}>
                  <dt className="text-[10px] font-semibold uppercase tracking-wide text-muted">{VITALS[v].short}</dt>
                  <dd className={clsx("tnum text-base font-bold leading-tight", stale ? "text-muted" : "text-ink")}>
                    {formatVital(v, l.v, l.v2)}
                    <span className="ml-0.5 text-[10px] font-medium text-muted">{VITALS[v].unit === "breaths/min" ? "/min" : VITALS[v].unit}</span>
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
        {p.spark.SPO2.length > 1 && (
          <div className="mt-2.5 grid grid-cols-2 gap-3 border-t border-line pt-2">
            <div>
              <span className="text-[10px] text-muted">HR trend</span>
              <Sparkline values={p.spark.HR} color={stale ? "var(--muted)" : VITALS.HR.color} />
            </div>
            <div>
              <span className="text-[10px] text-muted">SpO₂ trend</span>
              <Sparkline values={p.spark.SPO2} color={stale ? "var(--muted)" : "var(--primary)"} max={100} />
            </div>
          </div>
        )}
      </div>

      <div className="mt-3 space-y-1 px-4 text-[11px] text-muted">
        <p className="flex items-center justify-between gap-2">
          <Connectivity c={p.connectivity} />
          <span className="tnum inline-flex items-center gap-1" title={p.lastReadingAt ? clock(p.lastReadingAt, true) : ""}>
            <Radio className="size-3" aria-hidden /> Last reading {timeAgo(p.lastReadingAt, now)}
          </span>
        </p>
        {p.wearableLinks?.map((w) => (
          <p key={w.name} className="flex items-center justify-between gap-2">
            <span className="inline-flex min-w-0 items-center gap-1 truncate">
              <Watch className="size-3.5 shrink-0 text-primary" aria-hidden /> {w.name}
            </span>
            <span className="tnum shrink-0">{w.lastSyncAt ? `synced ${timeAgo(w.lastSyncAt, now)}` : "awaiting first sync"}</span>
          </p>
        ))}
        <p className="flex items-center justify-between gap-2">
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <Stethoscope className="size-3 shrink-0" aria-hidden /> {p.doctor?.name ?? "Unassigned"}
          </span>
          <span className="inline-flex min-w-0 items-center gap-1 truncate">
            <Syringe className="size-3 shrink-0" aria-hidden /> {p.nurse?.name ?? "Unassigned"}
          </span>
        </p>
        <p className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden /> Last contact {timeAgo(p.lastContactAt, now)}
          </span>
          {p.nextCheckInDueAt && (
            <span className={clsx("inline-flex items-center gap-1", p.checkInOverdue && "font-semibold text-crit")}>
              <CalendarX className="size-3" aria-hidden /> Check-in {p.checkInOverdue ? `overdue (${clock(p.nextCheckInDueAt)})` : `due ${clock(p.nextCheckInDueAt)}`}
            </span>
          )}
        </p>
      </div>

      <Link href={`/patients/${p.id}`} className="mt-3 flex items-center justify-between rounded-b-2xl border-t border-line px-4 py-2.5 text-xs font-semibold text-primary hover:bg-primary-soft">
        Open bedside view <ArrowRight className="size-3.5" />
      </Link>
    </Card>
  );
}

function Kpi({ icon, label, value, tone, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; tone: string; sub?: string }) {
  return (
    <Card className="flex items-center gap-3 p-4">
      <span className={clsx("flex size-10 shrink-0 items-center justify-center rounded-xl", tone)}>{icon}</span>
      <div className="min-w-0">
        <p className="tnum text-2xl font-bold leading-none text-ink">{value}</p>
        <p className="mt-1 text-xs leading-tight text-muted">{label}</p>
        {sub && <p className="truncate text-[10px] text-muted">{sub}</p>}
      </div>
    </Card>
  );
}

export function WardClient() {
  const { data, error, loading, refresh } = useLive<WardData>("/api/ward", 2000);
  const [filter, setFilter] = useState<FilterId>("all");
  const [clinician, setClinician] = useState("all");
  const [ward, setWard] = useState("all");

  const shown = useMemo(() => {
    if (!data) return [];
    return data.patients
      .filter(match[filter])
      .filter((p) => ward === "all" || p.wardId === ward)
      .filter((p) => {
        if (clinician === "all") return true;
        const id = clinician === "me" ? data.me.id : clinician;
        return p.doctor?.id === id || p.nurse?.id === id;
      })
      .sort((a, b) => STATE_PRIORITY.indexOf(a.state) - STATE_PRIORITY.indexOf(b.state) || a.room.localeCompare(b.room));
  }, [data, filter, clinician, ward]);

  if (loading && !data) return <PageLoading />;
  if (!data) return <PageError message={error?.message ?? "No data"} onRetry={refresh} />;

  const count = (f: FilterId) => data.patients.filter(match[f]).length;
  const critical = data.alerts.filter((a) => a.severity === "CRITICAL").length;
  const monitored = data.patients.filter((p) => p.state !== "NO_RECENT_DATA" && p.state !== "DEVICE_DISCONNECTED").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Virtual ward</h1>
          <p className="mt-0.5 text-sm text-muted">
            {data.patients.length} patients at home · {count("attention")} need attention · updated {clock(data.now, true)}
          </p>
        </div>
        <div className="xl:min-w-[640px]">
          <SimControls sim={data.sim} onChange={refresh} compact />
        </div>
      </div>

      {error && <p className="rounded-xl bg-warn-soft px-4 py-2 text-xs font-medium text-warn">Connection problem — showing the last data received ({error.message})</p>}
      {!data.sim.running && (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-line bg-surface px-4 py-2.5 text-xs text-muted">
          <CircleAlert className="size-4 shrink-0 text-warn" aria-hidden />
          The simulator is paused, so no new readings are arriving. Readings are frozen at {clock(data.sim.pausedAt, true)}. Press <b className="font-semibold text-ink">Start simulation</b> to stream live synthetic vitals.
        </p>
      )}

      {data.patients.filter((p) => p.transfer?.open).map((p) => (
        <Link key={p.id} href={`/patients/${p.id}`} className="flex flex-wrap items-center gap-3 rounded-2xl border-2 border-crit bg-crit-soft px-4 py-3 hover:brightness-[0.98]">
          <Ambulance className="size-5 shrink-0 text-crit" aria-hidden />
          <span className="min-w-0 flex-1 text-sm text-ink">
            <b className="font-semibold">{p.name}</b> — {p.transfer!.statusLabel.toLowerCase()} ({p.transfer!.priority === "EMERGENCY" ? "emergency" : "urgent"}) → {p.transfer!.destination}
            {p.transfer!.etaAt ? `, ETA ${clock(p.transfer!.etaAt)}` : ""}
            {p.transfer!.incidentRef ? ` · ${p.transfer!.incidentRef}` : ""}
          </span>
          <span className="text-xs font-semibold text-crit">Open tracker →</span>
        </Link>
      ))}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<UsersRound className="size-5" />} tone="bg-primary-soft text-primary" value={`${monitored}/${data.patients.length}`} label="Patients with current data" />
        <Kpi icon={<HeartPulse className="size-5" />} tone="bg-warn-soft text-warn" value={count("attention")} label="Need attention" />
        <Kpi icon={<BellRing className="size-5" />} tone="bg-crit-soft text-crit" value={critical} label="Critical demo alerts" sub={`${data.alerts.length} active alerts in total`} />
        <Kpi icon={<Unplug className="size-5" />} tone="bg-neutral-soft text-muted" value={count("missing")} label="Missing readings / disconnected" />
      </div>

      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter patients">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                  className={clsx(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
                    filter === f.id ? "border-primary bg-primary text-white dark:text-[#06131f]" : "border-line bg-surface text-muted hover:text-ink",
                  )}
                >
                  {f.label}
                  <span className={clsx("tnum rounded-full px-1.5 text-[10px] leading-4", filter === f.id ? "bg-white/25" : "bg-neutral-soft")}>{count(f.id)}</span>
                </button>
              ))}
            </div>
            <div className="ml-auto flex gap-2">
              <Select aria-label="Assigned clinician" value={clinician} onChange={(e) => setClinician(e.target.value)} className="h-8 w-44 text-xs">
                <option value="all">All clinicians</option>
                <option value="me">Assigned to me</option>
                {data.clinicians.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
              <Select aria-label="Ward" value={ward} onChange={(e) => setWard(e.target.value)} className="h-8 w-40 text-xs">
                <option value="all">All wards</option>
                {data.wards.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name.split(" — ")[0]}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          {shown.length === 0 ? (
            <Card>
              <Empty icon={<BedDouble className="size-7" />}>No patients match these filters.</Empty>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {shown.map((p) => (
                <PatientCardView key={p.id} p={p} now={data.now} />
              ))}
            </div>
          )}
        </div>

        <Card className="h-fit xl:sticky xl:top-[76px]">
          <CardHeader
            icon={<BellRing className="size-4" />}
            title="Alert queue"
            subtitle={data.alerts.length ? `${data.alerts.filter((a) => a.status === "OPEN").length} waiting for acknowledgement` : "Rule-based alerts appear here"}
            action={
              <Link href="/alerts" className="text-xs font-semibold text-primary hover:underline">
                View all
              </Link>
            }
          />
          <div className="max-h-[70vh] overflow-y-auto px-4 pb-4">
            <AlertList alerts={data.alerts} role={data.me.role} now={data.now} onChange={refresh} dense empty="No active alerts. New alerts appear here as readings cross configured limits." />
          </div>
        </Card>
      </div>
    </div>
  );
}
