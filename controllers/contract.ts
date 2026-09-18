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
 * Controllers must be pure with respect to the world: they may read the city
 * and traffic state, but never mutate it, so repeated calls with identical
 * input yield identical directives.
 */
import type { SignalDirective } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId } from "@/sim/types";

export interface TrafficController {
  /** Stable identifier used in run metadata (e.g. "fixed"). */
  readonly id: string;
  /** Per-intersection directives for this tick; absence = no opinion. */
  directives(
    city: City,
    traffic: TrafficState,
  ): ReadonlyMap<IntersectionId, SignalDirective>;
}
