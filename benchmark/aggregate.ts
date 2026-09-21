/**
 * Benchmark aggregation (Issue #12).
 *
 * Rules, in order of importance:
 *
 * 1. Only compatible runs share a summary. Compatibility is trip + traffic
 *    level + driver — the three inputs that change what "good" means. Seeds are
 *    the axis we average over; controllers are the axis we compare along.
 * 2. Descriptive statistics only. Mean, median, p95 and completion rate, with
 *    the sample size attached. There is deliberately NO winner score: ranking
 *    controllers is a judgement about a product, and this file only measures.
 * 3. Raw numbers stay inspectable. Every summary carries the per-seed values it
 *    was computed from, so a reader can audit any aggregate back to a run.
 *
 * Trip-time statistics cover COMPLETED runs only (an unfinished run's clock is
 * the horizon, not a trip time) and say so via `n`. City statistics cover every
 * run in the group. Completion rate covers every run.
 */
import { percentile } from "@/sim/metrics";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { CuratedTripId } from "@/cities/chicago-trips";
import type { ChallengeCityResult, ChallengeTripResult } from "@/worker/challenge-result";
import type { ControllerChoice } from "@/worker/protocol";
import type { BenchmarkRunRecord } from "./runner";

/**
 * Mean / median / p95 over n samples, using the product's percentile rule.
 * The median is the nearest-rank one from `sim/metrics` (with an even sample
 * count that is the lower middle), so a benchmark percentile and a HUD
 * percentile mean the same thing.
 */
export interface DescriptiveStats {
  readonly n: number;
  readonly mean: number;
  readonly median: number;
  readonly p95: number;
}

export function describe(values: readonly number[]): DescriptiveStats {
  if (values.length === 0) {
    return { n: 0, mean: 0, median: 0, p95: 0 };
  }
  let total = 0;
  for (const value of values) {
    total += value;
  }
  return {
    n: values.length,
    mean: total / values.length,
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
  };
}

export interface ExperimentGroupKey {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
}

/**
 * The compatibility rule, as a function. Two runs may share a summary only when
 * these three match; everything else (seed, controller, horizon) is either
 * averaged over or compared along.
 */
export function groupKeyOf(run: BenchmarkRunRecord): ExperimentGroupKey {
  return {
    tripId: run.scenario.tripId,
    trafficLevel: run.scenario.trafficLevel,
    driver: run.scenario.driver,
  };
}

export function groupIdOf(key: ExperimentGroupKey): string {
  return `${key.tripId}|${key.trafficLevel}|${key.driver}`;
}

/** One controller's summary inside one compatible group. */
export interface ControllerGroupSummary {
  readonly controller: ControllerChoice;
  readonly runs: number;
  /** Completed runs / all runs, in [0, 1]. */
  readonly completionRate: number;
  /** Completed runs only (`n` is the number of completed runs). */
  readonly tripTimeMs: DescriptiveStats;
  readonly stoppedMs: DescriptiveStats;
  readonly averageSpeedMps: DescriptiveStats;
  /** All runs in the group. */
  readonly distanceM: DescriptiveStats;
  readonly rerouteCount: DescriptiveStats;
  readonly city: {
    readonly averageWaitMs: DescriptiveStats;
    readonly p95WaitMs: DescriptiveStats;
    readonly completedTrips: DescriptiveStats;
    readonly throughputPerMinute: DescriptiveStats;
    readonly gridlockRatio: DescriptiveStats;
    readonly activeVehicles: DescriptiveStats;
  };
  /** The raw per-seed numbers behind every stat above, in seed order. */
  readonly perSeed: readonly {
    readonly seed: number;
    readonly trip: ChallengeTripResult;
    readonly city: ChallengeCityResult;
  }[];
}

export interface ExperimentGroup {
  readonly key: ExperimentGroupKey;
  readonly id: string;
  readonly seeds: readonly number[];
  readonly controllers: readonly ControllerGroupSummary[];
}

function summarizeController(
  controller: ControllerChoice,
  runs: readonly BenchmarkRunRecord[],
): ControllerGroupSummary {
  const ordered = [...runs].sort((a, b) => a.scenario.seed - b.scenario.seed);
  const completed = ordered.filter((run) => run.trip.completed);
  const completedRuns = completed.length;
  const values = (pick: (run: BenchmarkRunRecord) => number) => ordered.map(pick);
  const completedValues = (pick: (run: BenchmarkRunRecord) => number) => completed.map(pick);
  return {
    controller,
    runs: ordered.length,
    completionRate: ordered.length === 0 ? 0 : completedRuns / ordered.length,
    tripTimeMs: describe(completedValues((run) => run.trip.tripTimeMs)),
    stoppedMs: describe(completedValues((run) => run.trip.stoppedMs)),
    averageSpeedMps: describe(completedValues((run) => run.trip.averageSpeedMps)),
    distanceM: describe(values((run) => run.trip.distanceM)),
    rerouteCount: describe(values((run) => run.trip.rerouteCount)),
    city: {
      averageWaitMs: describe(values((run) => run.city.averageWaitMs)),
      p95WaitMs: describe(values((run) => run.city.p95WaitMs)),
      completedTrips: describe(values((run) => run.city.completedTrips)),
      throughputPerMinute: describe(values((run) => run.city.throughputPerMinute)),
      gridlockRatio: describe(values((run) => run.city.gridlockRatio)),
      activeVehicles: describe(values((run) => run.city.activeVehicles)),
    },
    perSeed: ordered.map((run) => ({ seed: run.scenario.seed, trip: run.trip, city: run.city })),
  };
}

/**
 * Aggregate runs into compatible groups. The output is ordered by group id and,
 * inside a group, by controller id, so the same runs always aggregate to the
 * same document.
 */
export function aggregateRuns(runs: readonly BenchmarkRunRecord[]): ExperimentGroup[] {
  const groups = new Map<string, { key: ExperimentGroupKey; runs: BenchmarkRunRecord[] }>();
  for (const run of runs) {
    const key = groupKeyOf(run);
    const id = groupIdOf(key);
    const existing = groups.get(id);
    if (existing) {
      existing.runs.push(run);
    } else {
      groups.set(id, { key, runs: [run] });
    }
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, group]) => {
      const controllers = [...new Set(group.runs.map((run) => run.controller))].sort();
      return {
        key: group.key,
        id,
        seeds: [...new Set(group.runs.map((run) => run.scenario.seed))].sort((a, b) => a - b),
        controllers: controllers.map((controller) =>
          summarizeController(
            controller,
            group.runs.filter((run) => run.controller === controller),
          ),
        ),
      };
    });
}
