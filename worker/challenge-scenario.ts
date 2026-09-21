/**
 * The challenge scenario (Issue #28): everything that defines the WORLD a run
 * happens in — and nothing about who is driving the city.
 *
 * Controller identity is deliberately absent. The same scenario must produce the
 * same demand, the same incident script and the same starting conditions under
 * Fixed, Adaptive or a future Jev; only the signals' behaviour may differ. The
 * scenario fingerprint is what makes a comparison honest: two results may only
 * be put side by side when their fingerprints match.
 *
 * The incident plan itself comes from worker/challenge-incidents.ts, which was
 * already built controller-neutral (issue #27). It needs the map model, so the
 * scenario stores the inputs and resolves the world once the model is loaded —
 * the plan is a pure function of (tripId, trafficLevel, seed), which is exactly
 * what the fingerprint covers.
 */
import type { MapModel } from "@/cities/map-model";
import type { CuratedTripId, MaterializedCuratedTrip } from "@/cities/chicago-trips";
import type { TrafficLevel } from "@/sim/types";
import type { DriverStrategy } from "@/sim/driver";
import {
  buildChallengeIncidentPlan,
  type ChallengeIncidentPlan,
} from "@/worker/challenge-incidents";

export interface ChallengeScenario {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  /** Deterministic world seed. Internal: never presented as a primary control. */
  readonly seed: number;
  readonly durationMs: number;
}

/**
 * The resolved world inputs a run is built from — demand and incident script,
 * with no controller and no driver in sight. The fairness tests use this to
 * prove Fixed and Adaptive are handed the same city.
 */
/** Build the scenario from its inputs. Pure: no model, no controller. */
export function buildChallengeScenario(input: ChallengeScenario): ChallengeScenario {
  return {
    tripId: input.tripId,
    trafficLevel: input.trafficLevel,
    driver: input.driver,
    seed: input.seed >>> 0,
    durationMs: input.durationMs,
  };
}

export interface ScenarioWorld {
  readonly demandSeed: number;
  readonly incidentPlan: ChallengeIncidentPlan;
  readonly durationMs: number;
}

/**
 * The scenario fingerprint for a run configuration (Issue #14 closeout).
 *
 * A live policy controller must be bound to the identity of the scenario it
 * serves — the runtime uses it to decide which responses are still valid, and
 * the trace it records carries it. This is the one way to get that value from a
 * run config, so no caller can invent a placeholder: the value is derived from
 * the same scenario the challenge harness would build.
 */
export function fingerprintForRun(
  input: Parameters<typeof buildChallengeScenario>[0],
): string {
  return scenarioFingerprint(buildChallengeScenario(input));
}

export function resolveScenarioWorld(
  model: MapModel,
  trip: MaterializedCuratedTrip,
  scenario: ChallengeScenario,
): ScenarioWorld {
  return {
    demandSeed: scenario.seed,
    incidentPlan: buildChallengeIncidentPlan(model, trip, scenario.trafficLevel, scenario.seed),
    durationMs: scenario.durationMs,
  };
}

/**
 * FNV-1a over the scenario's canonical fields. Deterministic, order-stable and
 * short enough to show in the UI. Because demand and the incident script are
 * pure functions of these fields, equal fingerprints mean an equal world.
 */
export function scenarioFingerprint(scenario: ChallengeScenario): string {
  const canonical = JSON.stringify([
    scenario.tripId,
    scenario.trafficLevel,
    scenario.driver,
    scenario.seed >>> 0,
    scenario.durationMs,
  ]);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Two scenarios are comparable only when they describe the same world. */
export function sameScenario(a: ChallengeScenario, b: ChallengeScenario): boolean {
  return scenarioFingerprint(a) === scenarioFingerprint(b);
}
