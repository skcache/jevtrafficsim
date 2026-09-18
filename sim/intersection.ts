/**
 * Intersection control layer (Task 06): decides whether a vehicle may cross
 * an intersection from its current directed road onto a directed next road.
 *
 * Mechanics only. Signal phase STATE lives in `sim/signals.ts`, and phase
 * POLICY (when to request a change) belongs to controllers (Task 07).
 *
 * Rules:
 * - signal:       the approach (incoming directed road) may proceed only
 *                 while its group is green; yellow and all-red block NEW
 *                 entries (documented yellow policy).
 * - stop:         the vehicle must already be queued at the road end (it
 *                 cannot roll through from the movement phase) for at least
 *                 STOP_SIGN_MIN_STOP_MS of simulation time, and at most ONE
 *                 vehicle crosses a stop-controlled intersection per tick —
 *                 chosen by the existing queue order (queuedSinceMs, id),
 *                 first-arrival-first-served.
 * - uncontrolled: always permitted here; closed/capacity rules still apply.
 *
 * Grant consumption: `recordControlGrant` is only called after a transfer
 * actually succeeds, so a capacity-blocked vehicle never burns a stop-sign
 * turn. Spawning onto a first road is not gated by intersection control —
 * spawns are abstract origins (Task 05 contract preserved).
 */
import { STOP_SIGN_MIN_STOP_MS } from "./config";
import { canApproachProceed } from "./signals";
import type { City, IntersectionId, RoadId } from "./types";
import type { TrafficState } from "./traffic";

export interface IntersectionStepContext {
  /** Successful stop-controlled crossings per intersection within one step. */
  stopGrants: Map<IntersectionId, number>;
}

export function createIntersectionStepContext(): IntersectionStepContext {
  return { stopGrants: new Map() };
}

/**
 * Legal control decision for a vehicle crossing the intersection at
 * `nextRoad.from` from `incomingRoadId`. Callers compose this with their own
 * closed-road and capacity checks.
 */
export function evaluateIntersectionControl(
  city: City,
  state: TrafficState,
  incomingRoadId: RoadId,
  nextRoadId: RoadId,
  queuedSinceMs: number | null,
  context: IntersectionStepContext,
): "granted" | "blocked" {
  const nextRoad = city.roads[nextRoadId];
  if (!nextRoad) {
    return "blocked";
  }
  const target = city.intersections[nextRoad.from];
  if (target.control === "signal") {
    const signal = state.signals.get(target.id);
    if (!signal) {
      return "blocked"; // fail closed if signals were never initialised
    }
    return canApproachProceed(signal, incomingRoadId) ? "granted" : "blocked";
  }
  if (target.control === "stop") {
    if (queuedSinceMs === null) {
      return "blocked"; // must come to a stop at the road end first
    }
    if (state.timeMs - queuedSinceMs < STOP_SIGN_MIN_STOP_MS) {
      return "blocked"; // minimum stop duration not yet satisfied
    }
    if ((context.stopGrants.get(target.id) ?? 0) >= 1) {
      return "blocked"; // one crossing per tick: first-arrival-first-served
    }
    return "granted";
  }
  return "granted";
}

/** Consumes a stop-controlled crossing slot after a successful transfer. */
export function recordControlGrant(
  city: City,
  nextRoadId: RoadId,
  context: IntersectionStepContext,
): void {
  const nextRoad = city.roads[nextRoadId];
  if (!nextRoad) {
    return;
  }
  const target = city.intersections[nextRoad.from];
  if (target.control === "stop") {
    context.stopGrants.set(target.id, (context.stopGrants.get(target.id) ?? 0) + 1);
  }
}
