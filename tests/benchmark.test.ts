/**
 * Benchmark harness tests (Issue #12).
 *
 * What is pinned here:
 *
 * - a repeat run is byte-identical (the harness adds no nondeterminism)
 * - Fixed and Adaptive receive the same world for one scenario: same
 *   fingerprint, same demand seed, same incident script, same spawn count
 * - runs only aggregate when trip, traffic level AND driver match
 * - the JSON contract's shape does not drift
 * - the harness runs several trips and both traffic levels
 * - the benchmark drives the same engine and controllers as production — proven
 *   by matching a benchmark run against the in-app comparison path, not by
 *   reading imports alone
 * - nothing in the harness reaches for a browser, React, MapLibre or a worker
 *
 * The smoke runs use a deliberately short horizon: this file proves the harness,
 * not the traffic (that is what `pnpm benchmark` is for).
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { aggregateRuns, groupIdOf, groupKeyOf, type ExperimentGroup } from "@/benchmark/aggregate";
import { buildDocument, formatSummary, parseArgs } from "@/benchmark/cli";
import { loadBenchmarkModel } from "@/benchmark/model";
import {
  runBenchmarkMatrix,
  runBenchmarkScenario,
  runLiveScenario,
  type BenchmarkRunRecord,
} from "@/benchmark/runner";
import {
  DEFAULT_BENCHMARK_MATRIX,
  describeMatrix,
  expandMatrix,
  withOverrides,
  type BenchmarkMatrix,
} from "@/benchmark/scenarios";
import { CURATED_TRIP_IDS } from "@/cities/chicago-trips";
import { createJevController, type JevController } from "@/controllers/jev";
import { createHttpJevClient, createMockJevClient } from "@/jev/client";
import { liveRunCapError } from "@/benchmark/cli";
import { buildScenarioRun, runComparison } from "@/worker/challenge-compare";
import { resolveScenarioWorld } from "@/worker/challenge-scenario";

const model = loadBenchmarkModel();
const SMOKE_HORIZON_MS = 30_000;

function smokeMatrix(overrides: Partial<BenchmarkMatrix> = {}): BenchmarkMatrix {
  return {
    trips: ["soldier-field-to-navy-pier"],
    trafficLevels: ["everyday"],
    seeds: [42],
    drivers: ["tourist"],
    controllers: ["fixed", "adaptive"],
    durationMs: SMOKE_HORIZON_MS,
    ...overrides,
  };
}

/** A synthetic record — for aggregation tests, where no simulation is needed. */
function record(overrides: {
  tripId?: string;
  trafficLevel?: string;
  driver?: string;
  seed?: number;
  controller?: string;
  completed?: boolean;
  tripTimeMs?: number;
  averageWaitMs?: number;
}): BenchmarkRunRecord {
  return {
    fingerprint: `fp-${overrides.tripId}-${overrides.trafficLevel}-${overrides.driver}-${overrides.seed}`,
    scenario: {
      tripId: (overrides.tripId ?? "soldier-field-to-navy-pier") as BenchmarkRunRecord["scenario"]["tripId"],
      trafficLevel: (overrides.trafficLevel ?? "everyday") as BenchmarkRunRecord["scenario"]["trafficLevel"],
      seed: overrides.seed ?? 42,
      driver: (overrides.driver ?? "tourist") as BenchmarkRunRecord["scenario"]["driver"],
      durationMs: SMOKE_HORIZON_MS,
    },
    controller: (overrides.controller ?? "fixed") as BenchmarkRunRecord["controller"],
    world: { demandSeed: 1, incidentSeed: 2, incidentEntries: 0, spawns: 10 },
    trip: {
      completed: overrides.completed ?? true,
      tripTimeMs: overrides.tripTimeMs ?? 100_000,
      stoppedMs: 10_000,
      distanceM: 4000,
      averageSpeedMps: 12,
      rerouteCount: 0,
    },
    city: {
      averageWaitMs: overrides.averageWaitMs ?? 5000,
      p95WaitMs: 20_000,
      completedTrips: 12,
      throughputPerMinute: 24,
      gridlockRatio: 0.1,
      activeVehicles: 200,
    },
  };
}

describe("benchmark matrix", () => {
  it("defaults to every curated trip, both traffic levels, both drivers, both controllers", () => {
    const matrix = DEFAULT_BENCHMARK_MATRIX;
    expect(matrix.trips).toEqual([...CURATED_TRIP_IDS]);
    expect(matrix.trafficLevels).toEqual(["everyday", "rush-hour"]);
    expect(matrix.drivers).toEqual(["tourist", "local"]);
    expect(matrix.controllers).toEqual(["fixed", "adaptive"]);
    expect(matrix.seeds.length).toBeGreaterThan(0);
    expect(expandMatrix(matrix).length).toBe(
      matrix.trips.length * matrix.trafficLevels.length * matrix.seeds.length * matrix.drivers.length,
    );
  });

  it("expands in a stable order so two runs schedule the same work", () => {
    const matrix = smokeMatrix({ trips: ["soldier-field-to-navy-pier", "millennium-park-to-west-loop"] });
    const first = expandMatrix(matrix).map((s) => `${s.tripId}|${s.trafficLevel}|${s.seed}|${s.driver}`);
    const second = expandMatrix(matrix).map((s) => `${s.tripId}|${s.trafficLevel}|${s.seed}|${s.driver}`);
    expect(first).toEqual(second);
    expect(first[0]).toContain("soldier-field-to-navy-pier");
  });

  it("applies overrides without dropping the untouched axes", () => {
    const matrix = withOverrides(DEFAULT_BENCHMARK_MATRIX, {
      trips: ["river-north-to-navy-pier"],
      seeds: [42, 2026],
    });
    expect(matrix.trips).toEqual(["river-north-to-navy-pier"]);
    expect(matrix.seeds).toEqual([42, 2026]);
    expect(matrix.trafficLevels).toEqual(DEFAULT_BENCHMARK_MATRIX.trafficLevels);
    expect(matrix.controllers).toEqual(DEFAULT_BENCHMARK_MATRIX.controllers);
    // 1 trip × 2 traffic × 2 seeds × 2 drivers = 8 scenarios × 2 controllers.
    expect(expandMatrix(matrix)).toHaveLength(8);
    expect(describeMatrix(matrix)).toContain("16 runs");
  });
});

describe("benchmark runner", () => {
  it("produces byte-identical records for a repeat run", () => {
    const scenario = { tripId: "soldier-field-to-navy-pier" as const, trafficLevel: "everyday" as const, seed: 42, driver: "tourist" as const, durationMs: SMOKE_HORIZON_MS };
    const first = runBenchmarkScenario(model, scenario, ["fixed"]);
    const second = runBenchmarkScenario(model, scenario, ["fixed"]);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("hands Fixed and Adaptive the same world for one scenario", () => {
    const scenario = { tripId: "soldier-field-to-navy-pier" as const, trafficLevel: "rush-hour" as const, seed: 42, driver: "tourist" as const, durationMs: SMOKE_HORIZON_MS };
    const [fixed, adaptive] = runBenchmarkScenario(model, scenario, ["fixed", "adaptive"]);
    expect(fixed.controller).toBe("fixed");
    expect(adaptive.controller).toBe("adaptive");
    expect(adaptive.fingerprint).toBe(fixed.fingerprint);
    expect(adaptive.world).toEqual(fixed.world);
    expect(fixed.world.spawns).toBeGreaterThan(1);
  });

  it("reports the world's own seeds in the receipt, not a restatement of the scenario", () => {
    const request = {
      tripId: "soldier-field-to-navy-pier" as const,
      trafficLevel: "rush-hour" as const,
      driver: "local" as const,
      seed: 2026,
      durationMs: SMOKE_HORIZON_MS,
    };
    const run = buildScenarioRun(model, request);
    const world = resolveScenarioWorld(model, run.trip, run.scenario);
    const [record] = runBenchmarkScenario(model, request, ["fixed"]);
    expect(record.world.demandSeed).toBe(world.demandSeed);
    expect(record.world.incidentSeed).toBe(world.incidentPlan.incidentSeed);
    expect(record.world.incidentEntries).toBe(world.incidentPlan.entries.length);
    expect(record.world.spawns).toBe(run.spawns.length);
  });

  it("runs the same engine and controllers as the in-app comparison", () => {
    const request = {
      tripId: "soldier-field-to-navy-pier" as const,
      trafficLevel: "everyday" as const,
      driver: "tourist" as const,
      seed: 42,
      durationMs: SMOKE_HORIZON_MS,
    };
    const [fixed, adaptive] = runBenchmarkScenario(model, request, ["fixed", "adaptive"]);
    const comparison = runComparison(model, request);
    expect(fixed.trip).toEqual(comparison.fixed.trip);
    expect(fixed.city).toEqual(comparison.fixed.city);
    expect(adaptive.trip).toEqual(comparison.adaptive.trip);
    expect(adaptive.city).toEqual(comparison.adaptive.city);
    expect(fixed.fingerprint).toBe(comparison.fingerprint);
  });

  it("smoke runs cover several trips and both traffic levels", () => {
    const matrix = smokeMatrix({
      trips: ["soldier-field-to-navy-pier", "river-north-to-navy-pier"],
      trafficLevels: ["everyday", "rush-hour"],
    });
    const runs = runBenchmarkMatrix(model, matrix);
    expect(runs).toHaveLength(8);
    expect(new Set(runs.map((run) => run.scenario.tripId)).size).toBe(2);
    expect(new Set(runs.map((run) => run.scenario.trafficLevel)).size).toBe(2);
    expect(new Set(runs.map((run) => run.controller))).toEqual(new Set(["fixed", "adaptive"]));
    // Every scenario contributed one run per controller, on one shared world.
    for (const run of runs) {
      const peers = runs.filter((peer) => peer.scenario.tripId === run.scenario.tripId && peer.scenario.trafficLevel === run.scenario.trafficLevel);
      expect(peers).toHaveLength(2);
      expect(peers.every((peer) => peer.fingerprint === run.fingerprint && peer.world.spawns === run.world.spawns)).toBe(true);
    }
  });
});

describe("benchmark aggregation", () => {
  it("keeps incompatible runs in separate groups", () => {
    const runs = [
      record({}),
      record({ tripId: "river-north-to-navy-pier" }),
      record({ trafficLevel: "rush-hour" }),
      record({ driver: "local" }),
    ];
    const groups = aggregateRuns(runs);
    expect(groups).toHaveLength(4);
    expect(new Set(groups.map((group) => group.id)).size).toBe(4);
    expect(groups.map((group) => group.key.tripId)).toContain("river-north-to-navy-pier");
    expect(groups.every((group) => group.controllers.every((summary) => summary.runs === 1))).toBe(true);
  });

  it("groups across seeds, never across trip, traffic or driver", () => {
    const runs = [
      record({ seed: 42, controller: "fixed" }),
      record({ seed: 2026, controller: "fixed" }),
      record({ seed: 42, controller: "adaptive" }),
      record({ seed: 2026, controller: "adaptive" }),
      record({ seed: 2026, controller: "adaptive", driver: "local" }),
    ];
    const groups = aggregateRuns(runs);
    expect(groups).toHaveLength(2);
    const shared = groups.find((group) => group.key.driver === "tourist") as ExperimentGroup;
    expect(shared.seeds).toEqual([42, 2026]);
    expect(shared.controllers.map((summary) => summary.controller)).toEqual(["adaptive", "fixed"]);
    expect(shared.controllers.every((summary) => summary.runs === 2)).toBe(true);
    const local = groups.find((group) => group.key.driver === "local") as ExperimentGroup;
    expect(local.controllers.every((summary) => summary.runs === 1)).toBe(true);
    // The compatibility rule is the grouping key itself, not a convention.
    expect(groupIdOf(groupKeyOf(runs[0]))).not.toBe(groupIdOf(groupKeyOf(runs[4])));
  });

  it("reports descriptive statistics and keeps the raw runs inspectable", () => {
    const runs = [
      record({ seed: 1, tripTimeMs: 100_000, averageWaitMs: 4000 }),
      record({ seed: 2, tripTimeMs: 200_000, averageWaitMs: 6000 }),
      record({ seed: 3, tripTimeMs: 300_000, averageWaitMs: 8000, completed: false }),
    ];
    const [group] = aggregateRuns(runs);
    const [summary] = group.controllers;
    expect(summary.runs).toBe(3);
    // Two of three completed, so the trip-time stats describe those two.
    expect(summary.completionRate).toBeCloseTo(2 / 3, 10);
    expect(summary.tripTimeMs.n).toBe(2);
    expect(summary.tripTimeMs.mean).toBe(150_000);
    // Nearest-rank, the product's own percentile rule (sim/metrics): with two
    // samples the lower one is the median.
    expect(summary.tripTimeMs.median).toBe(100_000);
    expect(summary.tripTimeMs.p95).toBe(200_000);
    // City metrics cover every run, and the raw values ride along.
    expect(summary.city.averageWaitMs.n).toBe(3);
    expect(summary.city.averageWaitMs.mean).toBe(6000);
    expect(summary.perSeed.map((entry) => entry.seed)).toEqual([1, 2, 3]);
    // No winner score: the summary reports numbers, never a verdict.
    expect(Object.keys(summary)).not.toContain("winner");
    expect(Object.keys(summary)).not.toContain("better");
  });

  it("aggregates deterministically for a fixed set of runs", () => {
    const runs = [record({ seed: 2026, controller: "adaptive" }), record({ seed: 42, controller: "fixed" })];
    expect(JSON.stringify(aggregateRuns(runs))).toBe(JSON.stringify(aggregateRuns([...runs].reverse())));
  });
});

describe("benchmark output contract", () => {
  it("keeps the JSON shape stable", () => {
    const matrix = smokeMatrix();
    const runs = runBenchmarkMatrix(model, matrix);
    const document = buildDocument(matrix, runs);
    expect(Object.keys(document)).toEqual(["version", "matrix", "runs", "groups"]);
    expect(document.version).toBe(1);
    expect(Object.keys(document.matrix)).toEqual([
      "trips",
      "trafficLevels",
      "seeds",
      "drivers",
      "controllers",
      "durationMs",
    ]);
    expect(Object.keys(runs[0])).toEqual(["fingerprint", "scenario", "controller", "world", "trip", "city"]);
    expect(Object.keys(runs[0].scenario)).toEqual(["tripId", "trafficLevel", "seed", "driver", "durationMs"]);
    expect(Object.keys(runs[0].world)).toEqual(["demandSeed", "incidentSeed", "incidentEntries", "spawns"]);
    expect(Object.keys(runs[0].trip)).toEqual([
      "completed",
      "tripTimeMs",
      "stoppedMs",
      "distanceM",
      "averageSpeedMps",
      "rerouteCount",
    ]);
    expect(Object.keys(runs[0].city)).toEqual([
      "averageWaitMs",
      "p95WaitMs",
      "completedTrips",
      "throughputPerMinute",
      "gridlockRatio",
      "activeVehicles",
    ]);
    expect(Object.keys(document.groups[0])).toEqual(["key", "id", "seeds", "controllers"]);
    expect(Object.keys(document.groups[0].controllers[0])).toEqual([
      "controller",
      "runs",
      "completionRate",
      "tripTimeMs",
      "stoppedMs",
      "averageSpeedMps",
      "distanceM",
      "rerouteCount",
      "city",
      "perSeed",
    ]);
    // The document is JSON-serialisable as-is, and free of wall-clock noise.
    const text = JSON.stringify(document);
    expect(text).not.toContain("wallMs");
    expect(text).not.toContain("generatedAt");
    expect(formatSummary(document.groups)).toContain("soldier-field-to-navy-pier");
  });

  it("writes its default output where git ignores it", () => {
    const { outPath } = parseArgs([]);
    expect(outPath?.startsWith("benchmark/results/benchmark-")).toBe(true);
    expect(outPath?.endsWith(".json")).toBe(true);
    const ignored = readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
    expect(ignored).toContain("/benchmark/results/");
  });
});

describe("benchmark CLI", () => {
  it("parses the matrix overrides", () => {
    const options = parseArgs([
      "--trip",
      "soldier-field-to-navy-pier,river-north-to-navy-pier",
      "--traffic",
      "rush-hour",
      "--driver",
      "local",
      "--seed",
      "42,2026",
      "--controllers",
      "adaptive",
      "--horizon",
      "10m",
      "--out",
      "/tmp/bench.json",
      "--quiet",
    ]);
    expect(options.overrides.trips).toEqual(["soldier-field-to-navy-pier", "river-north-to-navy-pier"]);
    expect(options.overrides.trafficLevels).toEqual(["rush-hour"]);
    expect(options.overrides.drivers).toEqual(["local"]);
    expect(options.overrides.seeds).toEqual([42, 2026]);
    expect(options.overrides.controllers).toEqual(["adaptive"]);
    expect(options.overrides.durationMs).toBe(600_000);
    expect(options.outPath).toBe("/tmp/bench.json");
    expect(options.quiet).toBe(true);
  });

  it("stamps the default output path with the run's date", () => {
    const { outPath } = parseArgs([], new Date("2026-09-21T05:06:07.890Z"));
    expect(outPath).toBe("benchmark/results/benchmark-2026-09-21_05-06-07.json");
  });

  it("accepts jev as a controller and rejects a controller it does not know", () => {
    expect(parseArgs(["--controllers", "fixed,jev"]).overrides.controllers).toEqual(["fixed", "jev"]);
    expect(() => parseArgs(["--controllers", "swarm"])).toThrow(/unknown controller/);
  });

  it("parses the jev adapter choice", () => {
    expect(parseArgs(["--controllers", "jev"]).jevAdapter).toBe("mock");
    expect(parseArgs(["--controllers", "jev", "--jev", "live"]).jevAdapter).toBe("live");
    expect(() => parseArgs(["--jev", "guess"])).toThrow(/--jev must be mock or live/);
  });

  it("refuses unknown trips, levels, drivers, controllers and horizons", () => {
    expect(() => parseArgs(["--trip", "nope"])).toThrow(/unknown trip id/);
    expect(() => parseArgs(["--traffic", "gridlock"])).toThrow(/unknown traffic level/);
    expect(() => parseArgs(["--driver", "racer"])).toThrow(/unknown driver/);
    expect(() => parseArgs(["--controllers", "swarm"])).toThrow(/unknown controller/);
    expect(() => parseArgs(["--horizon", "soon"])).toThrow(/--horizon/);
    expect(() => parseArgs(["--seed", "-1"])).toThrow(/--seed/);
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--trip"])).toThrow(/needs a value/);
  });
});

describe("benchmark stays browser-free", () => {
  it("imports no DOM, React, MapLibre, Next or worker runtime", () => {
    const files = readdirSync(path.join(process.cwd(), "benchmark"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => path.join("benchmark", name));
    expect(files.length).toBeGreaterThanOrEqual(4);
    const banned = [
      /from\s+["']react["']/,
      /from\s+["']maplibre-gl["']/,
      /from\s+["']next\//,
      /from\s+["']@\/components\//,
      /from\s+["']@\/render\//,
      /from\s+["']@\/store\//,
      // DOM / worker access, not the words themselves ("document" is a fine
      // word for a JSON document; `document.querySelector` is a browser).
      /\bwindow\s*\.\s*[A-Za-z]/,
      /\bdocument\s*\.\s*[A-Za-z]/,
      /\bglobalThis\s*\.\s*document\b/,
      /\bnew\s+Worker\s*\(/,
      /\brequestAnimationFrame\s*\(/,
    ];
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      for (const pattern of banned) {
        expect(source, `${file} must not match ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("drives the production engine and controllers through the shared seam", () => {
    const compare = readFileSync(path.join(process.cwd(), "benchmark", "runner.ts"), "utf8");
    expect(compare).toContain("buildScenarioRun");
    expect(compare).not.toContain("createEngine");
    const seam = readFileSync(path.join(process.cwd(), "worker", "challenge-compare.ts"), "utf8");
    expect(seam).toContain('from "@/sim/engine"');
    expect(seam).toContain('from "@/controllers/fixed"');
    expect(seam).toContain('from "@/controllers/adaptive"');
  });
});

/**
 * Issue #13: Jev joins the matrix through the same seam, and adding it must not
 * disturb the baseline. The mock adapter is used throughout — deterministic, no
 * network, no credential — and the live path is exercised against a stubbed
 * service, which is what makes it testable without inventing Jev's answers.
 */
describe("benchmark runs Jev through the same seam", () => {
  function jevFactories(): {
    controllers: { jev: () => JevController };
    controllersSeen: JevController[];
  } {
    const controllersSeen: JevController[] = [];
    return {
      controllersSeen,
      controllers: {
        jev: () => {
          const controller = createJevController({ client: createMockJevClient() });
          controllersSeen.push(controller);
          return controller;
        },
      },
    };
  }

  it("adds a Jev record without changing the Fixed and Adaptive records", () => {
    const matrix = smokeMatrix();
    const baseline = runBenchmarkMatrix(model, matrix);
    const withJev = runBenchmarkMatrix(model, { ...matrix, controllers: [...matrix.controllers, "jev"] }, jevFactories());
    expect(withJev).toHaveLength(3);
    const baselineRecords = withJev.filter((run) => run.controller !== "jev");
    expect(JSON.stringify(baselineRecords)).toBe(JSON.stringify(baseline));
    // Same world for all three: fingerprint and receipt are shared.
    expect(new Set(withJev.map((run) => run.fingerprint)).size).toBe(1);
    expect(new Set(withJev.map((run) => JSON.stringify(run.world))).size).toBe(1);
  });

  it("produces a deterministic Jev record with the mock adapter", () => {
    const scenario = {
      tripId: "soldier-field-to-navy-pier" as const,
      trafficLevel: "everyday" as const,
      seed: 42,
      driver: "tourist" as const,
      durationMs: SMOKE_HORIZON_MS,
    };
    const first = runBenchmarkScenario(model, scenario, ["jev"], jevFactories());
    const second = runBenchmarkScenario(model, scenario, ["jev"], jevFactories());
    expect(first[0].controller).toBe("jev");
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first[0].trip.distanceM).toBeGreaterThan(0);
  });

  it("refuses to run Jev with no adapter rather than inventing one", () => {
    const scenario = {
      tripId: "soldier-field-to-navy-pier" as const,
      trafficLevel: "everyday" as const,
      seed: 42,
      driver: "tourist" as const,
      durationMs: SMOKE_HORIZON_MS,
    };
    expect(() => runBenchmarkScenario(model, scenario, ["jev"])).toThrow(/no adapter supplied/);
  });

  it("applies live policies mid-run through the HTTP client, without a real service", async () => {
    // A stubbed service: the point is the wiring (async adapter -> policy ->
    // directives), not Jev's judgement, which no test may invent.
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as {
        schemaVersion: number;
        corridors: { corridorId: number }[];
      };
      seen.push(String(url));
      const headers = (init.headers ?? {}) as Record<string, string>;
      // The token rides in the header, never in the body.
      if (!String(headers.authorization ?? "").startsWith("Bearer ")) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
      }
      return new Response(
        JSON.stringify({
          schemaVersion: request.schemaVersion,
          pressureScale: 1.2,
          hint: "neutral",
          corridorWeights: request.corridors.slice(0, 1).map((corridor) => ({ id: corridor.corridorId, weight: 1.5 })),
          regionWeights: [],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const controllersSeen: JevController[] = [];
    const live = createHttpJevClient({
      endpoint: "https://jev.invalid/policy",
      token: "test-token-not-a-real-secret",
      fetchImpl,
    });
    const scenario = {
      tripId: "soldier-field-to-navy-pier" as const,
      trafficLevel: "everyday" as const,
      seed: 42,
      driver: "tourist" as const,
      durationMs: 20_000,
    };
    const record = await runLiveScenario(model, scenario, "jev", {
      controllers: {
        jev: () => {
          const controller = createJevController({ client: live, refreshMs: 5_000 });
          controllersSeen.push(controller);
          return controller;
        },
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((url) => url === "https://jev.invalid/policy")).toBe(true);
    expect(record.controller).toBe("jev");
    expect(record.trip.distanceM).toBeGreaterThan(0);
    // The adapter's own account: requests were made AND policies applied.
    const status = controllersSeen[0].status();
    expect(status.refreshes).toBeGreaterThan(0);
    expect(status.applied).toBeGreaterThan(0);
    expect(status.rejected).toBe(0);
    expect(controllersSeen[0].policy().pressureScale).toBe(1.2);
  });

  it("keeps a failed live service from fabricating a policy", async () => {
    const controllersSeen: JevController[] = [];
    const failing = createHttpJevClient({
      endpoint: "https://jev.invalid/policy",
      token: "test-token-not-a-real-secret",
      fetchImpl: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    });
    const scenario = {
      tripId: "soldier-field-to-navy-pier" as const,
      trafficLevel: "everyday" as const,
      seed: 42,
      driver: "tourist" as const,
      durationMs: 20_000,
    };
    const record = await runLiveScenario(model, scenario, "jev", {
      controllers: {
        jev: () => {
          const controller = createJevController({ client: failing, refreshMs: 5_000 });
          controllersSeen.push(controller);
          return controller;
        },
      },
    });
    expect(record.controller).toBe("jev");
    const status = controllersSeen[0].status();
    expect(status.applied).toBe(0);
    expect(status.rejected).toBeGreaterThan(0);
    expect(status.policySource).toBe("neutral");
    expect(status.lastError).toMatch(/500/);
  });

  it("caps a live run at a smoke size", () => {
    expect(liveRunCapError(1)).toBeNull();
    expect(liveRunCapError(8)).toBeNull();
    expect(liveRunCapError(9)).toMatch(/capped at 8/);
    expect(liveRunCapError(96)).toMatch(/narrow/);
  });
});
