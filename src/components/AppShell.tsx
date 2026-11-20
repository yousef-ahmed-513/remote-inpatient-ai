"use client";
import clsx from "clsx";
import { Bell, BedDouble, ClipboardList, FlaskConical, HeartHandshake, LayoutDashboard, LogOut, Moon, Sun, UserRound, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, initials, useLive } from "@/lib/client";
import { ROLE_LABEL, type Role } from "@/lib/types";
import { Logo, LogoMark } from "./Logo";

type User = { id: string; name: string; role: Role; title: string };
type Toast = { id: string; title: string; patient: string; severity: string; patientId: string };

const NAV: Record<Role, { href: string; label: string; icon: typeof BedDouble }[]> = {
  DOCTOR: [
    { href: "/ward", label: "Virtual ward", icon: BedDouble },
    { href: "/alerts", label: "Alert queue", icon: Bell },
    { href: "/handover", label: "Shift handover", icon: ClipboardList },
  ],
  NURSE: [
    { href: "/ward", label: "Virtual ward", icon: BedDouble },
    { href: "/alerts", label: "Alert queue", icon: Bell },
    { href: "/handover", label: "Shift handover", icon: ClipboardList },
  ],
  ADMIN: [{ href: "/admin", label: "Operations", icon: LayoutDashboard }],
  PATIENT: [{ href: "/me", label: "My care", icon: UserRound }],
  CAREGIVER: [{ href: "/caregiver", label: "Care overview", icon: HeartHandshake }],
};

function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("ria-theme", next ? "dark" : "light");
    } catch {}
  };
  return (
    <button type="button" onClick={toggle} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"} title={dark ? "Light mode" : "Dark mode"} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-ink">
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}
export { ThemeToggle };

export function AppShell({ user, children }: { user: User; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const clinician = user.role === "DOCTOR" || user.role === "NURSE";
  const { data: alertData } = useLive<{ alerts: { id: string; title: string; severity: string; status: string; patientId: string; patient: { name: string } | null }[] }>(clinician ? "/api/alerts?status=active" : null, 4000);
  const active = alertData?.alerts ?? [];
  const unack = active.filter((a) => a.status === "OPEN").length;

  // In-app notifications: toast when a new alert appears after the first load.
  const seen = useRef<Set<string> | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  useEffect(() => {
    if (!alertData) return;
    if (!seen.current) {
      seen.current = new Set(active.map((a) => a.id));
      return;
    }
    const fresh = active.filter((a) => !seen.current!.has(a.id));
    if (fresh.length) {
      fresh.forEach((a) => seen.current!.add(a.id));
      const add = fresh.map((a) => ({ id: a.id, title: a.title, patient: a.patient?.name ?? "Patient", severity: a.severity, patientId: a.patientId }));
      setToasts((t) => [...add, ...t].slice(0, 4));
      add.forEach((x) => setTimeout(() => setToasts((t) => t.filter((y) => y.id !== x.id)), 9000));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alertData]);

  const signOut = async () => {
    await api("/api/auth", { method: "DELETE" }).catch(() => {});
    router.push("/");
    router.refresh();
  };

  const nav = NAV[user.role];
  return (
    <div className="min-h-screen lg:pl-60">
      {/* Sidebar (desktop) */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-line bg-surface lg:flex">
        <div className="px-5 py-5">
          <Logo />
        </div>
        <nav className="flex-1 space-y-1 px-3" aria-label="Main">
          {nav.map((n) => {
            const on = path === n.href || path.startsWith(n.href + "/") || (n.href === "/ward" && path.startsWith("/patients"));
            return (
              <Link key={n.href} href={n.href} className={clsx("flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", on ? "bg-primary-soft text-primary" : "text-muted hover:bg-surface-2 hover:text-ink")}>
                <n.icon className="size-4" aria-hidden />
                {n.label}
                {n.href === "/alerts" && active.length > 0 && (
                  <span className={clsx("tnum ml-auto rounded-full px-1.5 text-[11px] font-bold leading-5", unack ? "bg-crit text-white" : "bg-neutral-soft text-muted")}>{active.length}</span>
                )}
              </Link>
            );
          })}
        </nav>
        <div className="m-3 rounded-xl border border-dashed border-line p-3 text-[11px] leading-relaxed text-muted">
          <div className="mb-1 flex items-center gap-1.5 font-semibold text-ink">
            <FlaskConical className="size-3.5 text-teal" aria-hidden /> Demo environment
          </div>
          All patients and readings are synthetic. Not a medical device. AI supports clinicians — it does not diagnose or prescribe.
        </div>
      </aside>

      {/* Top bar */}
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-line bg-surface/90 px-4 backdrop-blur lg:px-6">
        <div className="lg:hidden">
          <LogoMark size={30} />
        </div>
        <nav className="flex gap-1 lg:hidden" aria-label="Main">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} aria-label={n.label} className={clsx("relative rounded-lg p-2", path.startsWith(n.href) ? "bg-primary-soft text-primary" : "text-muted")}>
              <n.icon className="size-4" />
              {n.href === "/alerts" && active.length > 0 && <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-crit" />}
            </Link>
          ))}
        </nav>
        <span className="hidden rounded-full bg-warn-soft px-2.5 py-1 text-[11px] font-bold tracking-wide text-warn sm:inline">SYNTHETIC DATA · DEMO ONLY</span>
        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          <div className="flex items-center gap-2 rounded-xl border border-line py-1 pl-1 pr-2.5">
            <span className="flex size-7 items-center justify-center rounded-lg bg-primary text-[11px] font-bold text-white dark:text-[#06131f]">{initials(user.name)}</span>
            <span className="hidden leading-tight sm:block">
              <span className="block text-xs font-semibold text-ink">{user.name}</span>
              <span className="block text-[10px] text-muted">{ROLE_LABEL[user.role]}</span>
            </span>
          </div>
          <button type="button" onClick={signOut} className="flex items-center gap-1.5 rounded-lg p-2 text-xs font-medium text-muted hover:bg-surface-2 hover:text-ink" title="Sign out / switch role">
            <LogOut className="size-4" /> <span className="hidden md:inline">Switch role</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-5 lg:px-6 lg:py-6">{children}</main>

      {/* Notifications */}
      <div className="pointer-events-none fixed bottom-4 right-4 z-40 flex w-[min(92vw,360px)] flex-col gap-2" aria-live="assertive">
        {toasts.map((t) => (
          <div key={t.id} className={clsx("fade-up pointer-events-auto flex items-start gap-3 rounded-xl border border-line border-l-4 bg-surface p-3 shadow-2xl", t.severity === "CRITICAL" ? "border-l-crit" : "border-l-warn")}>
            <Bell className={clsx("mt-0.5 size-4 shrink-0", t.severity === "CRITICAL" ? "text-crit" : "text-warn")} aria-hidden />
            <Link href={`/patients/${t.patientId}`} className="min-w-0 flex-1" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <span className="block text-[11px] font-bold uppercase tracking-wide text-muted">
                {t.severity === "CRITICAL" ? "Critical demo alert" : "New alert"} · {t.patient}
              </span>
              <span className="block text-sm font-medium text-ink">{t.title}</span>
            </Link>
            <button type="button" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} className="rounded p-1 text-muted hover:bg-surface-2">
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
