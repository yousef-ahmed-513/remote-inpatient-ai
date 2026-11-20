"use client";
import { ClipboardList, Sparkles } from "lucide-react";
import { SummaryView, engineLabel, type SummaryDto } from "@/components/SummaryView";
import { Button, Card, CardHeader, Empty, ErrorNote, PageError, PageLoading } from "@/components/ui";
import { api, dateTime, useAction, useLive } from "@/lib/client";

type Data = { provider: string; reports: SummaryDto[] };

export function HandoverClient() {
  const { data, error, loading, refresh } = useLive<Data>("/api/handover", 15000);
  const gen = useAction();

  if (loading && !data) return <PageLoading />;
  if (!data) return <PageError message={error?.message ?? "No data"} onRetry={refresh} />;

  const [latest, ...older] = data.reports;
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Shift handover</h1>
          <p className="mt-0.5 text-sm text-muted">An AI-assisted report across every virtual bed, built from recorded data. Engine: {engineLabel(data.provider)}.</p>
        </div>
        <Button variant="teal" busy={gen.busy} onClick={() => gen.run(async () => (await api("/api/handover", { body: {} }), refresh()))}>
          <Sparkles className="size-3.5" /> Generate handover report
        </Button>
      </div>
      <ErrorNote>{gen.error}</ErrorNote>
      <Card>
        <CardHeader icon={<ClipboardList className="size-4" />} title="Latest report" subtitle={latest ? dateTime(latest.createdAt) : undefined} />
        <div className="px-5 pb-5">{latest ? <SummaryView summary={latest} /> : <Empty icon={<ClipboardList className="size-6" />}>No handover report yet. Generate one at the end of your shift.</Empty>}</div>
      </Card>
      {older.length > 0 && (
        <Card>
          <CardHeader title="Earlier reports" />
          <ul className="divide-y divide-line px-5 pb-4">
            {older.map((r) => (
              <li key={r.id} className="py-2.5 text-sm">
                <span className="font-medium text-ink">{dateTime(r.createdAt)}</span> <span className="text-muted">· {r.createdBy} · {r.doc.headline}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
