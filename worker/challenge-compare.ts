/**
 * Headless fair comparison (Issue #28).
 *
 * One scenario, one world, two controllers. The demand spawns and the incident
 * script are built ONCE and handed to both engines, so the two runs differ in
 * exactly one respect: the policy driving the signals. Nothing is posted to the
 * main thread while this runs — the comparison is about results, not frames.
 *
 * This lives beside the worker so it can reuse the same geography loading and
 * the same demand/incident builders the live run uses; there is no second
 * simulation path.
 */
import type { MapModel } from "@/cities/map-model";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { generateDemand } from "@/sim/demand";
import { createEngine, runEngine, type ScheduledSpawn } from "@/sim/engine";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { CuratedTripId } from "@/cities/chicago-trips";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import {
  buildChallengeScenario,
  resolveScenarioWorld,
  scenarioFingerprint,
} from "@/worker/challenge-scenario";
import { buildChallengeResult, comparisonVerdict } from "@/worker/challenge-result";
import type { ComparisonVerdict } from "@/worker/challenge-result";

export interface ComparisonOutcome {
  readonly fingerprint: string;
  readonly driver: DriverStrategy;
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly fixed: ReturnType<typeof buildChallengeResult>;
  readonly adaptive: ReturnType<typeof buildChallengeResult>;
  readonly verdict: ComparisonVerdict;
  readonly incidentEntries: number;
}

export interface ComparisonRequest {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly durationMs: number;
}

export function runComparison(model: MapModel, request: ComparisonRequest): ComparisonOutcome {
  const scenario = buildChallengeScenario(request);
  const challenge = materializeChallengeTrip(model, request.tripId, request.seed);
  const world = resolveScenarioWorld(model, challenge.trip, scenario);

  // ONE spawn list and ONE incident script, shared by both engines.
  const spawns: ScheduledSpawn[] = [
    challenge.spawn,
    ...generateDemand({
      city: model.city,
      level: request.trafficLevel,
      seed: world.demandSeed,
      durationMs: request.durationMs,
    }),
  ];
  const incidents = {
    seed: world.incidentPlan.incidentSeed,
    script: [...world.incidentPlan.entries],
  };

  const runUnder = (controller: "fixed" | "adaptive") => {
    const engine = createEngine({
      city: model.city,
      controller: controller === "fixed" ? createFixedController() : createAdaptiveController(),
      spawns,
      driver: request.driver,
      incidents,
    });
    runEngine(engine, request.durationMs);
    return buildChallengeResult(engine, scenario, controller, 0);
  };

  const fixed = runUnder("fixed");
  const adaptive = runUnder("adaptive");
  return {
    fingerprint: scenarioFingerprint(scenario),
    driver: request.driver,
    tripId: request.tripId,
    trafficLevel: request.trafficLevel,
    fixed,
    adaptive,
    verdict: comparisonVerdict(fixed, adaptive),
    incidentEntries: world.incidentPlan.entries.length,
  };
}
