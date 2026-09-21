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
import { createJevController, type JevController } from "@/controllers/jev";
import {
  createHttpJevClient,
  createMockJevClient,
  JEV_DEFAULT_TIMEOUT_MS,
  type JevClient,
} from "@/jev/client";
import {
  createGatewayJevClient,
  JEV_GATEWAY_ENDPOINT,
  JEV_GATEWAY_MODEL,
} from "@/jev/gateway";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import { type ControllerChoice } from "@/worker/protocol";
import { aggregateRuns, type ExperimentGroup } from "./aggregate";
import { loadBenchmarkModel } from "./model";
import {
  runBenchmarkMatrix,
  runBenchmarkScenario,
  runLiveScenario,
  type BenchmarkRunRecord,
  type RunProgress,
} from "./runner";
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
  --controllers <c,...>     fixed | adaptive | jev (default: fixed,adaptive)
  --jev <mock|live|gateway> how jev gets its policy (default: mock)
                              mock    = deterministic stand-in, no network, no credential
                              gateway = TypeSafe AI's jev via the Vercel AI Gateway
                                        (JEV_TOKEN + JEV_MODEL; JEV_GATEWAY_URL overrides
                                        the gateway URL)
                              live    = a service that speaks the Jev policy schema
                                        (JEV_ENDPOINT + JEV_TOKEN), called server-side
                              live and gateway refuse to run a big matrix
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
  const unknown = controllers.filter((c) => c !== "fixed" && c !== "adaptive" && c !== "jev");
  if (unknown.length > 0) {
    throw new UsageError(`unknown controller(s): ${unknown.join(", ")} (fixed | adaptive | jev)`);
  }
  return controllers as ControllerChoice[];
}

export type JevAdapterChoice = "mock" | "live" | "gateway";

function parseJevAdapter(value: string): JevAdapterChoice {
  if (value !== "mock" && value !== "live" && value !== "gateway") {
    throw new UsageError(`--jev must be mock, live or gateway (received "${value}")`);
  }
  return value;
}

export interface CliOptions {
  readonly overrides: MatrixOverrides;
  readonly outPath: string | null;
  readonly quiet: boolean;
  /** How the jev controller gets its policy when it is in the matrix. */
  readonly jevAdapter: JevAdapterChoice;
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
  let jevAdapter: JevAdapterChoice = "mock";

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
      case "--jev":
        jevAdapter = parseJevAdapter(take()[0]);
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
  return { overrides, outPath, quiet, jevAdapter };
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

/** A live matrix is a smoke run, not a benchmark: never hammer the service. */
export const LIVE_SMOKE_MAX_RUNS = 8;

/**
 * Why a live run cannot proceed, or null when it can. Kept separate from the
 * CLI so the cap is testable without running anything.
 */
export function liveRunCapError(runCount: number): string | null {
  if (runCount <= LIVE_SMOKE_MAX_RUNS) {
    return null;
  }
  return (
    `live jev runs are capped at ${LIVE_SMOKE_MAX_RUNS} (this matrix is ${runCount}) — ` +
    "narrow --trip / --seed / --driver"
  );
}

function liveJevClientFromEnv(
  adapter: "live" | "gateway",
): { client: JevClient } | { error: string } {
  const token = process.env.JEV_TOKEN?.trim();
  if (!token) {
    return {
      error:
        "a live jev run needs JEV_TOKEN in the environment — no policy is " +
        "fabricated without it (use --jev mock to exercise the seam)",
    };
  }
  const configured = Number(process.env.JEV_TIMEOUT_MS ?? JEV_DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : JEV_DEFAULT_TIMEOUT_MS;

  if (adapter === "gateway") {
    // Only the configured model is ever asked (TypeSafe AI's jev by default).
    return {
      client: createGatewayJevClient({
        token,
        endpoint: process.env.JEV_GATEWAY_URL?.trim() || JEV_GATEWAY_ENDPOINT,
        model: process.env.JEV_MODEL?.trim() || JEV_GATEWAY_MODEL,
        timeoutMs,
      }),
    };
  }

  const endpoint = process.env.JEV_ENDPOINT?.trim();
  if (!endpoint) {
    return { error: "the live adapter needs JEV_ENDPOINT in the environment" };
  }
  return { client: createHttpJevClient({ endpoint, token, timeoutMs }) };
}

/** Aggregate the adapter's own account of what it did — evidence, not a claim. */
export function describeJevStatus(controllers: readonly JevController[]): string {
  if (controllers.length === 0) {
    return "";
  }
  let refreshes = 0;
  let applied = 0;
  let rejected = 0;
  const errors = new Set<string>();
  for (const controller of controllers) {
    const status = controller.status();
    refreshes += status.refreshes;
    applied += status.applied;
    rejected += status.rejected;
    if (status.lastError !== null) {
      errors.add(status.lastError);
    }
  }
  const lines = [`jev adapter: ${refreshes} policy refreshes, ${applied} applied, ${rejected} rejected`];
  if (errors.size > 0) {
    lines.push(`  adapter errors: ${[...errors].join(" | ")}`);
  }
  return lines.join("\n");
}

/**
 * The live path: the same runs as the matrix, driven with a yield between ticks
 * so an asynchronous policy can land mid-run. Baseline controllers still go
 * through the synchronous path — only jev needs the event loop.
 */
async function runLiveMatrix(
  model: ReturnType<typeof loadBenchmarkModel>,
  matrix: BenchmarkMatrix,
  controllers: { jev?: () => ReturnType<typeof createJevController> },
  onRun: (progress: RunProgress) => void,
): Promise<BenchmarkRunRecord[]> {
  const scenarios = expandMatrix(matrix);
  const total = scenarios.length * matrix.controllers.length;
  const records: BenchmarkRunRecord[] = [];
  let index = 0;
  for (const scenario of scenarios) {
    for (const controller of matrix.controllers) {
      const record =
        controller === "jev"
          ? await runLiveScenario(model, scenario, controller, { controllers })
          : runBenchmarkScenario(model, scenario, [controller], { controllers })[0];
      records.push(record);
      index += 1;
      onRun({ index, total, scenario, controller });
    }
  }
  return records;
}

async function main(argv: readonly string[]): Promise<number> {
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
  const scenarios = expandMatrix(matrix);
  if (scenarios.length === 0) {
    process.stderr.write("the matrix is empty — nothing to run\n");
    return 2;
  }

  const wantsJev = matrix.controllers.includes("jev");
  const live = wantsJev && options.jevAdapter !== "mock";
  let jevClient: JevClient | null = null;
  if (wantsJev && live) {
    const configured = liveJevClientFromEnv(options.jevAdapter === "gateway" ? "gateway" : "live");
    if ("error" in configured) {
      process.stderr.write(`${configured.error}\n`);
      return 2;
    }
    jevClient = configured.client;
    const capError = liveRunCapError(scenarios.length * matrix.controllers.length);
    if (capError !== null) {
      process.stderr.write(`${capError}\n`);
      return 2;
    }
  } else if (wantsJev) {
    jevClient = createMockJevClient();
  }

  // One controller per run, kept so the adapter's own account can be reported.
  const jevControllers: JevController[] = [];
  const controllerFactories = jevClient
    ? {
        jev: () => {
          const controller = createJevController({ client: jevClient as JevClient });
          jevControllers.push(controller);
          return controller;
        },
      }
    : {};

  const startedAt = Date.now();
  const model = loadBenchmarkModel();
  process.stdout.write(`benchmark: ${describeMatrix(matrix)}\n`);
  if (wantsJev) {
    const adapterLabel =
      options.jevAdapter === "mock"
        ? "jev: MOCK adapter — deterministic stand-in, NOT the Jev service\n"
        : options.jevAdapter === "gateway"
          ? `jev: GATEWAY adapter — ${process.env.JEV_MODEL?.trim() || JEV_GATEWAY_MODEL} via the ` +
            "Vercel AI Gateway; results are not reproducible (wall-clock arrival)\n"
          : "jev: LIVE adapter — policies come from JEV_ENDPOINT server-side; " +
            "results are not reproducible (wall-clock arrival)\n";
    process.stdout.write(adapterLabel);
  }
  process.stdout.write(
    `city: ${model.city.roads.length} roads, ${model.city.intersections.length} intersections\n`,
  );

  const report = (progress: RunProgress): void => {
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
  };

  const runs = live
    ? await runLiveMatrix(model, matrix, controllerFactories, report)
    : runBenchmarkMatrix(model, matrix, { controllers: controllerFactories, onRun: report });

  const output = buildDocument(matrix, runs);

  const outPath = options.outPath ?? "benchmark/results/benchmark.json";
  mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  writeFileSync(path.resolve(outPath), `${JSON.stringify(output, null, 2)}\n`);

  process.stdout.write(`\n${formatSummary(output.groups)}\n`);
  if (wantsJev) {
    process.stdout.write(`\n${describeJevStatus(jevControllers)}\n`);
  }
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
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
