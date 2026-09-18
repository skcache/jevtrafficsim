import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { generateCity } from "@/sim/city-generator";
import { generateDemand } from "@/sim/demand";
import { createEngine, runEngine, takeSnapshot } from "@/sim/engine";
import type { EngineState, ScheduledSpawn } from "@/sim/engine";
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

describe("traffic levels end to end", () => {
  it("produces meaningfully different congestion at equal city size", () => {
    // Medium city: every primary metric grows strictly with the level.
    const city = generateCity("medium", 42);
    const light = runLevel(city, "light", 42);
    const everyday = runLevel(city, "everyday", 42);
    const rush = runLevel(city, "rush-hour", 42);
    // Demand volume rises with the level.
    expect(rush.spawns.length).toBeGreaterThan(everyday.spawns.length);
    expect(everyday.spawns.length).toBeGreaterThan(light.spawns.length);
    // Throughput rises with demand (more completed trips in the same window).
    expect(rush.snapshot.metrics.completedTrips).toBeGreaterThan(
      everyday.snapshot.metrics.completedTrips,
    );
    expect(everyday.snapshot.metrics.completedTrips).toBeGreaterThan(
      light.snapshot.metrics.completedTrips,
    );
    // Congestion rises with the level (vehicle-time gridlock ratio).
    expect(rush.snapshot.metrics.gridlockRatio).toBeGreaterThan(
      everyday.snapshot.metrics.gridlockRatio,
    );
    expect(everyday.snapshot.metrics.gridlockRatio).toBeGreaterThan(
      light.snapshot.metrics.gridlockRatio,
    );
    // Wait pressure rises with the level.
    expect(rush.snapshot.metrics.averageWaitTimeMs).toBeGreaterThan(
      everyday.snapshot.metrics.averageWaitTimeMs,
    );
    expect(everyday.snapshot.metrics.averageWaitTimeMs).toBeGreaterThan(
      light.snapshot.metrics.averageWaitTimeMs,
    );
    // Approach starvation rises with the level.
    expect(rush.snapshot.metrics.maxApproachWaitMs).toBeGreaterThan(
      everyday.snapshot.metrics.maxApproachWaitMs,
    );
    expect(everyday.snapshot.metrics.maxApproachWaitMs).toBeGreaterThan(
      light.snapshot.metrics.maxApproachWaitMs,
    );
    // So does road occupancy (footprint units resident on the network).
    expect(rush.snapshot.metrics.averageRoadOccupancy).toBeGreaterThan(
      everyday.snapshot.metrics.averageRoadOccupancy,
    );
    expect(everyday.snapshot.metrics.averageRoadOccupancy).toBeGreaterThan(
      light.snapshot.metrics.averageRoadOccupancy,
    );
    // The starvation metric agrees with the engine's approach tracker.
    expect(rush.snapshot.metrics.maxApproachWaitMs).toBe(rush.engine.approaches.worstPeakWaitMs);
  });

  it("replays identically run over run", () => {
    const city = generateCity("small", 42);
    const a = runLevel(city, "rush-hour", 7);
    const b = runLevel(city, "rush-hour", 7);
    expect(a.spawns).toEqual(b.spawns);
    expect(JSON.stringify(a.snapshot)).toBe(JSON.stringify(b.snapshot));
  });

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
