/**
 * Benchmark runner (Issue #12): one scenario, one world, every controller.
 *
 * The world — demand spawns, incident script, geography, fingerprint — comes
 * from `buildScenarioRun`, the SAME seam the in-app Fixed-vs-Adaptive
 * comparison uses (Issue #28). The benchmark adds no simulation of its own: it
 * expands a matrix, steps each scenario's shared world once per controller, and
 * records what the engine produced.
 *
 * The record carries a world receipt (demand seed, incident seed, spawn count)
 * beside the fingerprint, so a reader can verify that two controllers ran the
 * same city without re-deriving it.
 */
import type { MapModel } from "@/cities/map-model";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { CuratedTripId } from "@/cities/chicago-trips";
import { buildScenarioRun } from "@/worker/challenge-compare";
import type { ChallengeCityResult, ChallengeTripResult } from "@/worker/challenge-result";
import type { ControllerChoice } from "@/worker/protocol";
import { expandMatrix, type BenchmarkMatrix, type BenchmarkScenario } from "./scenarios";

/** Everything one run produced. This is the per-run JSON contract. */
export interface BenchmarkRunRecord {
  /** Scenario identity: equal for every controller that ran this world. */
  readonly fingerprint: string;
  readonly scenario: {
    readonly tripId: CuratedTripId;
    readonly trafficLevel: TrafficLevel;
    readonly seed: number;
    readonly driver: DriverStrategy;
    readonly durationMs: number;
  };
  readonly controller: ControllerChoice;
  /** Receipt of the shared world: identical across controllers of one scenario. */
  readonly world: {
    readonly demandSeed: number;
    readonly incidentSeed: number;
    readonly incidentEntries: number;
    readonly spawns: number;
  };
  /** YOUR TRIP. */
  readonly trip: ChallengeTripResult;
  /** CHICAGO. */
  readonly city: ChallengeCityResult;
}

/**
 * Run one scenario under every listed controller, on ONE shared world.
 * Deterministic: identical inputs produce identical records, byte for byte.
 */
export function runBenchmarkScenario(
  model: MapModel,
  scenario: BenchmarkScenario,
  controllers: readonly ControllerChoice[],
): BenchmarkRunRecord[] {
  const run = buildScenarioRun(model, {
    tripId: scenario.tripId,
    trafficLevel: scenario.trafficLevel,
    driver: scenario.driver,
    seed: scenario.seed,
    durationMs: scenario.durationMs,
  });
  const world = {
    demandSeed: run.demandSeed,
    incidentSeed: run.incidents.seed,
    incidentEntries: run.incidentEntries,
    spawns: run.spawns.length,
  };
  return controllers.map((controller) => {
    const result = run.runUnder(controller);
    return {
      fingerprint: run.fingerprint,
      scenario: { ...scenario },
      controller,
      world,
      trip: result.trip,
      city: result.city,
    };
  });
}

export interface RunProgress {
  readonly index: number;
  readonly total: number;
  readonly scenario: BenchmarkScenario;
  readonly controller: ControllerChoice;
}

/**
 * Run a whole matrix in its stable expansion order. `onRun` is called after
 * each controller finishes, for CLI progress only — it cannot change results.
 */
export function runBenchmarkMatrix(
  model: MapModel,
  matrix: BenchmarkMatrix,
  onRun?: (progress: RunProgress) => void,
): BenchmarkRunRecord[] {
  const scenarios = expandMatrix(matrix);
  const records: BenchmarkRunRecord[] = [];
  let index = 0;
  for (const scenario of scenarios) {
    for (const record of runBenchmarkScenario(model, scenario, matrix.controllers)) {
      records.push(record);
      index += 1;
      onRun?.({ index, total: scenarios.length * matrix.controllers.length, scenario, controller: record.controller });
    }
  }
  return records;
}
