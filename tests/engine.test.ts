import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { findRoute } from "@/sim/astar";
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
import type { Intersection, Road } from "@/sim/types";
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
    runEngine(engine, 30_100); // the 30000ms event enters with the 30000->30100 tick
    const snapshot = takeSnapshot(engine);
    // Round-trip through JSON must be lossless.
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.vehicles.length).toBe(15);
    for (const vehicle of snapshot.vehicles) {
      expect(typeof vehicle.id).toBe("number");
      expect(typeof vehicle.progress).toBe("number");
      expect(typeof vehicle.routeIndex).toBe("number");
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

  it("processes scheduled spawns at the start of their tick", () => {
    const { city } = makeStreet([{ length: 100 }]);
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [
        { timeMs: 0, type: "car", origin: 0, destination: 1 },
        { timeMs: 100, type: "car", origin: 0, destination: 1 },
        { timeMs: 50, type: "car", origin: 0, destination: 1 },
      ],
    });
    expect(engine.traffic.vehicles.length).toBe(0); // no vehicles before the first step
    stepEngine(engine); // tick 1: T=0 spawns, then that vehicle moves this very tick
    expect(engine.traffic.vehicles.length).toBe(1);
    const t0 = engine.traffic.vehicles[0];
    expect(t0.spawnTimeMs).toBe(0);
    expect(t0.progress).toBe(1); // participated in tick 1
    stepEngine(engine); // tick 2: T=100 — the t=100 event and the snapped t=50 event enter
    expect(engine.traffic.vehicles.length).toBe(3);
    const snapped = engine.traffic.vehicles[1];
    const t100 = engine.traffic.vehicles[2];
    expect(snapped.spawnTimeMs).toBe(100); // t=50 snapped forward to the tick grid
    expect(t100.spawnTimeMs).toBe(100);
    expect(snapped.progress).toBe(1); // moved only in its entry tick — nothing before it
    expect(t100.progress).toBe(1);
    expect(t0.progress).toBe(2);
  });

  it("spawns vehicles at their scheduled simulation times", () => {
    const engine = createEngine({
      city: generateCity("small", 42),
      controller: createFixedController(),
      spawns: schedule(30, 12),
    });
    runEngine(engine, 4_100);
    expect(engine.traffic.vehicles.length).toBe(2);
    expect(engine.traffic.vehicles.map((vehicle) => vehicle.spawnTimeMs)).toEqual([2_000, 4_000]);
    const first = engine.traffic.vehicles[0];
    expect(first.type).toBe("car");
    expect(first.origin).toBe(0);
    expect(first.destination).toBe(7 % 12);
    // A 6000ms event enters with the 6000->6100 tick, not at the 6000ms boundary.
    runEngine(engine, 6_000);
    expect(engine.traffic.vehicles.length).toBe(2);
    runEngine(engine, 6_100);
    expect(engine.traffic.vehicles.length).toBe(3);
    expect(engine.traffic.vehicles[2].spawnTimeMs).toBe(6_000);
  });

  it("parks a scheduled vehicle as pending when the first road is full, then lets it in", () => {
    // Capacity 2 with one car aboard: 1 + 1 > 1.8, so the second car waits.
    const { city } = makeStreet([{ length: 20, capacity: 2 }]);
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

  it("routes scheduled spawns with live occupancy (congestion-aware initial routing)", () => {
    // Path A (free-flow 3.0s): rA1 (len 20, cap 2) + rA2 (len 10).
    // Path B (free-flow 3.6s): rB1 (len 20) + rB2 (len 16).
    // Node 1 is signalized: rA1's approach group is red first, so X parks on
    // rA1 and its live occupancy (1 of 2 units) makes path A cost
    // 2.0 * (1 + 0.5) + 1.0 = 4.0s — B becomes cheaper.
    // Geometry must stay coherent (every road.length >= euclidean endpoint
    // distance) or the admissible heuristic loses admissibility.
    const nodes: Intersection[] = [
      { id: 0, x: 0, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 1, x: 0, y: 20, incoming: [], outgoing: [], control: "signal", regionId: 0 },
      { id: 2, x: -6, y: 17, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 3, x: 0, y: 30, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 4, x: -20, y: 20, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    ];
    const roads: Road[] = [
      { id: 0, from: 0, to: 1, length: 20, lanes: 1, speedLimit: 10, capacity: 2, kind: "local", closed: false }, // rA1
      { id: 1, from: 1, to: 3, length: 10, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // rA2
      { id: 2, from: 0, to: 2, length: 20, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // rB1
      { id: 3, from: 2, to: 3, length: 16, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // rB2
      { id: 4, from: 4, to: 1, length: 20, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // second approach for the signal
    ];
    for (const road of roads) {
      nodes[road.from].outgoing.push(road.id);
      nodes[road.to].incoming.push(road.id);
    }
    const city = {
      size: "small" as const,
      seed: 0,
      gridWidth: 2,
      gridHeight: 2,
      intersections: nodes,
      roads,
      corridors: [],
    };
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [
        { timeMs: 0, type: "car", origin: 0, destination: 3 },
        { timeMs: 4_000, type: "car", origin: 0, destination: 3 },
      ],
    });
    runEngine(engine, 4_100);
    const [first, second] = engine.traffic.vehicles;
    // X picked the free-flow winner and is now queued at the red signal,
    // loading rA1's occupancy (1 of 2 units).
    expect(first.route).toEqual([0, 1]);
    expect(first.state).toBe("queued");
    expect(first.roadId).toBe(0);
    expect(engine.traffic.occupancy.get(0)).toBe(1);
    // Y (spawned at 4000ms) saw live occupancy and chose path B instead.
    expect(second.route).toEqual([2, 3]);
    // Without occupancy the router still prefers path A — the engine really
    // supplied the live map.
    const probe = findRoute(city, 0, 3);
    expect(probe.found).toBe(true);
    if (probe.found) {
      expect(probe.roadIds).toEqual([0, 1]);
    }
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
    expect(metrics.averageWaitTimeMs).toBeGreaterThanOrEqual(0);
    expect(metrics.p95WaitTimeMs).toBeGreaterThanOrEqual(0);
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
