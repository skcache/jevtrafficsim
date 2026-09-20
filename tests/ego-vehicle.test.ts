/**
 * Issue #24 — the ego vehicle as a simulation citizen.
 *
 * These are the invariants the whole ego pivot rests on: one curated trip
 * becomes one ordinary car, its `role` buys it nothing mechanical, and the
 * frame it appears in no longer scales with the city's vehicle count.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { createEngine, runEngine, type ScheduledSpawn } from "@/sim/engine";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { chicagoModel } from "./chicago-support";
import { makeStreet } from "./traffic-support";

function egoOnChain(backgroundFirst: ScheduledSpawn[]): ScheduledSpawn[] {
  return [
    ...backgroundFirst,
    { timeMs: 0, type: "car", origin: 0, destination: 2, role: "ego" },
  ];
}

describe("ego vehicle seam", () => {
  it("turns the curated trip into exactly one ego spawn on the Metro graph", () => {
    const { trip, spawn } = materializeChallengeTrip(chicagoModel(4), "united-center-to-navy-pier", 7);
    expect(spawn.role).toBe("ego");
    expect(spawn.timeMs).toBe(0);
    expect(spawn.type).toBe("car");
    expect(spawn.origin).toBe(trip.originIntersectionId);
    expect(spawn.destination).toBe(trip.destinationIntersectionId);
    expect(trip.originIntersectionId).not.toBe(trip.destinationIntersectionId);
  });

  it("accepts at most one ego spawn", () => {
    const { city } = makeStreet([{ length: 10 }]);
    const ego: ScheduledSpawn = { timeMs: 0, type: "car", origin: 0, destination: 1, role: "ego" };
    expect(() =>
      createEngine({ city, controller: createFixedController(), spawns: [ego, { ...ego }] }),
    ).toThrow(RangeError);
  });

  it("records the ego vehicle id when its spawn creates the vehicle", () => {
    const { city } = makeStreet([
      { length: 10, speedLimit: 10 },
      { length: 10, speedLimit: 10 },
    ]);
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: egoOnChain([{ timeMs: 0, type: "car", origin: 0, destination: 2 }]),
    });
    expect(engine.egoVehicleId).toBeNull();
    runEngine(engine, 10);
    const ego = engine.traffic.vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId);
    expect(ego).toBeDefined();
    expect(ego?.type).toBe("car");
    expect(ego?.origin).toBe(0);
    expect(ego?.destination).toBe(2);
  });

  it("gives the ego role no mechanical privilege: equal worlds stay equal", () => {
    // Identical world, identical spawn — only the role tag differs. Every
    // sampled vehicle state must match exactly; if a role could buy signal
    // priority, capacity, routing or wait accounting, this diverges.
    const specs = [{ length: 8, speedLimit: 8, capacity: 2 }];
    const ordinarySpawns: ScheduledSpawn[] = [
      { timeMs: 0, type: "truck", origin: 0, destination: 1 },
      { timeMs: 0, type: "car", origin: 0, destination: 1 },
      { timeMs: 300, type: "bicycle", origin: 0, destination: 1 },
      { timeMs: 500, type: "car", origin: 0, destination: 1 },
    ];

    const a = createEngine({
      city: makeStreet(specs).city,
      controller: createFixedController(),
      spawns: ordinarySpawns,
    });
    // Same world, same spawns, same order — only the LAST car wears the role.
    const c = createEngine({
      city: makeStreet(specs).city,
      controller: createFixedController(),
      spawns: [
        ...ordinarySpawns.slice(0, -1),
        { ...ordinarySpawns[ordinarySpawns.length - 1], role: "ego" },
      ],
    });

    // runEngine takes an ABSOLUTE horizon: step both worlds together.
    for (let step = 1; step <= 40; step += 1) {
      runEngine(a, step * 100);
      runEngine(c, step * 100);
      expect(JSON.stringify(c.traffic.vehicles)).toBe(JSON.stringify(a.traffic.vehicles));
      expect(c.metrics).toEqual(a.metrics);
    }
    expect(c.egoVehicleId).toBe(3); // ...and the tagged vehicle is the last scheduled car.
    expect(a.egoVehicleId).toBeNull();
  });

  it("replays the same seed into the same ego identity, route and outcome", () => {
    const build = () => {
      const { city } = makeStreet([{ length: 10, speedLimit: 10 }, { length: 10, speedLimit: 10 }]);
      return createEngine({
        city,
        controller: createFixedController(),
        spawns: egoOnChain([{ timeMs: 0, type: "car", origin: 0, destination: 2 }]),
      });
    };
    const a = build();
    const b = build();
    runEngine(a, 900);
    runEngine(b, 900);
    const first = buildPresentationSnapshot(a, 0, "united-center-to-navy-pier");
    const second = buildPresentationSnapshot(b, 0, "united-center-to-navy-pier");
    expect(a.egoVehicleId).toBe(b.egoVehicleId);
    expect(first.ego).toEqual(second.ego);
    expect(first.trip).toEqual(second.trip);
    expect(first.roadTraffic).toEqual(second.roadTraffic);
    expect(first.routeControls).toEqual(second.routeControls);
  });

  it("lets background traffic materially change the ego experience", () => {
    const scene = () =>
      makeStreet([
        { length: 10, speedLimit: 10, capacity: 2 },
        { length: 10, speedLimit: 10, capacity: 2 },
      ]).city;
    const quiet = createEngine({
      city: scene(),
      controller: createFixedController(),
      spawns: egoOnChain([]),
    });
    const busy = createEngine({
      city: scene(),
      controller: createFixedController(),
      spawns: egoOnChain([
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
      ]),
    });
    runEngine(quiet, 1_000);
    runEngine(busy, 1_000);
    const quietEgo = buildPresentationSnapshot(quiet, 0, "t").ego;
    const busyEgo = buildPresentationSnapshot(busy, 0, "t").ego;
    expect(quietEgo).not.toBeNull();
    expect(busyEgo).not.toBeNull();
    // The hidden fleet is what congestion is made of: same trip, same
    // controller, same city — only background demand changed.
    expect((busyEgo?.blockedWaitMs ?? 0) > (quietEgo?.blockedWaitMs ?? 0)).toBe(true);
    expect(JSON.stringify(buildPresentationSnapshot(busy, 0, "t"))).not.toBe(
      JSON.stringify(buildPresentationSnapshot(quiet, 0, "t")),
    );
  });

  it("does not grow the frame linearly with the number of vehicles", () => {
    const specs = Array.from({ length: 12 }, () => ({ length: 10, speedLimit: 10, capacity: 3 }));
    const crowd = (count: number): ScheduledSpawn[] => [
      ...Array.from({ length: count }, () => ({
        timeMs: 0,
        type: "car" as const,
        origin: 0,
        destination: 12,
      })),
      { timeMs: 0, type: "car", origin: 0, destination: 12, role: "ego" as const },
    ];
    const small = createEngine({
      city: makeStreet(specs).city,
      controller: createFixedController(),
      spawns: crowd(2),
    });
    const large = createEngine({
      city: makeStreet(specs).city,
      controller: createFixedController(),
      spawns: crowd(30),
    });
    runEngine(small, 1_500);
    runEngine(large, 1_500);
    const smallActive = small.traffic.vehicles.filter((v) => v.state !== "arrived").length;
    const largeActive = large.traffic.vehicles.filter((v) => v.state !== "arrived").length;
    expect(smallActive).toBeLessThan(6);
    expect(largeActive).toBeGreaterThan(20);

    const smallFrame = buildPresentationSnapshot(small, 0, "t");
    const largeFrame = buildPresentationSnapshot(large, 0, "t");
    expect("vehicles" in smallFrame).toBe(false);
    expect("vehicles" in largeFrame).toBe(false);
    expect(largeFrame.ego === null || largeFrame.ego !== null).toBe(true);
    // Background state is represented as ROADS, so the payload is bounded by
    // the network (12 roads here), not by the fleet. A generous factor keeps
    // this from becoming a byte-perfect benchmark.
    expect(largeFrame.roadTraffic.length).toBeLessThanOrEqual(12);
    const smallBytes = JSON.stringify(smallFrame).length;
    const largeBytes = JSON.stringify(largeFrame).length;
    expect(largeBytes).toBeLessThan(smallBytes * 4);
    expect(largeBytes).toBeLessThan(8_000);
  });
});

/**
 * Wiring cannot be proven by types alone — the signal-sprite bug in Phase 3.2
 * was invisible to unit tests — so the worker's own call sites are asserted.
 */
describe("ego wiring in the worker", () => {
  const source = () => readFileSync(new URL("../worker/simulation.worker.ts", import.meta.url), "utf8");

  it("builds the ego spawn through the shared challenge-trip helper on Metro", () => {
    const code = source();
    expect(code).toContain("materializeChallengeTrip(model, config.tripId, config.seed)");
    expect(code).toContain("const scaleIndex = METRO_SCALE_INDEX;");
    expect(code).toMatch(/spawns: ScheduledSpawn\[\] = \[challenge\.spawn, \.\.\.background\]/);
    // The frame carries the trip id, so the snapshot can report progress.
    expect(code).toMatch(/buildPresentationSnapshot\(\s*state\.engine,\s*state\.snapshotSequence,\s*state\.config\?\.tripId \?\? null,?\s*\)/);
  });

  it("resets deterministically and switches controller without touching the ego", () => {
    const code = source();
    // RESET keeps the whole config and only moves the seed in new-seed mode:
    // the trip (and therefore the ego) is recreated identically.
    expect(code).toMatch(/nextSeed\(state\.config\.seed\) : state\.config\.seed/);
    expect(code).toMatch(/buildRun\(\{ \.\.\.state\.config, seed \}\)/);
    // Controller switching is in-place: no rebuild, no respawn, no reroute.
    expect(code).toMatch(/setEngineController\(state\.engine, makeController\(command\.controller\)\)/);
    expect(code).not.toMatch(/case "SET_CONTROLLER"[\s\S]{0,400}?buildRun\(/);
  });
});
