/**
 * Challenge results and the comparison guard (Issue #28).
 *
 * A result is one run's outcome under one controller, tagged with the scenario
 * fingerprint and the driver strategy it ran under. Results may only be put side
 * by side when their fingerprints match — the guard is a function, not a
 * convention, so the UI cannot show an unfair comparison by accident.
 *
 * The city half of the result comes from the same metrics the HUD already
 * reads; the trip half comes from the ego vehicle itself.
 */
import type { EngineState } from "@/sim/engine";
import type { DriverStrategy } from "@/sim/driver";
import { computeMetrics } from "@/sim/metrics";
import type { ControllerChoice } from "@/worker/protocol";
import { scenarioFingerprint, type ChallengeScenario } from "@/worker/challenge-scenario";

export interface ChallengeTripResult {
  readonly completed: boolean;
  readonly tripTimeMs: number;
  readonly stoppedMs: number;
  readonly distanceM: number;
  readonly averageSpeedMps: number;
  /** Route changes: an invalidated path (both strategies) or a driver switch. */
  readonly rerouteCount: number;
}

export interface ChallengeCityResult {
  readonly averageWaitMs: number;
  readonly p95WaitMs: number;
  readonly completedTrips: number;
  readonly throughputPerMinute: number;
  readonly gridlockRatio: number;
  readonly activeVehicles: number;
}

export interface ChallengeResult {
  readonly fingerprint: string;
  readonly controller: ControllerChoice;
  readonly driver: DriverStrategy;
  /** Human-fired incidents during this run: > 0 makes it non-comparable. */
  readonly manualIncidents: number;
  readonly simulatedMs: number;
  readonly trip: ChallengeTripResult;
  readonly city: ChallengeCityResult;
}

export function buildChallengeResult(
  engine: EngineState,
  scenario: ChallengeScenario,
  controller: ControllerChoice,
  manualIncidents: number,
): ChallengeResult {
  const ego =
    engine.egoVehicleId === null
      ? null
      : engine.traffic.vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId) ?? null;
  let distanceM = 0;
  if (ego) {
    for (let index = 0; index < ego.route.length; index += 1) {
      const road = engine.city.roads[ego.route[index]];
      if (!road) {
        continue;
      }
      distanceM +=
        index < ego.routeIndex ? road.length : index === ego.routeIndex ? ego.progress : 0;
    }
  }
  const elapsedMs = ego?.tripTimeMs ?? engine.traffic.timeMs;
  const metrics = computeMetrics(engine.metrics, engine.traffic);
  let activeVehicles = 0;
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state !== "arrived") {
      activeVehicles += 1;
    }
  }
  return {
    fingerprint: scenarioFingerprint(scenario),
    controller,
    driver: scenario.driver,
    manualIncidents,
    simulatedMs: engine.traffic.timeMs,
    trip: {
      completed: ego?.state === "arrived",
      tripTimeMs: elapsedMs,
      stoppedMs: ego?.waitTimeMs ?? 0,
      distanceM,
      averageSpeedMps: elapsedMs > 0 ? distanceM / (elapsedMs / 1000) : 0,
      rerouteCount: ego?.rerouteCount ?? 0,
    },
    city: {
      averageWaitMs: metrics.averageWaitTimeMs,
      p95WaitMs: metrics.p95WaitTimeMs,
      completedTrips: metrics.completedTrips,
      throughputPerMinute: metrics.throughputPerMinute,
      gridlockRatio: metrics.gridlockRatio,
      activeVehicles,
    },
  };
}

export type ComparisonVerdict =
  | { readonly comparable: true }
  | { readonly comparable: false; readonly reason: string };

/**
 * The comparison guard. Same world (fingerprint), same driver, and no human
 * interventions on either side — otherwise the two results are not a
 * comparison, and the UI must say so rather than show a misleading table.
 */
export function comparisonVerdict(a: ChallengeResult, b: ChallengeResult): ComparisonVerdict {
  if (a.fingerprint !== b.fingerprint) {
    return { comparable: false, reason: "different scenarios" };
  }
  if (a.controller === b.controller) {
    return { comparable: false, reason: "same controller" };
  }
  if (a.manualIncidents > 0 || b.manualIncidents > 0) {
    return { comparable: false, reason: "a run was changed by hand" };
  }
  return { comparable: true };
}
