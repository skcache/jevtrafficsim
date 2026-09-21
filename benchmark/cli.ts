/**
 * Benchmark CLI (Issue #12): `pnpm benchmark`.
 *
 *   pnpm benchmark                                  # the default matrix
 *   pnpm benchmark --trip soldier-field-to-navy-pier --traffic rush-hour
 *   pnpm benchmark --driver tourist --seed 42,2026 --out /tmp/bench.json
 *
 * Writes one JSON document (matrix + every run + the aggregates) to a local,
 * gitignored path and prints a readable summary. Browser-free: this is the same
 * engine, the same controllers and the same geography the app runs, driven from
 * Node with no DOM, no React, no MapLibre and no worker.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import { type ControllerChoice } from "@/worker/protocol";
import { aggregateRuns, type ExperimentGroup } from "./aggregate";
import { loadBenchmarkModel } from "./model";
import { runBenchmarkMatrix, type BenchmarkRunRecord } from "./runner";
import {
  DEFAULT_BENCHMARK_MATRIX,
  describeMatrix,
  expandMatrix,
  withOverrides,
  type BenchmarkMatrix,
  type MatrixOverrides,
} from "./scenarios";

/** The JSON contract. Deterministic: no timestamps, no wall times. */
export interface BenchmarkDocument {
  readonly version: 1;
  readonly matrix: BenchmarkMatrix;
  readonly runs: readonly BenchmarkRunRecord[];
  readonly groups: readonly ExperimentGroup[];
}

const USAGE = `pnpm benchmark [options]

Options:
  --trip <id,...>           curated trip ids (default: all ${CURATED_TRIP_IDS.length})
  --traffic <level,...>     everyday | rush-hour (default: both)
  --driver <name,...>       tourist | local (default: both)
  --seed <n,...>            deterministic seeds (default: 42)
  --controllers <c,...>     fixed | adaptive (default: both)
  --horizon <ms|Ns|Nm>      simulated run length (default: the live horizon)
  --out <path>              JSON output (default: benchmark/results/benchmark-<stamp>.json)
  --quiet                   only the final summary
  --help                    this text

Trips: ${CURATED_TRIP_IDS.join(", ")}`;

class UsageError extends Error {}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseHorizon(value: string): number {
  const match = /^(\d+)(ms|s|m)?$/.exec(value.trim());
  if (!match) {
    throw new UsageError(`--horizon must be a duration like 600000, 600s or 10m (received "${value}")`);
  }
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const ms = unit === "ms" ? amount : unit === "s" ? amount * 1000 : amount * 60_000;
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new UsageError(`--horizon must be positive (received "${value}")`);
  }
  return ms;
}

function parseSeeds(values: readonly string[]): number[] {
  const seeds = values.flatMap(splitList).map((entry) => {
    const seed = Number(entry);
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
      throw new UsageError(`--seed must be an integer in [0, 4294967295] (received "${entry}")`);
    }
    return seed;
  });
  if (seeds.length === 0) {
    throw new UsageError("--seed needs at least one value");
  }
  return [...new Set(seeds)];
}

function parseTrips(values: readonly string[]): CuratedTripId[] {
  const ids = values.flatMap(splitList);
  const unknown = ids.filter((id) => !CURATED_TRIP_IDS.includes(id as CuratedTripId));
  if (unknown.length > 0) {
    throw new UsageError(`unknown trip id(s): ${unknown.join(", ")}\nKnown: ${CURATED_TRIP_IDS.join(", ")}`);
  }
  return ids as CuratedTripId[];
}

function parseLevels(values: readonly string[]): TrafficLevel[] {
  const levels = values.flatMap(splitList);
  const unknown = levels.filter((level) => level !== "everyday" && level !== "rush-hour");
  if (unknown.length > 0) {
    throw new UsageError(`unknown traffic level(s): ${unknown.join(", ")} (everyday | rush-hour)`);
  }
  return levels as TrafficLevel[];
}

function parseDrivers(values: readonly string[]): DriverStrategy[] {
  const drivers = values.flatMap(splitList);
  const unknown = drivers.filter((driver) => driver !== "tourist" && driver !== "local");
  if (unknown.length > 0) {
    throw new UsageError(`unknown driver(s): ${unknown.join(", ")} (tourist | local)`);
  }
  return drivers as DriverStrategy[];
}

function parseControllers(values: readonly string[]): ControllerChoice[] {
  const controllers = values.flatMap(splitList);
  const unknown = controllers.filter((c) => c !== "fixed" && c !== "adaptive");
  if (unknown.length > 0) {
    throw new UsageError(`unknown controller(s): ${unknown.join(", ")} (fixed | adaptive)`);
  }
  return controllers as ControllerChoice[];
}

export interface CliOptions {
  readonly overrides: MatrixOverrides;
  readonly outPath: string | null;
  readonly quiet: boolean;
}

/** Parse argv (without node/script) into options. Throws UsageError on bad input. */
export function parseArgs(argv: readonly string[], now: Date = new Date()): CliOptions {
  const overrides: {
    trips?: CuratedTripId[];
    trafficLevels?: TrafficLevel[];
    seeds?: number[];
    drivers?: DriverStrategy[];
    controllers?: ControllerChoice[];
    durationMs?: number;
  } = {};
  let outPath: string | null = null;
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (): string[] => {
      index += 1;
      if (index >= argv.length) {
        throw new UsageError(`${arg} needs a value`);
      }
      return [argv[index]];
    };
    switch (arg) {
      case "--help":
      case "-h":
        throw new UsageError(USAGE);
      case "--trip":
        overrides.trips = [...(overrides.trips ?? []), ...parseTrips(take())];
        break;
      case "--traffic":
        overrides.trafficLevels = [...(overrides.trafficLevels ?? []), ...parseLevels(take())];
        break;
      case "--driver":
        overrides.drivers = [...(overrides.drivers ?? []), ...parseDrivers(take())];
        break;
      case "--seed":
        overrides.seeds = parseSeeds([...(overrides.seeds ?? []).map(String), ...take()]);
        break;
      case "--controllers":
        overrides.controllers = parseControllers(take());
        break;
      case "--horizon":
        overrides.durationMs = parseHorizon(take()[0]);
        break;
      case "--out":
        outPath = take()[0];
        break;
      case "--quiet":
        quiet = true;
        break;
      default:
        throw new UsageError(`unknown option "${arg}"\n\n${USAGE}`);
    }
  }
  if (outPath === null) {
    const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
    outPath = path.join("benchmark", "results", `benchmark-${stamp}.json`);
  }
  return { overrides, outPath, quiet };
}

const pad = (value: string, width: number): string => value.padEnd(width, " ").slice(0, width);
const num = (value: number, digits = 0): string => value.toFixed(digits);

function seconds(ms: number): string {
  return `${num(ms / 1000, 1)}s`;
}

/** Human-readable summary of the aggregates (stdout only — not the JSON). */
export function formatSummary(groups: readonly ExperimentGroup[]): string {
  const lines: string[] = [];
  lines.push(
    [
      pad("trip", 32),
      pad("traffic", 10),
      pad("driver", 8),
      pad("controller", 10),
      pad("done", 6),
      pad("trip mean", 10),
      pad("trip p95", 10),
      pad("wait mean", 10),
      pad("wait p95", 10),
      pad("thru/min", 9),
      pad("gridlock", 9),
      pad("active", 7),
    ].join(" "),
  );
  for (const group of groups) {
    for (const summary of group.controllers) {
      lines.push(
        [
          pad(group.key.tripId, 32),
          pad(group.key.trafficLevel, 10),
          pad(group.key.driver, 8),
          pad(summary.controller, 10),
          pad(`${num(summary.completionRate * 100)}%`, 6),
          pad(seconds(summary.tripTimeMs.mean), 10),
          pad(seconds(summary.tripTimeMs.p95), 10),
          pad(seconds(summary.city.averageWaitMs.mean), 10),
          pad(seconds(summary.city.p95WaitMs.mean), 10),
          pad(num(summary.city.throughputPerMinute.mean, 1), 9),
          pad(num(summary.city.gridlockRatio.mean, 3), 9),
          pad(num(summary.city.activeVehicles.mean), 7),
        ].join(" "),
      );
    }
  }
  return lines.join("\n");
}

/** Assemble the output document: matrix + every run + the aggregates. */
export function buildDocument(
  matrix: BenchmarkMatrix,
  runs: readonly BenchmarkRunRecord[],
): BenchmarkDocument {
  return { version: 1, matrix, runs, groups: aggregateRuns(runs) };
}

function main(argv: readonly string[]): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${message}\n`);
    // `--help` travels as a UsageError carrying the usage text: print it, exit 0.
    return error instanceof UsageError && message === USAGE ? 0 : 2;
  }

  const matrix = withOverrides(DEFAULT_BENCHMARK_MATRIX, options.overrides);
  if (expandMatrix(matrix).length === 0) {
    process.stderr.write("the matrix is empty — nothing to run\n");
    return 2;
  }

  const startedAt = Date.now();
  const model = loadBenchmarkModel();
  process.stdout.write(`benchmark: ${describeMatrix(matrix)}\n`);
  process.stdout.write(`city: ${model.city.roads.length} roads, ${model.city.intersections.length} intersections\n`);

  const runs = runBenchmarkMatrix(model, matrix, (progress) => {
    if (options.quiet) {
      return;
    }
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(0);
    process.stdout.write(
      `[${String(progress.index).padStart(3)}/${progress.total}] ` +
        `${progress.scenario.tripId} ${progress.scenario.trafficLevel} ` +
        `seed=${progress.scenario.seed} ${progress.scenario.driver} ${progress.controller} ` +
        `(${elapsed}s)\n`,
    );
  });

  const output = buildDocument(matrix, runs);

  const outPath = options.outPath ?? "benchmark/results/benchmark.json";
  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(path.resolve(outPath), `${JSON.stringify(output, null, 2)}\n`);

  process.stdout.write(`\n${formatSummary(output.groups)}\n`);
  process.stdout.write(
    `\n${runs.length} runs, ${output.groups.length} compatible groups, ` +
      `${((Date.now() - startedAt) / 1000).toFixed(0)}s wall time\n` +
      `wrote ${path.resolve(outPath)}\n`,
  );
  return 0;
}

/**
 * Run when executed (`pnpm benchmark`), stay silent when imported by a test.
 * `require` only exists under the CLI runner, so this guard is safe in ESM too.
 */
if (typeof require !== "undefined" && require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
