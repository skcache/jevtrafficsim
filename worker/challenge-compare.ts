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
import type { MaterializedCuratedTrip } from "@/cities/chicago-trips";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import type { TrafficController } from "@/controllers/contract";
import { generateDemand } from "@/sim/demand";
import { createEngine, runEngine, stepEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import type { IncidentConfig } from "@/sim/incidents";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { CuratedTripId } from "@/cities/chicago-trips";
import type { ControllerChoice } from "@/worker/protocol";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import {
  buildChallengeScenario,
  resolveScenarioWorld,
  scenarioFingerprint,
  type ChallengeScenario,
} from "@/worker/challenge-scenario";
import { buildChallengeResult, comparisonVerdict } from "@/worker/challenge-result";
import type { ChallengeResult, ComparisonVerdict } from "@/worker/challenge-result";

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

/**
 * Controllers the harness can build on its own.
 *
 * Jev is deliberately absent: its opinion arrives from outside the simulation,
 * so a caller must SUPPLY an adapter — a mock for tests and benchmark runs, the
 * HTTP client server-side. Asking for a controller with no adapter throws
 * rather than substituting something that merely looks like Jev.
 */
const DEFAULT_CONTROLLER_FACTORIES: Partial<Record<ControllerChoice, () => TrafficController>> = {
  fixed: createFixedController,
  adaptive: createAdaptiveController,
};

export interface ScenarioRunOptions {
  /**
   * Controller factories the caller supplies, keyed by controller. The fairness
   * seam is unchanged by this: whichever controllers run, they run the same
   * world, and this only decides how each one is built.
   */
  readonly controllers?: Partial<Record<ControllerChoice, () => TrafficController>>;
}

/**
 * One scenario resolved into ONE world, ready to be stepped under any
 * controller. This is the fairness seam Issue #28 rests on and what Issue #12's
 * benchmark reuses — the demand spawns and the incident script are built once,
 * here, and handed to every engine that runs the scenario.
 */
export interface ScenarioRun {
  readonly scenario: ChallengeScenario;
  readonly fingerprint: string;
  readonly trip: MaterializedCuratedTrip;
  readonly spawns: readonly ScheduledSpawn[];
  readonly incidents: IncidentConfig;
  readonly incidentEntries: number;
  /** The seed the demand was generated from — the world's, not a copy. */
  readonly demandSeed: number;
  /** Step the shared world under one controller. Deterministic per controller. */
  runUnder(controller: ControllerChoice): ChallengeResult;
  /**
   * The same world and the same engine, driven with a yield between ticks so an
   * asynchronous policy adapter can answer mid-run (live Jev smoke only).
   */
  runUnderAsync(controller: ControllerChoice): Promise<ChallengeResult>;
}

export function buildScenarioRun(
  model: MapModel,
  request: ComparisonRequest,
  options: ScenarioRunOptions = {},
): ScenarioRun {
  const scenario = buildChallengeScenario(request);
  const challenge = materializeChallengeTrip(model, request.tripId, request.seed);
  const world = resolveScenarioWorld(model, challenge.trip, scenario);

  // ONE spawn list and ONE incident script, shared by every controller.
  const spawns: ScheduledSpawn[] = [
    challenge.spawn,
    ...generateDemand({
      city: model.city,
      level: request.trafficLevel,
      seed: world.demandSeed,
      durationMs: request.durationMs,
    }),
  ];
  const incidents: IncidentConfig = {
    seed: world.incidentPlan.incidentSeed,
    script: [...world.incidentPlan.entries],
  };

  const buildEngine = (controller: ControllerChoice) => {
    const factory = options.controllers?.[controller] ?? DEFAULT_CONTROLLER_FACTORIES[controller];
    if (!factory) {
      throw new Error(
        `no adapter supplied for the "${controller}" controller — pass one via ScenarioRunOptions.controllers`,
      );
    }
    return createEngine({
      city: model.city,
      controller: factory(),
      spawns,
      driver: request.driver,
      incidents,
    });
  };

  return {
    scenario,
    fingerprint: scenarioFingerprint(scenario),
    trip: challenge.trip,
    spawns,
    incidents,
    incidentEntries: world.incidentPlan.entries.length,
    demandSeed: world.demandSeed,
    runUnder: (controller) => {
      const engine = buildEngine(controller);
      runEngine(engine, request.durationMs);
      return buildChallengeResult(engine, scenario, controller, 0);
    },
    runUnderAsync: async (controller) => {
      const engine = buildEngine(controller);
      await runEngineAsync(engine, request.durationMs);
      return buildChallengeResult(engine, scenario, controller, 0);
    },
  };
}

/**
 * The same engine and the same ticks as `runEngine`, with a macrotask yield
 * between them so an ASYNCHRONOUS controller can settle mid-run: a live policy
 * adapter needs the event loop to turn before its answer can be applied. Used
 * by the benchmark's live Jev smoke run; the matrix and every test use the
 * synchronous loop, which is what keeps them reproducible.
 */
export async function runEngineAsync(engine: EngineState, untilMs: number): Promise<void> {
  if (!Number.isFinite(untilMs) || untilMs < 0) {
    throw new RangeError(`untilMs must be finite and >= 0, received ${untilMs}`);
  }
  while (engine.traffic.timeMs < untilMs) {
    stepEngine(engine);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

export function runComparison(
  model: MapModel,
  request: ComparisonRequest,
  options: ScenarioRunOptions = {},
): ComparisonOutcome {
  const run = buildScenarioRun(model, request, options);
  const fixed = run.runUnder("fixed");
  const adaptive = run.runUnder("adaptive");
  return {
    fingerprint: run.fingerprint,
    driver: request.driver,
    tripId: request.tripId,
    trafficLevel: request.trafficLevel,
    fixed,
    adaptive,
    verdict: comparisonVerdict(fixed, adaptive),
    incidentEntries: run.incidentEntries,
  };
}
