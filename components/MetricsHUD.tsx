"use client";

/**
 * MetricsHUD: the run's instrumentation, as ONE floating surface.
 *
 * It used to be naked type over the map with a trend chart under it, which read
 * as debug output rather than a designed instrument. Now it is a single quiet
 * panel: caps labels in a left column, tabular numerals in a right column, one
 * hairline divider, then the fleet line. The old trend chart was deleted: it
 * added motion without adding signal, and the numbers already carry the trend.
 */
import { motion } from "motion/react";
import { useUiStore } from "@/store/ui-store";
import { formatDuration, formatPercent, formatThroughput } from "./ui-model";

function MetricRow({
  label,
  value,
  settled,
}: {
  label: string;
  value: string;
  settled: boolean;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-4">
      <span className="label-micro">{label}</span>
      {settled ? (
        <span className="value-num text-meta font-medium leading-none text-ink">{value}</span>
      ) : (
        <span className="h-[9px] w-9 animate-pulse rounded-full bg-ink/10" />
      )}
    </div>
  );
}

export function MetricsHUD() {
  const phase = useUiStore((state) => state.phase);
  const metrics = useUiStore((state) => state.metrics);
  const live = phase === "city";
  // Skeleton until the first packet of THIS run lands — never stale zeros.
  const settled = metrics !== null;
  const rows = [
    { label: "Avg wait", value: formatDuration(metrics?.averageWaitTimeMs ?? 0) },
    { label: "P95 wait", value: formatDuration(metrics?.p95WaitTimeMs ?? 0) },
    { label: "Flow", value: formatThroughput(metrics?.throughputPerMinute ?? 0) },
    { label: "Max wait", value: formatDuration(metrics?.maxWaitTimeMs ?? 0) },
    { label: "Gridlock", value: formatPercent(metrics?.gridlockRatio ?? 0) },
  ];
  const trips = metrics?.completedTrips ?? 0;
  const active = metrics?.activeVehicles ?? 0;

  return (
    <motion.div
      className="pointer-events-none absolute bottom-4 left-4 z-10 w-[188px]"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: live ? 1 : 0, y: live ? 0 : 6 }}
      transition={{ duration: 0.32, delay: live ? 0.18 : 0, ease: [0.22, 1, 0.36, 1] }}
      aria-hidden={!live}
    >
      <div className="surface flex flex-col gap-2 px-3 py-2.5" role="status" aria-label="Live metrics">
        {rows.map((row) => (
          <MetricRow key={row.label} label={row.label} value={row.value} settled={settled} />
        ))}
        <div className="mt-0.5 border-t border-hair pt-2">
          <div className="value-num flex items-baseline justify-between text-micro text-ink-38">
            <span>{active.toLocaleString("en-US")} active</span>
            <span>{trips.toLocaleString("en-US")} completed</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
