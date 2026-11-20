"use client";
import { ShieldAlert, Sparkles } from "lucide-react";
import { clock } from "@/lib/client";
import type { SummaryDoc } from "@/lib/types";
import { Badge } from "./ui";

export type SummaryDto = { id: string; engine: string; createdBy: string; createdAt: string; doc: SummaryDoc; fallbackReason?: string };

export function engineLabel(engine: string) {
  if (engine === "deterministic") return "Built-in rule-based summariser (no external AI used)";
  if (engine.startsWith("bedrock:")) return `Amazon Bedrock · ${engine.slice(8)}`;
  if (engine.startsWith("openai:")) return `OpenAI · ${engine.slice(7)}`;
  return engine;
}

export function SummaryView({ summary }: { summary: SummaryDto }) {
  const { doc } = summary;
  return (
    <div className="fade-up">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone="teal">
          <Sparkles className="size-3" aria-hidden /> AI-assisted
        </Badge>
        <span className="text-[11px] text-muted">
          {clock(summary.createdAt, true)} · requested by {summary.createdBy}
        </span>
      </div>
      <p className="mt-2.5 text-sm font-semibold leading-relaxed text-ink">{doc.headline}</p>
      <div className="mt-3 space-y-3">
        {doc.sections.map((s) => (
          <section key={s.title}>
            <h4 className="text-[11px] font-bold uppercase tracking-wide text-muted">{s.title}</h4>
            <ul className="mt-1 space-y-1">
              {s.items.map((it, i) => (
                <li key={i} className="flex gap-2 text-[13px] leading-relaxed text-ink">
                  <span className="mt-2 size-1 shrink-0 rounded-full bg-teal" aria-hidden />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-4 flex items-start gap-2 rounded-lg bg-neutral-soft px-3 py-2 text-[11px] leading-relaxed text-muted">
        <ShieldAlert className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          {doc.disclaimer} <span className="font-medium">Engine: {engineLabel(summary.engine)}.</span>
          {summary.fallbackReason ? ` (${summary.fallbackReason} — fallback used.)` : ""}
        </span>
      </p>
    </div>
  );
}
