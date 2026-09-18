import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { createAdaptiveController } from "@/controllers/adaptive";
import {
  createEngine,
  queueIncident,
  runEngine,
  setEngineController,
  stepEngine,
  takeSnapshot,
  type ScheduledSpawn,
} from "@/sim/engine";
import { checkTrafficInvariants } from "@/sim/traffic";
import type { City, Intersection, Road } from "@/sim/types";

/** Simple two-route city (mirrors the Task-10 incident fixtures). */
function routeCity(): City {
  const intersections: Intersection[] = [
    { id: 0, x: 0, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 1, x: 10, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 2, x: 0, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 3, x: 10, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
  ];
  // Path A = [0, 4] costs 8 free-flow; path B = [2, 6] costs 16, so live
  // occupancy can never flip the free-flow winner (A stays cheapest).
  const road = (id: number, from: number, to: number, length: number): Road => ({
    id,
    from,
    to,
    length,
    lanes: 1,
    speedLimit: 10,
    capacity: 4,
    kind: "local",
    closed: false,
  });
  const roads: Road[] = [
    road(0, 0, 1, 40),
    road(1, 1, 0, 40),
    road(2, 0, 2, 80),
    road(3, 2, 0, 80),
    road(4, 1, 3, 40),
    road(5, 3, 1, 40),
    road(6, 2, 3, 80),
    road(7, 3, 2, 80),
  ];
  for (const r of roads) {
    intersections[r.from].outgoing.push(r.id);
    intersections[r.to].incoming.push(r.id);
  }
  return { size: "small", seed: 0, gridWidth: 2, gridHeight: 2, intersections, roads, corridors: [] };
}

const CAR = "car" as const;

describe("runtime incident injection (queueIncident)", () => {
  it("schedules a crash on an engine created with no incidents, activating next tick", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [
      { timeMs: 0, type: CAR, origin: 0, destination: 3 },
      { timeMs: 0, type: CAR, origin: 0, destination: 3 },
      { timeMs: 0, type: CAR, origin: 0, destination: 3 },
    ];
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 300);
    // No incident config was supplied; runtime injection still works.
    const id = queueIncident(engine, { kind: "crash", targetRoadId: 0, durationMs: 2_000 });
    expect(id).toBe(0);
    const before = engine.incidents.records[0];
    expect(before.status).toBe("pending");
    expect(before.scheduledAtMs).toBe(300); // current simulation time
    expect(engine.city.roads[0].capacity).toBe(4);
    // The next incident phase runs at the start of the next tick, whose clock
    // still reads 300 — the crash is active for the 300 -> 400 tick.
    stepEngine(engine);
    expect(engine.incidents.records[0].status).toBe("active");
    expect(engine.incidents.records[0].activatedAtMs).toBe(300);
    expect(engine.traffic.timeMs).toBe(400);
    // 3.0 resident > desired 2.0 -> effective capacity 3, resident intact.
    expect(engine.city.roads[0].capacity).toBe(3);
    expect(engine.traffic.occupancy.get(0)).toBe(3);
    expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
  });

  it("preserves insertion order for same-time interactive incidents", () => {
    const city = routeCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [],
    });
    runEngine(engine, 500);
    const first = queueIncident(engine, { kind: "close-road", targetRoadId: 4, durationMs: 5_000 });
    const second = queueIncident(engine, { kind: "close-road", targetRoadId: 6, durationMs: 5_000 });
    const third = queueIncident(engine, { kind: "crash", targetRoadId: 2, durationMs: 5_000 });
    expect([first, second, third]).toEqual([0, 1, 2]);
    expect(engine.incidents.records.map((record) => record.id)).toEqual([0, 1, 2]);
    // (atMs, sequence) order is preserved by construction.
    for (let i = 1; i < engine.incidents.records.length; i += 1) {
      const previous = engine.incidents.records[i - 1];
      const current = engine.incidents.records[i];
      expect(
        previous.scheduledAtMs < current.scheduledAtMs ||
          (previous.scheduledAtMs === current.scheduledAtMs && previous.id < current.id),
      ).toBe(true);
    }
  });

  it("splices an interactive entry among future scripted ones by (atMs, sequence)", () => {
    const city = routeCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [],
      incidents: {
        seed: 5,
        script: [{ atMs: 10_000, kind: "close-road", targetRoadId: 4, durationMs: 5_000 }],
      },
    });
    runEngine(engine, 1_000);
    queueIncident(engine, { kind: "crash", targetRoadId: 2, durationMs: 5_000 }); // at 1000
    const records = engine.incidents.records;
    expect(records.map((record) => [record.scheduledAtMs, record.id])).toEqual([
      [1_000, 1], // interactive: sequence 1 (after base script length 1... id 1)
      [10_000, 0],
    ]);
  });

  it("rejects invalid entries with the shared script validation", () => {
    const city = routeCity();
    const engine = createEngine({ city, controller: createFixedController(), spawns: [] });
    expect(() => queueIncident(engine, { kind: "crash", targetRoadId: 99 })).toThrow(RangeError);
    expect(() =>
      queueIncident(engine, { kind: "bridge-closed", targetRoadId: 0 }),
    ).toThrow(RangeError); // road 0 is not a bridge
    expect(() =>
      queueIncident(engine, { kind: "traffic-burst", targetRoadId: 0 }),
    ).toThrow(RangeError);
    // Nothing was recorded for rejected entries.
    expect(engine.incidents.records).toEqual([]);
    expect(engine.incidents.nextIncidentId).toBe(0);
  });

  it("replays identically for the same seed and same interactive actions", () => {
    const build = () => {
      const city = routeCity();
      const engine = createEngine({
        city,
        controller: createAdaptiveController(),
        spawns: [
          { timeMs: 0, type: CAR, origin: 0, destination: 3 },
          { timeMs: 2_000, type: "truck", origin: 0, destination: 3 },
        ],
        incidents: { seed: 42, script: [] },
      });
      return engine;
    };
    const a = build();
    const b = build();
    for (const engine of [a, b]) {
      runEngine(engine, 1_000);
      queueIncident(engine, { kind: "crash", durationMs: 3_000 });
      runEngine(engine, 2_000);
      queueIncident(engine, { kind: "event-release" });
      runEngine(engine, 6_000);
    }
    expect(JSON.stringify(takeSnapshot(a))).toBe(JSON.stringify(takeSnapshot(b)));
    expect(JSON.stringify(a.incidents.records)).toBe(JSON.stringify(b.incidents.records));
  });

  it("hands a fresh, clean incident runtime to a rebuilt engine", () => {
    const city = routeCity();
    const first = createEngine({ city, controller: createFixedController(), spawns: [] });
    queueIncident(first, { kind: "crash", targetRoadId: 2, durationMs: 1_000 });
    runEngine(first, 500);
    const rebuilt = createEngine({ city, controller: createFixedController(), spawns: [] });
    expect(rebuilt.incidents.records).toEqual([]);
    expect(rebuilt.incidents.nextIncidentId).toBe(0);
    expect(rebuilt.incidentConfig.script).toEqual([]);
    expect(queueIncident(rebuilt, { kind: "crash", targetRoadId: 2, durationMs: 1_000 })).toBe(0);
  });
});

describe("controller switching (setEngineController)", () => {
  it("switches Fixed -> Adaptive in place without any state loss", () => {
    const city = routeCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }],
    });
    runEngine(engine, 1_500);
    const time = engine.traffic.timeMs;
    const vehicleState = JSON.stringify(engine.traffic.vehicles);
    const metrics = JSON.stringify(takeSnapshot(engine).metrics);
    setEngineController(engine, createAdaptiveController());
    expect(engine.controller.id).toBe("adaptive");
    expect(engine.traffic.timeMs).toBe(time);
    expect(JSON.stringify(engine.traffic.vehicles)).toBe(vehicleState);
    expect(JSON.stringify(takeSnapshot(engine).metrics)).toBe(metrics);
    runEngine(engine, 2_000); // policy applies from the next tick
    expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
  });

  it("switches back Adaptive -> Fixed", () => {
    const city = routeCity();
    const engine = createEngine({
      city,
      controller: createAdaptiveController(),
      spawns: [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }],
    });
    runEngine(engine, 1_000);
    setEngineController(engine, createFixedController());
    expect(engine.controller.id).toBe("fixed");
    runEngine(engine, 1_500);
    expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
  });
});
