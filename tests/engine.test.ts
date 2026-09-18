import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { SIMULATION_TIMESTEP_MS as DT } from "@/sim/config";
import { generateCity } from "@/sim/city-generator";
import {
  createEngine,
  runEngine,
  stepEngine,
  takeSnapshot,
  type ScheduledSpawn,
} from "@/sim/engine";
import { checkTrafficInvariants } from "@/sim/traffic";
import { makeStreet, withClosedRoads } from "./traffic-support";

const TYPES = ["car", "truck", "bicycle"] as const;

function schedule(count: number, intersections: number): ScheduledSpawn[] {
  const spawns: ScheduledSpawn[] = [];
  for (let i = 0; i < count; i += 1) {
    spawns.push({
      timeMs: (i + 1) * 2000,
      type: TYPES[i % 3],
      origin: (i * 5) % intersections,
      destination: (i * 5 + 7) % intersections,
    });
  }
  return spawns;
}

describe("simulation engine", () => {
  it("produces identical metrics and snapshots across identical runs", () => {
    const build = () =>
      createEngine({
        city: generateCity("small", 42),
        controller: createFixedController(),
        spawns: schedule(30, 12),
      });
    const a = build();
    const b = build();
    runEngine(a, 180_000);
    runEngine(b, 180_000);
    expect(a.traffic.timeMs).toBe(b.traffic.timeMs);
    expect(takeSnapshot(a)).toEqual(takeSnapshot(b));
    expect(JSON.stringify(takeSnapshot(a))).toBe(JSON.stringify(takeSnapshot(b)));
    const metrics = takeSnapshot(a).metrics;
    expect(metrics.simulatedTimeMs).toBe(180_000);
    expect(metrics.completedTrips).toBeGreaterThan(0);
  });

  it("exposes a deterministic, JSON-serializable snapshot", () => {
    const engine = createEngine({
      city: generateCity("small", 7),
      controller: createFixedController(),
      spawns: schedule(15, 12),
    });
    runEngine(engine, 30_000);
    const snapshot = takeSnapshot(engine);
    // Round-trip through JSON must be lossless.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.vehicles.length).toBe(15);
    for (const vehicle of snapshot.vehicles) {
      expect(typeof vehicle.id).toBe("number");
      expect(typeof vehicle.progress).toBe("number");
      expect(vehicle.roadId === null || typeof vehicle.roadId === "number").toBe(true);
    }
    const signalIds = snapshot.signals.map((signal) => signal.intersectionId);
    expect(signalIds).toEqual([...signalIds].sort((x, y) => x - y));
    const occupancyIds = snapshot.occupancy.map(([roadId]) => roadId);
    expect(occupancyIds).toEqual([...occupancyIds].sort((x, y) => x - y));
    for (const [, units] of snapshot.occupancy) {
      expect(units).toBeGreaterThan(0);
    }
    const metricValues = Object.values(snapshot.metrics);
    for (const value of metricValues) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it("spawns vehicles exactly at their scheduled simulation times", () => {
    const engine = createEngine({
      city: generateCity("small", 42),
      controller: createFixedController(),
      spawns: schedule(30, 12),
    });
    runEngine(engine, 4_000);
    expect(engine.traffic.vehicles.length).toBe(2);
    expect(engine.traffic.vehicles.map((vehicle) => vehicle.spawnTimeMs)).toEqual([2_000, 4_000]);
    runEngine(engine, 10_000);
    expect(engine.traffic.vehicles.length).toBe(5);
    const first = engine.traffic.vehicles[0];
    expect(first.spawnTimeMs).toBe(2_000);
    expect(first.type).toBe("car");
    expect(first.origin).toBe(0);
    expect(first.destination).toBe(7 % 12);
  });

  it("parks a scheduled vehicle as pending when the first road is full, then lets it in", () => {
    const { city } = makeStreet([{ length: 20, capacity: 1 }]);
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [
        { timeMs: 0, type: "car", origin: 0, destination: 1 },
        { timeMs: 500, type: "car", origin: 0, destination: 1 },
      ],
    });
    runEngine(engine, 1_500);
    expect(engine.traffic.vehicles[0].state).toBe("moving");
    expect(engine.traffic.vehicles[1].state).toBe("pending");
    runEngine(engine, 6_000);
    expect(engine.traffic.vehicles[1].state).toBe("arrived");
    expect(engine.traffic.vehicles[1].spawnTimeMs).toBe(500);
    expect(takeSnapshot(engine).metrics.failedSpawns).toBe(0);
  });

  it("counts spawns whose route cannot be found instead of throwing", () => {
    const { city } = makeStreet([{ length: 10 }, { length: 10 }]);
    const blocked = withClosedRoads(city, [1]);
    const engine = createEngine({
      city: blocked,
      controller: createFixedController(),
      spawns: [{ timeMs: 1_000, type: "car", origin: 0, destination: 2 }],
    });
    runEngine(engine, 3_000);
    const snapshot = takeSnapshot(engine);
    expect(snapshot.vehicles.length).toBe(0);
    expect(snapshot.metrics.failedSpawns).toBe(1);
  });

  it("drives a full generated-city run with the fixed controller and clean invariants", () => {
    const city = generateCity("medium", 42);
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: schedule(25, city.intersections.length),
    });
    let ticks = 0;
    while (engine.traffic.timeMs < 300_000) {
      stepEngine(engine);
      ticks += 1;
      if (ticks % 250 === 0) {
        expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
      }
    }
    expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
    const metrics = takeSnapshot(engine).metrics;
    expect(metrics.completedTrips).toBeGreaterThan(0);
    expect(metrics.signalPhaseChanges).toBeGreaterThan(0);
    expect(metrics.throughputPerMinute).toBeCloseTo(
      metrics.completedTrips / (metrics.simulatedTimeMs / 60_000),
      9,
    );
    expect(metrics.averageTripTimeMs).toBeGreaterThan(0);
    expect(metrics.p95WaitTimeMs).toBeGreaterThanOrEqual(metrics.averageWaitTimeMs);
  });

  it("runs until simulated time covers the requested bound", () => {
    const engine = createEngine({
      city: generateCity("small", 42),
      controller: createFixedController(),
      spawns: [],
    });
    runEngine(engine, 12_345);
    expect(engine.traffic.timeMs).toBeGreaterThanOrEqual(12_345);
    expect(engine.traffic.timeMs - 12_345).toBeLessThan(DT);
  });

  it("rejects malformed schedules", () => {
    const city = generateCity("small", 42);
    const controller = createFixedController();
    expect(() =>
      createEngine({
        city,
        controller,
        spawns: [{ timeMs: -100, type: "car", origin: 0, destination: 1 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      createEngine({
        city,
        controller,
        spawns: [{ timeMs: 100, type: "car", origin: 0, destination: 9999 }],
      }),
    ).toThrow(RangeError);
    expect(() =>
      createEngine({
        city,
        controller,
        spawns: [{ timeMs: 100, type: "train" as never, origin: 0, destination: 1 }],
      }),
    ).toThrow(RangeError);
  });
});
