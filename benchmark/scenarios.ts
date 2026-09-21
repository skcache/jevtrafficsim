/**
 * The benchmark scenario matrix (Issue #12).
 *
 * A matrix is the cartesian product of five explicit lists — trips, traffic
 * levels, seeds, drivers, controllers — plus the run horizon. It is data, not
 * code: change the default here, or override any axis from the CLI, and the
 * harness expands it in a stable order.
 *
 * Controllers are an axis of the matrix, but NOT of the scenario: one scenario
 * (trip + traffic + seed + driver) resolves to one world, and every controller
 * in the list runs that same world. That is what makes the runs comparable, and
 * it is the only place the two dimensions are allowed to meet.
 */
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import { LIVE_RUN_HORIZON_MS, type ControllerChoice } from "@/worker/protocol";

export interface BenchmarkMatrix {
  readonly trips: readonly CuratedTripId[];
  readonly trafficLevels: readonly TrafficLevel[];
  readonly seeds: readonly number[];
  readonly drivers: readonly DriverStrategy[];
  readonly controllers: readonly ControllerChoice[];
  /** Simulated run length per scenario. The live horizon by default. */
  readonly durationMs: number;
}

/**
 * One scenario — everything except the controller. A scenario resolves to
 * exactly one world, so its fingerprint is the same for every controller that
 * runs it.
 */
export interface BenchmarkScenario {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly seed: number;
  readonly driver: DriverStrategy;
  readonly durationMs: number;
}

/**
 * The default matrix: every curated trip, both traffic levels, two seeds, both
 * drivers, both controllers, at the live horizon. Two seeds is what makes the
 * aggregate descriptive (mean/median/p95 across seeds) rather than a single
 * sample; pass `--seed 42` to halve the runtime, or add more with a list.
 */
export const DEFAULT_BENCHMARK_MATRIX: BenchmarkMatrix = {
  trips: [...CURATED_TRIP_IDS],
  trafficLevels: ["everyday", "rush-hour"],
  seeds: [42, 2026],
  drivers: ["tourist", "local"],
  controllers: ["fixed", "adaptive"],
  durationMs: LIVE_RUN_HORIZON_MS,
};

/** Stable identity of a scenario: what must match for runs to be comparable. */
export function scenarioKey(scenario: BenchmarkScenario): string {
  return [scenario.tripId, scenario.trafficLevel, scenario.seed, scenario.driver, scenario.durationMs].join(
    "|",
  );
}

/**
 * Expand the matrix in a fixed order (trips, then traffic, then seeds, then
 * drivers). Deterministic: the same matrix always yields the same run order,
 * so a benchmark's output can be diffed across invocations.
 */
export function expandMatrix(matrix: BenchmarkMatrix): BenchmarkScenario[] {
  const scenarios: BenchmarkScenario[] = [];
  for (const tripId of matrix.trips) {
    for (const trafficLevel of matrix.trafficLevels) {
      for (const seed of matrix.seeds) {
        for (const driver of matrix.drivers) {
          scenarios.push({ tripId, trafficLevel, seed, driver, durationMs: matrix.durationMs });
        }
      }
    }
  }
  return scenarios;
}

export interface MatrixOverrides {
  readonly trips?: readonly CuratedTripId[];
  readonly trafficLevels?: readonly TrafficLevel[];
  readonly seeds?: readonly number[];
  readonly drivers?: readonly DriverStrategy[];
  readonly controllers?: readonly ControllerChoice[];
  readonly durationMs?: number;
}

/** Apply CLI overrides onto a base matrix (defaults: the default matrix). */
export function withOverrides(
  base: BenchmarkMatrix,
  overrides: MatrixOverrides,
): BenchmarkMatrix {
  return {
    trips: overrides.trips ?? base.trips,
    trafficLevels: overrides.trafficLevels ?? base.trafficLevels,
    seeds: overrides.seeds ?? base.seeds,
    drivers: overrides.drivers ?? base.drivers,
    controllers: overrides.controllers ?? base.controllers,
    durationMs: overrides.durationMs ?? base.durationMs,
  };
}

/** One line describing what a matrix will run, for the CLI header. */
export function describeMatrix(matrix: BenchmarkMatrix): string {
  const scenarios = expandMatrix(matrix).length;
  const runs = scenarios * matrix.controllers.length;
  return (
    `${matrix.trips.length} trips × ${matrix.trafficLevels.length} traffic × ` +
    `${matrix.seeds.length} seeds × ${matrix.drivers.length} drivers = ${scenarios} scenarios, ` +
    `× ${matrix.controllers.length} controllers (${matrix.controllers.join(", ")}) = ${runs} runs, ` +
    `${matrix.durationMs} ms each`
  );
}
