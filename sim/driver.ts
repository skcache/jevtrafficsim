/**
 * Driver strategies (Issue #28).
 *
 * The challenge has two independent axes: WHO is driving (this module) and WHAT
 * controls the city (fixed / adaptive / Jev later). They must never mix — a
 * driver strategy changes only how the ego car plans, never how signals work.
 *
 * tourist
 *   Plans once at departure and lives with it. Reroutes only when the
 *   remaining path stops being physically valid (a closure across it), which is
 *   the engine's existing invalidity reroute — no proactive replanning at all.
 *
 * local
 *   Replans deterministically against current traffic, but only every so
 *   often, only when the new route is MATERIALLY better, and never again inside
 *   a cooldown after a switch. The hysteresis is what stops a driver from
 *   ping-ponging between two near-equal routes.
 *
 * No model, no randomness, no wall clock: every input is simulation state and
 * every threshold is a named constant.
 */
import { roadSpeedFactor } from "./road-traffic";
import type { City, RoadId } from "./types";
import type { TrafficState } from "./traffic";

export const DRIVER_CHOICES = ["tourist", "local"] as const;
export type DriverStrategy = (typeof DRIVER_CHOICES)[number];

export const DRIVER_LABELS: Record<DriverStrategy, string> = {
  tourist: "Tourist",
  local: "Local",
};

export const DRIVER_DESCRIPTIONS: Record<DriverStrategy, string> = {
  tourist: "Picks a route and keeps it; only a closed road makes them change.",
  local: "Reroutes when traffic makes a clearly better road available.",
};

export const LOCAL_REPLAN = {
  /** How often the local driver even looks at the alternatives. */
  intervalMs: 20_000,
  /** A switch must save at least this fraction of the remaining travel time… */
  minImprovementRatio: 0.18,
  /** …and at least this many seconds, so small wins never churn the route. */
  minImprovementSeconds: 12,
  /** After a switch, leave the route alone for this long (oscillation guard). */
  cooldownMs: 90_000,
} as const;

export interface DriverState {
  /** Simulation time of the last look at alternatives. */
  lastCheckMs: number;
  /** Simulation time of the last accepted switch (-Infinity: never). */
  lastSwitchMs: number;
  /** How many times this driver changed its route. */
  switches: number;
}

export function createDriverState(): DriverState {
  return { lastCheckMs: 0, lastSwitchMs: Number.NEGATIVE_INFINITY, switches: 0 };
}

export type ReplanReason =
  | "tourist"
  | "not-due"
  | "cooldown"
  | "not-better"
  | "switch";

export interface ReplanDecision {
  readonly replan: boolean;
  readonly reason: ReplanReason;
  /** Seconds the candidate route saves (negative when it is worse). */
  readonly improvementSeconds: number;
}

/**
 * The whole decision, as a pure function.
 *
 * `currentSeconds` / `candidateSeconds` are remaining-travel-time estimates
 * (see sim/travel-time.ts). Tourist never proactively replans; local replans
 * only when due, out of cooldown, and materially better.
 */
export function decideReplan(
  strategy: DriverStrategy,
  state: DriverState,
  nowMs: number,
  currentSeconds: number,
  candidateSeconds: number,
): ReplanDecision {
  const improvementSeconds = currentSeconds - candidateSeconds;
  if (strategy === "tourist") {
    return { replan: false, reason: "tourist", improvementSeconds };
  }
  if (nowMs - state.lastCheckMs < LOCAL_REPLAN.intervalMs) {
    return { replan: false, reason: "not-due", improvementSeconds };
  }
  if (state.switches > 0 && nowMs - state.lastSwitchMs < LOCAL_REPLAN.cooldownMs) {
    return { replan: false, reason: "cooldown", improvementSeconds };
  }
  const materiallyBetter =
    improvementSeconds >= LOCAL_REPLAN.minImprovementSeconds &&
    improvementSeconds >= currentSeconds * LOCAL_REPLAN.minImprovementRatio;
  if (!materiallyBetter) {
    return { replan: false, reason: "not-better", improvementSeconds };
  }
  return { replan: true, reason: "switch", improvementSeconds };
}

/** Remaining travel time over a route, in seconds, from the driver's position. */
export function remainingRouteSeconds(
  city: City,
  traffic: TrafficState,
  route: readonly RoadId[],
  routeIndex: number,
  progressM: number,
): number {
  let seconds = 0;
  for (let index = Math.max(0, routeIndex); index < route.length; index += 1) {
    const road = city.roads[route[index]];
    if (!road || road.speedLimit <= 0) {
      continue;
    }
    const lengthM = index === routeIndex ? Math.max(0, road.length - progressM) : road.length;
    // The SAME authoritative speed factor that drives vehicle motion and the
    // map's colours: a driver's estimate of a route is the traffic they can
    // actually see, with no second slowdown model in between.
    seconds += lengthM / (road.speedLimit * roadSpeedFactor(traffic.roadTraffic, road.id));
  }
  return seconds;
}

