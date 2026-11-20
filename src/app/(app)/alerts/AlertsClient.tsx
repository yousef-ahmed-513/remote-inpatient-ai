"use client";
import { useState } from "react";
import { AlertList, type AlertDto } from "@/components/AlertList";
import { Card, PageError, PageLoading, Tabs } from "@/components/ui";
import { clock, useLive } from "@/lib/client";
import type { Role } from "@/lib/types";

type Data = { me: { role: Role }; now: string; alerts: AlertDto[] };
type Status = "active" | "resolved" | "all";

export function AlertsClient() {
  const [status, setStatus] = useState<Status>("active");
  const { data, error, loading, refresh } = useLive<Data>(`/api/alerts?status=${status}`, 2500);

  if (loading && !data) return <PageLoading />;
  if (!data) return <PageError message={error?.message ?? "No data"} onRetry={refresh} />;

  const open = data.alerts.filter((a) => a.status === "OPEN").length;
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-ink">Alert queue</h1>
        <p className="mt-0.5 text-sm text-muted">
          Rule-based alerts from clinician-configured limits, trends, devices and check-ins · updated {clock(data.now, true)}
          {status === "active" ? ` · ${open} waiting for acknowledgement` : ""}
        </p>
      </div>
      <Tabs<Status>
        value={status}
        onChange={setStatus}
        className="w-fit"
        items={[
          { id: "active", label: "Active" },
          { id: "resolved", label: "Resolved" },
          { id: "all", label: "All" },
        ]}
      />
      {error && <p className="rounded-xl bg-warn-soft px-4 py-2 text-xs font-medium text-warn">Connection problem — showing the last data received ({error.message})</p>}
      <Card className="p-4">
        <AlertList alerts={data.alerts} role={data.me.role} now={data.now} onChange={refresh} empty={status === "active" ? "No active alerts." : "No alerts to show."} />
      </Card>
    </div>
  );
}
