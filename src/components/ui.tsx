"use client";
// Small shadcn-style primitives (hand-rolled so the demo has no component-CLI dependency).
import clsx from "clsx";
import { AlertTriangle, Loader2, X } from "lucide-react";
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { STATE_META, type MonitoringState } from "@/lib/types";

export type Tone = "ok" | "warn" | "crit" | "muted" | "info" | "primary" | "teal";
export const TONE: Record<Tone, string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  crit: "bg-crit-soft text-crit",
  muted: "bg-neutral-soft text-muted",
  info: "bg-info-soft text-info",
  primary: "bg-primary-soft text-primary",
  teal: "bg-teal-soft text-teal",
};
export const TONE_BORDER: Record<Tone, string> = {
  ok: "border-l-ok",
  warn: "border-l-warn",
  crit: "border-l-crit",
  muted: "border-l-muted",
  info: "border-l-info",
  primary: "border-l-primary",
  teal: "border-l-teal",
};

export function Card({ className, children, ...rest }: { className?: string; children: ReactNode } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("rounded-2xl border border-line bg-surface shadow-card", className)} {...rest}>
      {children}
    </div>
  );
}
export function CardHeader({ title, icon, action, subtitle }: { title: ReactNode; icon?: ReactNode; action?: ReactNode; subtitle?: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3">
      <div className="min-w-0">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          {icon && <span className="text-primary">{icon}</span>}
          {title}
        </h3>
        {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" | "teal"; size?: "sm" | "md"; busy?: boolean };
export function Button({ variant = "secondary", size = "md", busy, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      className={clsx(
        "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "h-8 px-2.5 text-xs" : "h-9 px-3.5 text-sm",
        variant === "primary" && "bg-primary text-white hover:brightness-110 dark:text-[#06131f]",
        variant === "teal" && "bg-teal text-white hover:brightness-105 dark:text-[#06131f]",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-muted hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "bg-crit text-white hover:brightness-110 dark:text-[#06131f]",
        className,
      )}
      {...rest}
    >
      {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Badge({ tone = "muted", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold", TONE[tone], className)}>
      {children}
    </span>
  );
}
export function SimBadge({ className }: { className?: string }) {
  return (
    <span className={clsx("inline-flex items-center rounded border border-dashed border-muted/60 px-1.5 py-px text-[10px] font-bold tracking-wider text-muted", className)} title="Synthetic data produced by the simulator">
      SIMULATED
    </span>
  );
}
export function StatePill({ state, className }: { state: MonitoringState; className?: string }) {
  const m = STATE_META[state];
  return (
    <Badge tone={m.tone} className={clsx("px-2.5 py-1 text-xs", state === "CRITICAL" && "crit-pulse", className)}>
      <span className={clsx("size-1.5 rounded-full bg-current", state === "CRITICAL" && "live-dot")} aria-hidden />
      {m.label}
    </Badge>
  );
}

const fieldBase = "w-full rounded-lg border border-line bg-surface px-3 text-sm text-ink placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60";
export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={clsx(fieldBase, "h-9", className)} {...rest} />;
}
export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={clsx(fieldBase, "min-h-20 py-2", className)} {...rest} />;
}
export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={clsx(fieldBase, "h-9 pr-8", className)} {...rest}>
      {children}
    </select>
  );
}
export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={clsx("block", className)}>
      <span className="mb-1 block text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-[#06131f]/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" className={clsx("fade-up max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-surface shadow-2xl sm:rounded-2xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-line bg-surface px-5 py-3.5">
          <h2 className="text-base font-semibold text-ink">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx("animate-pulse rounded-xl bg-neutral-soft", className)} />;
}
export function ErrorNote({ children, className }: { children: ReactNode; className?: string }) {
  if (!children) return null;
  return (
    <p role="alert" className={clsx("flex items-start gap-2 rounded-lg bg-crit-soft px-3 py-2 text-xs font-medium text-crit", className)}>
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
export function Empty({ children, icon }: { children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-sm text-muted">
      {icon && <span className="text-muted/60">{icon}</span>}
      {children}
    </div>
  );
}
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode; count?: number }[]; className?: string }) {
  return (
    <div role="tablist" className={clsx("flex gap-1 overflow-x-auto rounded-xl bg-neutral-soft p-1", className)}>
      {items.map((it) => (
        <button
          key={it.id}
          role="tab"
          type="button"
          aria-selected={value === it.id}
          onClick={() => onChange(it.id)}
          className={clsx(
            "flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors",
            value === it.id ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink",
          )}
        >
          {it.label}
          {!!it.count && <span className="rounded-full bg-crit px-1.5 text-[10px] leading-4 text-white">{it.count}</span>}
        </button>
      ))}
    </div>
  );
}
export function PageLoading() {
  return (
    <div className="space-y-4 p-1">
      <Skeleton className="h-9 w-64" />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-52" />
        ))}
      </div>
    </div>
  );
}
export function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="mx-auto mt-10 max-w-md p-6 text-center">
      <AlertTriangle className="mx-auto size-8 text-warn" aria-hidden />
      <p className="mt-3 text-sm font-semibold text-ink">This page could not be loaded</p>
      <p className="mt-1 text-sm text-muted">{message}</p>
      {onRetry && (
        <Button className="mt-4" onClick={onRetry}>
          Try again
        </Button>
      )}
    </Card>
  );
}
