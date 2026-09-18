"use client";

/**
 * MetricsHUD (Task 11): five live metrics, human-readable, no charts.
 * Subscribes to the 2 Hz metrics slot only, so high-frequency frames never
 * rerender it.
 */
import { useUiStore } from "@/store/ui-store";

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms - minutes * 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-6">
      <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      <span className="text-xl font-semibold tracking-tight text-neutral-800 tabular-nums">
        {value}
      </span>
    </div>
  );
}

export function MetricsHUD() {
  const metrics = useUiStore((state) => state.metrics);
  const gridlock = metrics ? Math.round(metrics.gridlockRatio * 100) : null;

  return (
    <div className="pointer-events-none absolute right-4 top-4 z-10 hidden sm:block">
      <div className="pointer-events-auto w-44 rounded-xl border border-neutral-900/10 bg-white/85 px-3.5 py-3 shadow-sm backdrop-blur-sm">
        <div className="mb-2 text-[10px] font-medium uppercase tracking-wide text-neutral-400">
          Live metrics
        </div>
        <div className="flex flex-col gap-2">
          <Row label="Avg wait" value={metrics ? formatDuration(metrics.averageWaitTimeMs) : "—"} />
          <Row label="P95 wait" value={metrics ? formatDuration(metrics.p95WaitTimeMs) : "—"} />
          <Row
            label="Throughput"
            value={metrics ? `${metrics.throughputPerMinute.toFixed(1)} / min` : "—"}
          />
          <Row label="Max wait" value={metrics ? formatDuration(metrics.maxWaitTimeMs) : "—"} />
          <Row label="Gridlock" value={gridlock !== null ? `${gridlock}%` : "—"} />
        </div>
        <div className="mt-2 border-t border-neutral-900/5 pt-2 text-[10px] tracking-wide text-neutral-400 tabular-nums">
          {metrics ? `${metrics.completedTrips} trips completed` : "waiting for data"}
        </div>
      </div>
    </div>
  );
}
