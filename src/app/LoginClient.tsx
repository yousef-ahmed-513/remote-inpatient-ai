"use client";
import clsx from "clsx";
import { Activity, ArrowRight, BellRing, HeartHandshake, LayoutDashboard, ShieldCheck, Sparkles, Stethoscope, Syringe, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/AppShell";
import { Logo } from "@/components/Logo";
import { Button, ErrorNote, Skeleton } from "@/components/ui";
import { api, initials, useAction } from "@/lib/client";
import { ROLE_HOME, type Role } from "@/lib/types";

type DemoUser = { id: string; name: string; role: Role; title: string };

const ROLES: { role: Role; label: string; blurb: string; icon: typeof Stethoscope }[] = [
  { role: "DOCTOR", label: "Doctor", blurb: "Review patients, ECG, AI summaries and escalations", icon: Stethoscope },
  { role: "NURSE", label: "Nurse", blurb: "Monitor the ward, work the alert queue, record check-ins", icon: Syringe },
  { role: "PATIENT", label: "Patient", blurb: "See your readings, send check-ins, message your team", icon: UserRound },
  { role: "CAREGIVER", label: "Caregiver", blurb: "Restricted overview and help with check-ins", icon: HeartHandshake },
  { role: "ADMIN", label: "Administrator", blurb: "Capacity, staffing, response times and access logs", icon: LayoutDashboard },
];

const POINTS = [
  { icon: Activity, title: "Live virtual ward", text: "Continuous simulated vitals and ECG for every virtual bed." },
  { icon: BellRing, title: "Clinician-configured alerts", text: "Rule-based limits with acknowledge, escalate and resolve." },
  { icon: Sparkles, title: "AI-assisted summaries", text: "Summarises recorded data for clinicians — never diagnoses." },
  { icon: ShieldCheck, title: "Role-based access", text: "Permissions are enforced on the server for every request." },
];

function EcgBackdrop() {
  // Decorative pulse line (artificial).
  const beat = "l14 0 l5 -9 l6 9 l8 0 l4 7 l7 -62 l7 78 l6 -23 l12 0 l9 -13 l10 13 l32 0";
  return (
    <svg viewBox="0 0 720 160" className="absolute inset-x-0 bottom-24 w-full opacity-20" preserveAspectRatio="none" aria-hidden>
      <path d={`M0 100 ${beat} ${beat} ${beat} ${beat} ${beat} ${beat}`} fill="none" stroke="#5EEAD4" strokeWidth="2" strokeLinejoin="round" />
    </svg>
  );
}

export function LoginClient() {
  const router = useRouter();
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [role, setRole] = useState<Role>("NURSE");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const { error, run } = useAction();

  useEffect(() => {
    api<{ users: DemoUser[] }>("/api/auth")
      .then((d) => setUsers(d.users))
      .catch((e) => setLoadError(e.message ?? "Could not load demo accounts"));
  }, []);

  const signIn = (u: DemoUser) => {
    setPending(u.id);
    run(async () => {
      await api("/api/auth", { body: { userId: u.id } });
      router.push(ROLE_HOME[u.role]);
      router.refresh();
    }).then((ok) => !ok && setPending(null));
  };

  const list = (users ?? []).filter((u) => u.role === role);
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.05fr_1fr]">
      {/* Brand panel */}
      <section className="relative hidden overflow-hidden bg-[#0d3b70] p-12 text-white lg:flex lg:flex-col">
        <div className="flex items-center gap-3">
          <svg width="44" height="44" viewBox="0 0 48 48" fill="none" aria-hidden>
            <rect width="48" height="48" rx="12" fill="#ffffff" fillOpacity="0.12" />
            <path d="M10 23.5 24 11l14 12.5" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M9 31h8l3-7 5 12 3.5-8H39" stroke="#5EEAD4" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="39" cy="28" r="2.4" fill="#5EEAD4" />
          </svg>
          <span className="text-lg font-bold tracking-tight">
            Remote Inpatient <span className="text-teal-300">AI</span>
          </span>
        </div>
        <div className="relative z-10 my-auto max-w-xl">
          <h1 className="text-[2.6rem] font-bold leading-[1.1] tracking-tight">
            Hospital-level care,
            <br />
            from the comfort of home.
          </h1>
          <p className="mt-5 text-base leading-relaxed text-blue-100">A virtual hospital ward that connects patients at home, their monitoring devices and the clinicians looking after them.</p>
          <ul className="mt-9 grid gap-5 sm:grid-cols-2">
            {POINTS.map((p) => (
              <li key={p.title} className="flex gap-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/10 text-teal-300">
                  <p.icon className="size-4" aria-hidden />
                </span>
                <span>
                  <span className="block text-sm font-semibold">{p.title}</span>
                  <span className="block text-[13px] leading-relaxed text-blue-200">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <EcgBackdrop />
        <p className="relative z-10 text-xs leading-relaxed text-blue-200">Hackathon demonstration. Every patient, reading and event is synthetic. Not a medical device and not for clinical use.</p>
      </section>

      {/* Sign-in panel */}
      <section className="flex flex-col px-5 py-6 sm:px-10">
        <div className="flex items-center justify-between">
          <div className="lg:invisible">
            <Logo />
          </div>
          <ThemeToggle />
        </div>
        <div className="mx-auto my-auto w-full max-w-md py-8">
          <span className="rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-bold tracking-wide text-warn">DEMO SIGN-IN · SYNTHETIC ACCOUNTS</span>
          <h2 className="mt-4 text-2xl font-bold tracking-tight text-ink">Choose how you want to explore</h2>
          <p className="mt-1.5 text-sm text-muted">Pick a role, then one of the demo accounts. No password is needed — none of these people are real.</p>

          <div className="mt-6 grid grid-cols-5 gap-1.5" role="tablist" aria-label="Role">
            {ROLES.map((r) => (
              <button
                key={r.role}
                type="button"
                role="tab"
                aria-selected={role === r.role}
                onClick={() => setRole(r.role)}
                className={clsx(
                  "flex flex-col items-center gap-1.5 rounded-xl border px-1 py-3 text-[11px] font-semibold transition-colors",
                  role === r.role ? "border-primary bg-primary-soft text-primary" : "border-line bg-surface text-muted hover:text-ink",
                )}
              >
                <r.icon className="size-5" aria-hidden />
                {r.label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[13px] text-muted">{ROLES.find((r) => r.role === role)?.blurb}</p>

          <div className="mt-4 space-y-2">
            {!users && !loadError && [0, 1].map((i) => <Skeleton key={i} className="h-16" />)}
            {list.map((u) => (
              <button
                key={u.id}
                type="button"
                disabled={!!pending}
                onClick={() => signIn(u)}
                className="group flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left shadow-card transition-colors hover:border-primary disabled:opacity-60"
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary text-sm font-bold text-white dark:text-[#06131f]">{initials(u.name)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-ink">{u.name}</span>
                  <span className="block truncate text-xs text-muted">{u.title}</span>
                </span>
                <span className="flex items-center gap-1 text-xs font-semibold text-primary">
                  {pending === u.id ? "Signing in…" : "Continue"} <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </button>
            ))}
            {users && list.length === 0 && <p className="rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">No demo account for this role.</p>}
          </div>
          <ErrorNote className="mt-3">{loadError ?? error}</ErrorNote>
          {loadError && (
            <Button className="mt-3" onClick={() => location.reload()}>
              Retry
            </Button>
          )}
          <p className="mt-8 text-[11px] leading-relaxed text-muted">
            The platform supports clinicians; it does not replace them. AI output summarises recorded data and never diagnoses, prescribes or makes emergency decisions.
          </p>
        </div>
      </section>
    </div>
  );
}
