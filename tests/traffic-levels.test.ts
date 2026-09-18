import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { generateCity } from "@/sim/city-generator";
import { generateDemand } from "@/sim/demand";
import { createEngine, runEngine, takeSnapshot } from "@/sim/engine";
import type { EngineState, ScheduledSpawn } from "@/sim/engine";
import type { SimulationMetrics } from "@/sim/metrics";
import { checkTrafficInvariants } from "@/sim/traffic";
import type { City, VehicleType } from "@/sim/types";
import type { TrafficLevel } from "@/sim/types";

function runLevel(city: City, level: TrafficLevel, seed: number, durationMs = 300_000) {
  const spawns = generateDemand({ city, level, seed, durationMs });
  const engine = createEngine({ city, controller: createFixedController(), spawns });
  runEngine(engine, durationMs);
  return { engine, snapshot: takeSnapshot(engine), spawns };
}

function manualSchedule(count: number, intersections: number, type: VehicleType): ScheduledSpawn[] {
  const spawns: ScheduledSpawn[] = [];
  for (let i = 0; i < count; i += 1) {
    spawns.push({
      timeMs: i * 2_000,
      type,
      origin: (i * 5) % intersections,
      destination: (i * 5 + 7) % intersections,
    });
  }
  return spawns;
}

function runSchedule(city: City, spawns: ScheduledSpawn[]): EngineState {
  const engine = createEngine({ city, controller: createFixedController(), spawns });
  runEngine(engine, 300_000);
  return engine;
}

function expectMetricsFinite(metrics: SimulationMetrics): void {
  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number") {
      expect(Number.isFinite(value), `${key} must be finite`).toBe(true);
    }
  }
}

/**
 * Rush must offer materially more demand than Light (not merely more).
 */
const DEMAND_MATERIAL_FACTOR = 1.5;

/**
 * At least ONE congestion-pressure metric must move materially between Light
 * and Rush. Traffic systems are nonlinear and later controllers may
 * legitimately cross individual metrics — so the end-to-end contract is
 * deliberately not a per-metric monotonicity requirement.
 */
const CONGESTION_MATERIAL_FACTOR = 1.25;

const CONGESTION_METRICS: Array<[string, (m: SimulationMetrics) => number]> = [
  ["gridlockRatio", (m) => m.gridlockRatio],
  ["averageWaitTimeMs", (m) => m.averageWaitTimeMs],
  ["p95WaitTimeMs", (m) => m.p95WaitTimeMs],
  ["maxApproachWaitMs", (m) => m.maxApproachWaitMs],
  ["averageRoadOccupancy", (m) => m.averageRoadOccupancy],
];

describe("traffic levels end to end", () => {
  it("gives rush material demand and congestion pressure over light (medium, seed 42)", () => {
    const city = generateCity("medium", 42);
    const light = runLevel(city, "light", 42);
    const everyday = runLevel(city, "everyday", 42);
    const rush = runLevel(city, "rush-hour", 42);

    // Workload structure: strictly more demand with each level.
    expect(rush.spawns.length).toBeGreaterThan(everyday.spawns.length);
    expect(everyday.spawns.length).toBeGreaterThan(light.spawns.length);
    expect(rush.spawns.length).toBeGreaterThanOrEqual(
      light.spawns.length * DEMAND_MATERIAL_FACTOR,
    );

    // The three levels produce genuinely different final states.
    const lightJson = JSON.stringify(light.snapshot);
    const everydayJson = JSON.stringify(everyday.snapshot);
    const rushJson = JSON.stringify(rush.snapshot);
    expect(rushJson).not.toBe(lightJson);
    expect(rushJson).not.toBe(everydayJson);
    expect(everydayJson).not.toBe(lightJson);

    // Rush must be genuinely congested, not just busier.
    expect(rush.snapshot.metrics.gridlockRatio).toBeGreaterThan(0);
    expect(rush.snapshot.metrics.maxApproachWaitMs).toBeGreaterThan(0);
    expect(rush.snapshot.metrics.maxWaitTimeMs).toBeGreaterThan(0);

    // At least one congestion-pressure metric differs materially light -> rush.
    const moved = CONGESTION_METRICS.some(([, read]) => {
      const from = read(light.snapshot.metrics);
      const to = read(rush.snapshot.metrics);
      return from > 0 && to / from >= CONGESTION_MATERIAL_FACTOR;
    });
    expect(moved).toBe(true);

    // All metrics and all traffic invariants are sane at every level.
    for (const run of [light, everyday, rush]) {
      expectMetricsFinite(run.snapshot.metrics);
      expect(checkTrafficInvariants(city, run.engine.traffic)).toEqual([]);
    }
    // The starvation metric agrees with the engine's approach tracker.
    expect(rush.snapshot.metrics.maxApproachWaitMs).toBe(rush.engine.approaches.worstPeakWaitMs);
  }, 120_000);

  it("replays identically run over run, and different seeds differ", () => {
    const city = generateCity("small", 42);
    const a = runLevel(city, "rush-hour", 7);
    const b = runLevel(city, "rush-hour", 7);
    expect(a.spawns).toEqual(b.spawns);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
    expect(checkTrafficInvariants(city, a.engine.traffic)).toEqual([]);

    const other = runLevel(city, "rush-hour", 8);
    expect(other.spawns).not.toEqual(a.spawns);
    expect(JSON.stringify(other.snapshot)).not.toBe(JSON.stringify(a.snapshot));
  }, 120_000);

  it("shows heavier vehicle classes loading the network harder", () => {
    const city = generateCity("small", 42);
    const carSnapshot = takeSnapshot(
      runSchedule(city, manualSchedule(60, city.intersections.length, "car")),
    );
    const truckSnapshot = takeSnapshot(
      runSchedule(city, manualSchedule(60, city.intersections.length, "truck")),
    );
    const bicycleSnapshot = takeSnapshot(
      runSchedule(city, manualSchedule(60, city.intersections.length, "bicycle")),
    );
    // Trucks carry double footprint and move slower: more occupancy units on
    // the roads for longer, and visibly longer trips.
    expect(truckSnapshot.metrics.averageRoadOccupancy).toBeGreaterThan(
      carSnapshot.metrics.averageRoadOccupancy,
    );
    expect(truckSnapshot.metrics.maxRoadOccupancy).toBeGreaterThan(
      carSnapshot.metrics.maxRoadOccupancy,
    );
    expect(truckSnapshot.metrics.averageTripTimeMs).toBeGreaterThan(
      carSnapshot.metrics.averageTripTimeMs,
    );
    // Bicycles are the lightest footprint on the network.
    expect(bicycleSnapshot.metrics.averageRoadOccupancy).toBeLessThan(
      carSnapshot.metrics.averageRoadOccupancy,
    );
  });
});
