"use client";

/**
 * TripHUD (Issue #25): the trip is the product, so the primary instrument is
 * the trip's own state — name, elapsed, remaining, speed, stopped time,
 * intersections cleared, estimate. Citywide health stays readable in one
 * secondary line; it is context, not the headline.
 *
 * Every value is a field the worker computed (see tripHudView in ui-model), so
 * the HUD can never disagree with the map or the simulation.
 */
import { motion } from "motion/react";
import { useUiStore } from "@/store/ui-store";
import { formatDuration, formatPercent, tripHudView } from "./ui-model";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-baseline gap-4">
      <span className="label-micro">{label}</span>
      <span className="value-num text-meta font-medium leading-none text-ink">{value}</span>
    </div>
  );
}

export function TripHUD() {
  const phase = useUiStore((state) => state.phase);
  const trip = useUiStore((state) => state.trip);
  const egoState = useUiStore((state) => state.egoState);
  const egoSpeedMps = useUiStore((state) => state.egoSpeedMps);
  const metrics = useUiStore((state) => state.metrics);
  const live = phase === "city";
  const view = tripHudView({ trip, egoState, egoSpeedMps });

  return (
    <motion.div
      className="pointer-events-none absolute bottom-4 left-4 z-10 w-[204px]"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: live ? 1 : 0, y: live ? 0 : 6 }}
      transition={{ duration: 0.32, delay: live ? 0.18 : 0, ease: [0.22, 1, 0.36, 1] }}
      aria-hidden={!live}
    >
      <div className="surface flex flex-col gap-2 px-3 py-2.5" role="status" aria-label="Trip">
        <div className="flex items-baseline justify-between gap-3">
          <span className="min-w-0 truncate text-ui font-medium text-ink">
            {view?.tripName ?? "Trip"}
          </span>
          <span
            className={`label-micro shrink-0 ${view?.completed ? "text-ink" : "text-ink-52"}`}
          >
            {view?.state.toUpperCase() ?? "—"}
          </span>
        </div>
        <div className="flex flex-col gap-[6px]">
          {view ? (
            view.rows.map((row) => <Row key={row.label} label={row.label} value={row.value} />)
          ) : (
            Array.from({ length: 5 }, (_, index) => (
              <div key={index} className="grid grid-cols-[1fr_auto] items-baseline gap-4">
                <span className="label-micro">·</span>
                <span className="h-[9px] w-10 animate-pulse rounded-full bg-ink/10" />
              </div>
            ))
          )}
        </div>
        <div className="mt-0.5 border-t border-hair pt-2">
          <div className="mb-1 label-micro text-ink-38">City traffic</div>
          <div className="value-num flex items-baseline justify-between text-micro text-ink-38">
            <span>{formatDuration(metrics?.averageWaitTimeMs ?? 0)} avg wait</span>
            <span>{formatPercent(metrics?.gridlockRatio ?? 0)} gridlock</span>
          </div>
          <div className="value-num mt-[3px] flex items-baseline justify-between text-micro text-ink-38">
            <span>{(metrics?.activeVehicles ?? 0).toLocaleString("en-US")} active</span>
            <span>{(metrics?.completedTrips ?? 0).toLocaleString("en-US")} trips</span>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
