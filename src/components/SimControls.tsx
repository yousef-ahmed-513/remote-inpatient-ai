"use client";
import clsx from "clsx";
import { Activity, ChevronDown, HeartPulse, Pause, Play, RotateCcw, SkipForward, Unplug, PlugZap, CalendarX, Wind } from "lucide-react";
import { useState } from "react";
import { api, clock, useAction } from "@/lib/client";
import { Button, Card, ErrorNote } from "./ui";

export type SimDto = { running: boolean; speed: number; tick: number; lastTickAt: string | null; pausedAt: string | null; seededAt: string };

const TRIGGERS = [
  { id: "RESP", label: "Respiratory deterioration", who: "Samuel Okoro", icon: Wind },
  { id: "CARDIAC", label: "Simulated irregular rhythm", who: "Layla Haddad", icon: HeartPulse },
  { id: "DISCONNECT", label: "Disconnect device", who: "Thomas Berg", icon: Unplug },
  { id: "RECONNECT", label: "Reconnect device", who: "Thomas Berg", icon: PlugZap },
  { id: "MISSED_CHECKIN", label: "Miss scheduled check-in", who: "Priya Nair", icon: CalendarX },
] as const;

/** Demo controls for the synthetic vital-sign simulator. */
export function SimControls({ sim, onChange, compact }: { sim: SimDto; onChange: () => void; compact?: boolean }) {
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const send = (body: Record<string, unknown>) => run(async () => (await api("/api/sim", { body }), onChange()));

  return (
    <Card className={clsx("relative", compact ? "p-3" : "p-4")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-2">
          <span className={clsx("flex size-8 items-center justify-center rounded-lg", sim.running ? "bg-teal-soft text-teal" : "bg-neutral-soft text-muted")}>
            <Activity className="size-4" aria-hidden />
          </span>
          <div className="leading-tight">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink">
              Vital-sign simulator
              <span className={clsx("inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[10px] font-bold", sim.running ? "bg-teal-soft text-teal" : "bg-warn-soft text-warn")}>
                <span className={clsx("size-1.5 rounded-full bg-current", sim.running && "live-dot")} />
                {sim.running ? "LIVE" : "PAUSED"}
              </span>
            </div>
            <div className="tnum text-[11px] text-muted">
              {sim.running ? `Tick ${sim.tick} · new readings every ${(3 / sim.speed).toFixed(1)} s` : `Readings frozen at ${clock(sim.pausedAt, true)} · tick ${sim.tick}`}
            </div>
          </div>
        </div>

        <div className="ml-auto flex flex-wrap items-center gap-1.5">
          {sim.running ? (
            <Button size="sm" busy={busy} onClick={() => send({ action: "pause" })}>
              <Pause className="size-3.5" /> Pause
            </Button>
          ) : (
            <Button size="sm" variant="teal" busy={busy} onClick={() => send({ action: "start" })}>
              <Play className="size-3.5" /> Start simulation
            </Button>
          )}
          <Button size="sm" disabled={busy} onClick={() => send({ action: "step" })} title="Generate one set of readings now">
            <SkipForward className="size-3.5" /> Step
          </Button>
          <div className="flex overflow-hidden rounded-lg border border-line" role="group" aria-label="Simulation speed">
            {[1, 2, 5].map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => send({ action: "speed", speed: s })}
                aria-pressed={sim.speed === s}
                className={clsx("tnum h-8 px-2.5 text-xs font-semibold", sim.speed === s ? "bg-primary text-white dark:text-[#06131f]" : "bg-surface text-muted hover:bg-surface-2")}
              >
                ×{s}
              </button>
            ))}
          </div>
          <div className="relative">
            <Button size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
              Scenarios <ChevronDown className="size-3.5" />
            </Button>
            {open && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
                <div className="fade-up absolute right-0 z-30 mt-1.5 w-72 rounded-xl border border-line bg-surface p-1.5 shadow-2xl">
                  <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium text-muted">Trigger a scripted scenario now</p>
                  {TRIGGERS.map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => (setOpen(false), send({ action: "trigger", scenario: t.id }))}
                      className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-2"
                    >
                      <t.icon className="size-4 shrink-0 text-primary" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold text-ink">{t.label}</span>
                        <span className="block text-[11px] text-muted">{t.who} · synthetic</span>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {confirmReset ? (
            <span className="flex items-center gap-1">
              <Button size="sm" variant="danger" busy={busy} onClick={() => send({ action: "reset" }).then(() => setConfirmReset(false))}>
                Confirm reset
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                Cancel
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => setConfirmReset(true)} title="Wipe demo activity and restore the starting dataset">
              <RotateCcw className="size-3.5" /> Reset demo
            </Button>
          )}
        </div>
      </div>
      <ErrorNote className="mt-2">{error}</ErrorNote>
    </Card>
  );
}
