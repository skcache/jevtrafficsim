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
import type { JevAdapter, JevProvenance } from "@/jev/provenance";
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

/**
 * Provenance of one summary (Issue #38). Runs with different provenance are not
 * merged: a mock Jev run and a gateway Jev run of the same scenario appear as
 * separate entries, because averaging them would hide exactly the fact a reader
 * needs. `label` is the primary token ("jev-mock", "jev-gateway", ...); it is
 * "unknown" only for records written before #38.
 */
export interface GroupProvenance {
  readonly label: string;
  readonly adapter: JevAdapter | "unknown";
  readonly mode: "live" | "replay" | "unknown";
  readonly modelInvolved: boolean;
  /** Sums over the entry's runs; for a replay these describe the replay itself. */
  readonly accepted: number;
  readonly rejected: number;
  readonly liveMs: number;
  readonly replayMs: number;
  readonly fallbackMs: number;
  readonly traceEvents: number;
  /** What a replay's trace came from, or null when not a replay / not recorded. */
  readonly recordedAdapter: JevAdapter | null;
}

/** One controller's summary inside one compatible group. */
export interface ControllerGroupSummary {
  readonly controller: ControllerChoice;
  /** Unique within a group: controller + provenance label. */
  readonly id: string;
  /** What produced these runs. Present for Jev; null for Fixed/Adaptive. */
  readonly provenance: GroupProvenance | null;
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

function provenanceOf(runs: readonly BenchmarkRunRecord[]): GroupProvenance | null {
  const jev = runs.find((run) => run.provenance !== undefined)?.provenance;
  if (jev === undefined) {
    return null;
  }
  const total = (pick: (provenance: JevProvenance) => number): number =>
    runs.reduce((sum, run) => sum + (run.provenance === undefined ? 0 : pick(run.provenance)), 0);
  return {
    label: jev.label,
    adapter: jev.adapter,
    mode: jev.mode,
    modelInvolved: jev.modelInvolved,
    accepted: total((provenance) => provenance.accepted),
    rejected: total((provenance) => provenance.rejected),
    liveMs: total((provenance) => provenance.liveMs),
    replayMs: total((provenance) => provenance.replayMs),
    fallbackMs: total((provenance) => provenance.fallbackMs),
    traceEvents: total((provenance) => provenance.traceEvents),
    recordedAdapter: jev.recorded?.adapter ?? null,
  };
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
    id: `${controller}#${provenanceOf(ordered)?.label ?? "none"}`,
    provenance: provenanceOf(ordered),
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
      // Runs are keyed by controller AND provenance: two Jev runs that used
      // different sources are different experiments and never share a summary.
      const cells = new Map<string, { controller: ControllerChoice; runs: BenchmarkRunRecord[] }>();
      for (const run of group.runs) {
        const label = run.provenance?.label ?? "none";
        const cellId = `${run.controller}#${label}`;
        const cell = cells.get(cellId) ?? { controller: run.controller, runs: [] };
        cell.runs.push(run);
        cells.set(cellId, cell);
      }
      return {
        key: group.key,
        id,
        seeds: [...new Set(group.runs.map((run) => run.scenario.seed))].sort((a, b) => a - b),
        controllers: [...cells.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([, cell]) => summarizeController(cell.controller, cell.runs)),
      };
    });
}
