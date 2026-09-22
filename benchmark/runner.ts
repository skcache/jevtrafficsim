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
import {
  buildScenarioRun,
  type AsyncRunOptions,
  type ScenarioRunOptions,
} from "@/worker/challenge-compare";
import type { ChallengeCityResult, ChallengeResult, ChallengeTripResult } from "@/worker/challenge-result";
import type { ControllerChoice } from "@/worker/protocol";
import type { JevProvenance } from "@/jev/provenance";
import { expandMatrix, type BenchmarkMatrix, type BenchmarkScenario } from "./scenarios";

/** Everything one run produced. This is the per-run JSON contract. */
interface BenchmarkRunBase {
  /** Scenario identity: equal for every controller that ran this world. */
  readonly fingerprint: string;
  readonly scenario: {
    readonly tripId: CuratedTripId;
    readonly trafficLevel: TrafficLevel;
    readonly seed: number;
    readonly driver: DriverStrategy;
    readonly durationMs: number;
  };
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

/** Jev cannot exist as a machine-readable record without its provenance. */
export type BenchmarkRunRecord = BenchmarkRunBase & (
  | { readonly controller: "jev"; readonly provenance: JevProvenance }
  | { readonly controller: "fixed" | "adaptive"; readonly provenance?: never }
);

function recordFrom(
  run: ReturnType<typeof buildScenarioRun>,
  scenario: BenchmarkScenario,
  controller: ControllerChoice,
  result: ChallengeResult,
  provenance?: JevProvenance,
): BenchmarkRunRecord {
  const common: BenchmarkRunBase & { readonly controller: ControllerChoice } = {
    fingerprint: run.fingerprint,
    scenario: { ...scenario },
    controller,
    world: {
      demandSeed: run.demandSeed,
      incidentSeed: run.incidents.seed,
      incidentEntries: run.incidentEntries,
      spawns: run.spawns.length,
    },
    trip: result.trip,
    city: result.city,
  };
  if (controller === "jev") {
    if (provenance?.controller !== "jev") {
      throw new Error("Jev benchmark run requires authoritative provenance");
    }
    return { ...common, controller, provenance };
  }
  if (provenance !== undefined) {
    throw new Error("baseline benchmark run cannot carry Jev provenance");
  }
  return { ...common, controller };
}

/**
 * Run one scenario under every listed controller, on ONE shared world.
 * Deterministic: identical inputs produce identical records, byte for byte.
 *
 * `options.controllers` supplies factories for controllers the harness cannot
 * build alone — Jev, whose opinion comes from outside the simulation (a mock
 * here, the HTTP client in a live smoke run). The world is built once either
 * way, so adding a controller never changes what the others were handed.
 */
/** Per-run provenance about a controller (Issue #38). */
export interface ControllerDescriber {
  readonly describeController?: (
    controller: ControllerChoice,
  ) => JevProvenance | undefined;
}

export function runBenchmarkScenario(
  model: MapModel,
  scenario: BenchmarkScenario,
  controllers: readonly ControllerChoice[],
  options: ScenarioRunOptions & ControllerDescriber = {},
): BenchmarkRunRecord[] {
  const run = buildScenarioRun(model, scenarioRequest(scenario), options);
  return controllers.map((controller) =>
    recordFrom(
      run,
      scenario,
      controller,
      run.runUnder(controller),
      options.describeController?.(controller),
    ),
  );
}

/**
 * Run one scenario against an ASYNCHRONOUS adapter (a live Jev smoke run): the
 * same world and the same engine, driven with a yield between ticks so the
 * adapter's answer can land mid-run. Not used by the matrix, and not
 * reproducible by design — a live policy arrives on wall-clock time.
 */
export async function runLiveScenario(
  model: MapModel,
  scenario: BenchmarkScenario,
  controller: ControllerChoice,
  options: ScenarioRunOptions & AsyncRunOptions & ControllerDescriber = {},
): Promise<BenchmarkRunRecord> {
  const run = buildScenarioRun(model, scenarioRequest(scenario), options);
  const result = await run.runUnderAsync(controller, { paceRatio: options.paceRatio });
  return recordFrom(run, scenario, controller, result, options.describeController?.(controller));
}

function scenarioRequest(scenario: BenchmarkScenario): {
  tripId: BenchmarkScenario["tripId"];
  trafficLevel: BenchmarkScenario["trafficLevel"];
  driver: BenchmarkScenario["driver"];
  seed: number;
  durationMs: number;
} {
  return {
    tripId: scenario.tripId,
    trafficLevel: scenario.trafficLevel,
    driver: scenario.driver,
    seed: scenario.seed,
    durationMs: scenario.durationMs,
  };
}

export interface RunProgress {
  readonly index: number;
  readonly total: number;
  readonly scenario: BenchmarkScenario;
  readonly controller: ControllerChoice;
}

export interface BenchmarkRunOptions extends ScenarioRunOptions, ControllerDescriber, AsyncRunOptions {
  /** Called after each run finishes, for CLI progress only. */
  readonly onRun?: (progress: RunProgress) => void;
}

/**
 * Run a whole matrix in its stable expansion order. `options.onRun` is called
 * after each controller finishes, for CLI progress only — it cannot change
 * results, and `options.controllers` only decides how each controller is built.
 */
export function runBenchmarkMatrix(
  model: MapModel,
  matrix: BenchmarkMatrix,
  options: BenchmarkRunOptions = {},
): BenchmarkRunRecord[] {
  const scenarios = expandMatrix(matrix);
  const records: BenchmarkRunRecord[] = [];
  let index = 0;
  for (const scenario of scenarios) {
    for (const record of runBenchmarkScenario(model, scenario, matrix.controllers, options)) {
      records.push(record);
      index += 1;
      options.onRun?.({
        index,
        total: scenarios.length * matrix.controllers.length,
        scenario,
        controller: record.controller,
      });
    }
  }
  return records;
}
