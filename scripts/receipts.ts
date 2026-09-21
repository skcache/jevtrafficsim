/**
 * Deterministic receipts (Issue #40, Phase 5).
 *
 * A receipt is the whole observable outcome of one scenario run, serialized
 * canonically: the ChallengeResult, the final SimulationMetrics, arrival order
 * and times, the ego trip result, incident outcomes and the scenario
 * fingerprint. Written once against the pre-refactor engine and committed as a
 * fixture, then re-checked by `tests/sim-receipts.test.ts` — so "the simulation
 * result did not change" is a hash comparison, not a claim.
 *
 *   npx tsx scripts/receipts.ts write tests/fixtures/sim-receipts.json
 *   npx tsx scripts/receipts.ts show  tests/fixtures/sim-receipts.json
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { loadBenchmarkModel } from "@/benchmark/model";
import { generateDemand } from "@/sim/demand";
import { createEngine, runEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import type { ControllerChoice } from "@/worker/protocol";
import { buildChallengeResult } from "@/worker/challenge-result";
import { buildChallengeScenario, resolveScenarioWorld, scenarioFingerprint } from "@/worker/challenge-scenario";
import { buildPresentationMetrics } from "@/worker/presentation-snapshot";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import type { CuratedTripId } from "@/cities/chicago-trips";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";

export const RECEIPT_HORIZON_MS = 600_000;

export interface ReceiptCase {
  readonly name: string;
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly controller: ControllerChoice;
}

/** The pinned scenarios: both baselines, both traffic levels, both drivers. */
export const RECEIPT_CASES: readonly ReceiptCase[] = [
  { name: "soldier-adaptive-rush", tripId: "soldier-field-to-navy-pier", trafficLevel: "rush-hour", driver: "tourist", seed: 42, controller: "adaptive" },
  { name: "soldier-fixed-rush", tripId: "soldier-field-to-navy-pier", trafficLevel: "rush-hour", driver: "tourist", seed: 42, controller: "fixed" },
  { name: "soldier-fixed-everyday", tripId: "soldier-field-to-navy-pier", trafficLevel: "everyday", driver: "tourist", seed: 42, controller: "fixed" },
  { name: "soldier-adaptive-everyday-local", tripId: "soldier-field-to-navy-pier", trafficLevel: "everyday", driver: "local", seed: 7, controller: "adaptive" },
  { name: "united-adaptive-rush", tripId: "united-center-to-willis-tower", trafficLevel: "rush-hour", driver: "local", seed: 11, controller: "adaptive" },
  { name: "river-north-fixed-everyday", tripId: "river-north-to-navy-pier", trafficLevel: "everyday", driver: "tourist", seed: 3, controller: "fixed" },
];

export interface Receipt {
  readonly name: string;
  /** Canonical JSON of everything observable. */
  readonly body: string;
  readonly hash: string;
  readonly result: ReturnType<typeof buildChallengeResult>;
  readonly metrics: ReturnType<typeof buildPresentationMetrics>;
}

/** Spawned / active / arrived / pending at the final tick. */
function populationOf(engine: EngineState): Record<string, number> {
  let active = 0;
  let arrived = 0;
  let pending = 0;
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state === "arrived") arrived += 1;
    else if (vehicle.state === "pending") pending += 1;
    else active += 1;
  }
  return { spawned: engine.traffic.vehicles.length, active, arrived, pending };
}

export function runReceiptCase(testCase: ReceiptCase): Receipt {
  const model = loadBenchmarkModel();
  const challenge = materializeChallengeTrip(model, testCase.tripId, testCase.seed);
  const scenario = buildChallengeScenario({
    tripId: testCase.tripId,
    trafficLevel: testCase.trafficLevel,
    driver: testCase.driver,
    seed: testCase.seed,
    durationMs: RECEIPT_HORIZON_MS,
  });
  const world = resolveScenarioWorld(model, challenge.trip, scenario);
  const spawns: ScheduledSpawn[] = [
    challenge.spawn,
    ...generateDemand({
      city: model.city,
      level: testCase.trafficLevel,
      seed: world.demandSeed,
      durationMs: RECEIPT_HORIZON_MS,
    }),
  ];
  const engine: EngineState = createEngine({
    city: model.city,
    controller: testCase.controller === "fixed" ? createFixedController() : createAdaptiveController(),
    spawns,
    driver: testCase.driver,
    incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
  });
  runEngine(engine, RECEIPT_HORIZON_MS);

  const result = buildChallengeResult(
    engine,
    scenario,
    testCase.controller,
    0,
    false,
  );
  const metrics = buildPresentationMetrics(engine);
  // Arrival history is part of the receipt: counts, order and per-vehicle times.
  const arrivals = engine.metrics.arrivals.map((arrival) => ({
    vehicleId: arrival.vehicleId,
    tripTimeMs: arrival.tripTimeMs,
    waitTimeMs: arrival.waitTimeMs,
    routeDistance: arrival.routeDistance,
  }));
  // Incident outcomes as the engine itself reports them, fields in a fixed order.
  const incidents = engine.incidents.records.map((record) => ({
    id: record.id,
    kind: record.kind,
    status: record.status,
    scheduledAtMs: record.scheduledAtMs,
    activatedAtMs: record.activatedAtMs,
    expiresAtMs: record.expiresAtMs,
    roadIds: [...record.roadIds],
    eventCenterIntersectionId: record.eventCenterIntersectionId,
    injectedSpawnCount: record.injectedSpawnCount,
    affectedVehicleCount: record.affectedVehicleCount,
    successfulReroutes: record.successfulReroutes,
    failedReroutes: record.failedReroutes,
  }));
  const body = JSON.stringify({
    case: testCase,
    fingerprint: scenarioFingerprint(scenario),
    result,
    metrics,
    arrivals,
    incidents,
    // Frozen plan entries: the adversity every controller received.
    plan: world.incidentPlan.entries,
    vehicleCount: engine.traffic.vehicles.length,
    population: populationOf(engine),
    ticks: engine.ticks,
  });
  return {
    name: testCase.name,
    body,
    hash: createHash("sha256").update(body).digest("hex").slice(0, 16),
    result,
    metrics,
  };
}

function main(): void {
  const [action, path] = process.argv.slice(2);
  if (action === "write") {
    const receipts = RECEIPT_CASES.map((testCase) => {
      const receipt = runReceiptCase(testCase);
      console.log(`${receipt.hash}  ${receipt.name}`);
      return { name: receipt.name, hash: receipt.hash, body: receipt.body };
    });
    writeFileSync(path, `${JSON.stringify({ horizonMs: RECEIPT_HORIZON_MS, receipts }, null, 2)}\n`);
    console.log(`wrote ${receipts.length} receipts to ${path}`);
    return;
  }
  if (action === "show") {
    const file = JSON.parse(readFileSync(path, "utf8")) as {
      receipts: readonly { name: string; hash: string }[];
    };
    for (const receipt of file.receipts) {
      console.log(`${receipt.hash}  ${receipt.name}`);
    }
    return;
  }
  throw new Error("usage: receipts.ts <write|show> <path>");
}

if (process.argv[1]?.includes("receipts.ts") === true) {
  main();
}
