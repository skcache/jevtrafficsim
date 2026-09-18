"use client";

/**
 * MetricsHUD (Task 11 visual correction): one small translucent surface with
 * five live metrics. Subscribes to the 2 Hz metrics slot only.
 */
import { useUiStore } from "@/store/ui-store";
import { formatDuration, formatPercent, formatThroughput } from "./ui-model";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-5">
      <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-neutral-400">
        {label}
      </span>
      <span className="text-sm font-semibold tabular-nums tracking-tight text-neutral-800">
        {value}
      </span>
    </div>
  );
}

export function MetricsHUD() {
  const metrics = useUiStore((state) => state.metrics);
  const phase = useUiStore((state) => state.phase);
  if (phase !== "city") {
    return null;
  }
  return (
    <div className="pointer-events-none absolute right-4 top-4 z-10 hidden sm:block">
      <div className="pointer-events-auto w-40 rounded-xl border border-neutral-900/10 bg-white/85 px-3.5 py-3 shadow-sm backdrop-blur-sm">
        <div className="flex flex-col gap-1.5">
          <Row label="Avg wait" value={metrics ? formatDuration(metrics.averageWaitTimeMs) : "—"} />
          <Row label="P95 wait" value={metrics ? formatDuration(metrics.p95WaitTimeMs) : "—"} />
          <Row label="Flow" value={metrics ? formatThroughput(metrics.throughputPerMinute) : "—"} />
          <Row label="Max wait" value={metrics ? formatDuration(metrics.maxWaitTimeMs) : "—"} />
          <Row label="Gridlock" value={metrics ? formatPercent(metrics.gridlockRatio) : "—"} />
        </div>
        <div className="mt-2 border-t border-neutral-900/5 pt-1.5 text-[10px] tabular-nums tracking-wide text-neutral-400">
          {metrics ? `${metrics.completedTrips} trips completed` : "waiting for data"}
        </div>
      </div>
    </div>
  );
}
