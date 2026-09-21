/**
 * Controller contract (Task 07): the policy layer that decides, each tick,
 * whether any signal should leave its current phase.
 *
 * Controllers are mechanics-bounded: they only ever emit SignalDirective
 * values ("hold" | "advance"), and every legality constraint — ring ordering,
 * min/max green, yellow, all-red, single-group hold — is enforced by
 * sim/signals.ts regardless of what a controller asks for. A missing entry in
 * the returned map means "no opinion".
 *
 * Controllers must be pure with respect to the world: they may read the city,
 * traffic state and engine-owned context, but never mutate them, so repeated
 * calls with identical input yield identical directives.
 *
 * ## Policy controllers (Issue #13)
 *
 * A controller whose policy arrives from OUTSIDE the simulation (Jev) may hold
 * exactly one piece of private state: the most recent VALIDATED policy, plus the
 * bookkeeping needed to refresh it on a simulated-time cadence. That does not
 * weaken the rule above — its directives are still a pure function of
 * (city, traffic, context, policy), so a run with a fixed policy sequence
 * replays exactly. Nothing else may be remembered: no per-signal history, no
 * private timing, no vehicle memory.
 *
 * ## Controller context (Task 09)
 *
 * Policy that needs more than raw state (queue pressure, arrival rates,
 * region/corridor metadata) reads it from this engine-owned context instead
 * of keeping its own hidden history: `directives` receives the frame the
 * engine just derived from the current state, so the same complete input
 * always produces the same directives. The parameter is optional — simple
 * controllers (Fixed) ignore it and unit tests may call them without one —
 * while the engine always supplies it during normal execution.
 */
import type { ObservationFrame } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import type { SignalDirective } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId } from "@/sim/types";

/** Read-only, engine-owned observations for policy controllers. */
export interface TrafficControllerContext {
  /** Deterministic observations of the current tick (queues, waits, rates). */
  readonly observations: ObservationFrame;
  /** Static region/corridor partition, built once per engine. */
  readonly partition: CityPartition;
}

export interface TrafficController {
  /** Stable identifier used in run metadata (e.g. "fixed"). */
  readonly id: string;
  /** Per-intersection directives for this tick; absence = no opinion. */
  directives(
    city: City,
    traffic: TrafficState,
    context?: TrafficControllerContext,
  ): ReadonlyMap<IntersectionId, SignalDirective>;
}
