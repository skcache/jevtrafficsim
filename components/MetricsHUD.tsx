"use client";

/**
 * MetricsHUD (Task 11 polish pass): the timing board.
 *
 * Deliberately not a card: five hairline-spaced rows of type over the map,
 * values in mono, plus a sparkline of average wait. It appears 600 ms after
 * the city does (never mid-transition) and renders zeros, not dashes, until
 * the first metrics packet lands.
 */
import { motion } from "motion/react";
import { useUiStore } from "@/store/ui-store";
import { sparklineLastPoint, sparklinePath } from "@/render/visuals";
import { formatDuration, formatPercent, formatThroughput } from "./ui-model";

const SPARK_WIDTH = 176;
const SPARK_HEIGHT = 24;

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
    <div className="flex items-baseline justify-between gap-3">
      <span className="label-micro on-map-soft">{label}</span>
      {settled ? (
        <span className="value-num text-value leading-none text-ink on-map-soft">{value}</span>
      ) : (
        <span className="h-[9px] w-9 animate-pulse rounded-full bg-ink/10" />
      )}
    </div>
  );
}

export function MetricsHUD() {
  const phase = useUiStore((state) => state.phase);
  const metrics = useUiStore((state) => state.metrics);
  const history = useUiStore((state) => state.metricsHistory);
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
  const path = sparklinePath(history, SPARK_WIDTH, SPARK_HEIGHT);
  const last = sparklineLastPoint(history, SPARK_WIDTH, SPARK_HEIGHT);

  return (
    <motion.div
      className="pointer-events-none absolute bottom-4 left-4 z-10 w-44"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: live ? 1 : 0, y: live ? 0 : 6 }}
      transition={{ duration: 0.32, delay: live ? 0.18 : 0, ease: [0.22, 1, 0.36, 1] }}
      aria-hidden={!live}
    >
      <div className="flex flex-col gap-[6px]">
        {rows.map((row) => (
          <MetricRow key={row.label} label={row.label} value={row.value} settled={settled} />
        ))}
      </div>
      <div className="mt-3 border-t border-hair pt-2">
        <div className="value-num flex items-baseline justify-between text-micro text-ink-38 on-map-soft">
          <span>{trips.toLocaleString("en-US")} trips</span>
          <span>{active.toLocaleString("en-US")} active</span>
        </div>
        <svg
          className="mt-1 block h-6 w-full overflow-visible"
          viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {path && (
            <>
              <path
                d={path}
                fill="none"
                stroke="rgb(33 29 24 / 0.32)"
                strokeWidth={1.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
              {last && <circle cx={last.x} cy={last.y} r={2} fill="rgb(33 29 24 / 0.45)" />}
            </>
          )}
        </svg>
      </div>
    </motion.div>
  );
}
