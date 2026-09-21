import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { generateCity } from "@/sim/city-generator";
import { generateDemand } from "@/sim/demand";
import { createEngine, runEngine, stepEngine, takeSnapshot, type ScheduledSpawn } from "@/sim/engine";
import type { IncidentScriptEntry } from "@/sim/incidents";
import { checkTrafficInvariants } from "@/sim/traffic";
import type { City, Intersection, Road } from "@/sim/types";

/**
 * 4-node lattice with two routes from node 0 to node 3:
 *   path A = roads [0, 4] with cost 5 + 5 = 10  (free-flow winner)
 *   path B = roads [2, 6] with cost 8 + 8 = 16  (alternate)
 * Reverse directions: 1 (1->0), 3 (2->0), 5 (3->1), 7 (3->2).
 */
function routeCity(): City {
  const intersections: Intersection[] = [
    { id: 0, x: 0, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 1, x: 10, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 2, x: 0, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 3, x: 10, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
  ];
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
    road(0, 0, 1, 50),
    road(1, 1, 0, 50),
    road(2, 0, 2, 80),
    road(3, 2, 0, 80),
    road(4, 1, 3, 50),
    road(5, 3, 1, 50),
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

describe("incident tick ordering", () => {
  it("a road closing at T is already avoided by a spawn at T", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [
      { timeMs: 1_000, type: CAR, origin: 0, destination: 3 },
    ];
    const control = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(control, 1_100);
    expect(control.traffic.vehicles[0].route).toEqual([0, 4]); // free-flow winner

    const script: IncidentScriptEntry[] = [
      { atMs: 1_000, kind: "close-road", targetRoadId: 0, durationMs: 60_000 },
    ];
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 1, script },
    });
    runEngine(engine, 1_100);
    expect(engine.traffic.vehicles[0].route).toEqual([2, 6]); // closure already applied
    expect(engine.city.roads[0].closed).toBe(true);
    expect(engine.city.roads[1].closed).toBe(true); // both directions
  });

  it("an expiring closure at T is already reopened for routing at T", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [
      { timeMs: 2_000, type: CAR, origin: 0, destination: 3 },
    ];
    const script: IncidentScriptEntry[] = [
      { atMs: 1_000, kind: "close-road", targetRoadId: 0, durationMs: 1_000 },
    ];
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 1, script },
    });
    runEngine(engine, 1_900); // closure still active
    expect(engine.city.roads[0].closed).toBe(true);
    runEngine(engine, 2_100); // expiry at T=2000 happens before the T=2000 spawn
    expect(engine.city.roads[0].closed).toBe(false);
    expect(engine.city.roads[1].closed).toBe(false);
    expect(engine.traffic.vehicles[0].route).toEqual([0, 4]);
  });

  it("a traffic burst beginning at T injects vehicles participating in the T tick", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [0, 1_000, 2_000, 3_000, 4_000].map((timeMs) => ({
      timeMs,
      type: CAR,
      origin: 0,
      destination: 3,
    }));
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 5, script: [{ atMs: 2_000, kind: "traffic-burst", durationMs: 3_000 }] },
    });
    runEngine(engine, 2_050); // one tick past activation
    // base event at 2000 + its four copies, all created within the 2000 tick.
    const atWindow = engine.traffic.vehicles.filter(
      (vehicle) => vehicle.spawnTimeMs === 2_000,
    );
    expect(atWindow.length).toBe(5);
    const snapshot = takeSnapshot(engine);
    expect(snapshot.incidents[0].injectedSpawnCount).toBe(12); // 3 base events x 4
  });
});

describe("+5x traffic burst", () => {
  it("keeps base events, injects four copies each, and never recurses", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [0, 1_000, 2_000, 3_000, 4_000, 5_000, 6_000].map(
      (timeMs) => ({ timeMs, type: CAR, origin: 0, destination: 3 }),
    );
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 5, script: [{ atMs: 2_000, kind: "traffic-burst", durationMs: 3_000 }] },
    });
    runEngine(engine, 7_100);
    // 7 base + 12 injected, no more.
    expect(engine.traffic.vehicles.length).toBe(19);
    // Materially more offered demand inside the window [2000, 5000).
    const inWindow = engine.traffic.vehicles.filter(
      (vehicle) => vehicle.spawnTimeMs >= 2_000 && vehicle.spawnTimeMs < 5_000,
    );
    expect(inWindow.length).toBe(3 * 5); // 3 base events x 5
    // Deterministic ordering: base event precedes its copies at equal time.
    const ids = inWindow.filter((v) => v.spawnTimeMs === 2_000).map((v) => v.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    const replay = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 5, script: [{ atMs: 2_000, kind: "traffic-burst", durationMs: 3_000 }] },
    });
    runEngine(replay, 7_100);
    expect(JSON.stringify(takeSnapshot(replay))).toBe(JSON.stringify(takeSnapshot(engine)));
  });

  it("two overlapping bursts amplify only base events (linear, never exponential)", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [1_000, 3_000].map((timeMs) => ({
      timeMs,
      type: CAR,
      origin: 0,
      destination: 3,
    }));
    const script: IncidentScriptEntry[] = [
      { atMs: 0, kind: "traffic-burst", durationMs: 5_000 }, // covers both
      { atMs: 2_000, kind: "traffic-burst", durationMs: 5_000 }, // covers 3000 only
    ];
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 3, script },
    });
    runEngine(engine, 5_100);
    // 2 base + (4 + 4) for the 3000 event + 4 for the 1000 event = 14.
    expect(engine.traffic.vehicles.length).toBe(14);
  });
});

describe("crash semantics", () => {
  it("reduces capacity, never below resident occupancy, and recovers on expiry", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [
      { timeMs: 0, type: CAR, origin: 0, destination: 3 },
      { timeMs: 0, type: CAR, origin: 0, destination: 3 },
      { timeMs: 0, type: CAR, origin: 0, destination: 3 },
      { timeMs: 200, type: CAR, origin: 0, destination: 3 }, // during the crash
    ];
    // A road at 100% of its (reduced) capacity is SEVERE under the
    // authoritative traffic model: its factor falls toward 0.12 and the three
    // residents crawl across the 50 m road (~101 ticks, derived with
    // tools/model-timing.py), so the crash must outlast their drain.
    const script: IncidentScriptEntry[] = [
      { atMs: 100, kind: "crash", targetRoadId: 0, durationMs: 20_000 }, // until 20_100
    ];
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 2, script },
    });
    runEngine(engine, 300);
    expect(engine.traffic.occupancy.get(0)).toBe(3); // 3.0 resident
    expect(engine.city.roads[0].capacity).toBe(3); // never below resident occupancy
    expect(engine.traffic.vehicles[3].state).toBe("pending"); // 3 + 1 > reduced capacity
    // Residents drain off road 0 at tick 101; the crash still applies and the
    // capacity tightens toward the desired 2.0 (tick 102), admitting the waiter.
    runEngine(engine, 10_500);
    expect(engine.city.roads[0].capacity).toBe(2);
    expect(engine.traffic.vehicles[3].state).toBe("moving");
    // Expiry at 20_100 restores the base capacity.
    runEngine(engine, 20_200);
    expect(engine.city.roads[0].capacity).toBe(4);
    expect(engine.city.roads[0].closed).toBe(false);
    expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
  });

  it("composes overlapping crash effects and recovers correctly", () => {
    const city = routeCity();
    const script: IncidentScriptEntry[] = [
      { atMs: 100, kind: "crash", targetRoadId: 0, durationMs: 2_000 }, // until 2100
      { atMs: 100, kind: "crash", targetRoadId: 0, durationMs: 6_000 }, // until 6100
    ];
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }],
      incidents: { seed: 4, script },
    });
    runEngine(engine, 3_000);
    // First crash expired; the second still applies (desired 2.0, occupancy 1).
    expect(engine.city.roads[0].capacity).toBe(2);
    const snapshot = takeSnapshot(engine);
    expect(snapshot.incidents.map((record) => record.status)).toEqual(["expired", "active"]);
    runEngine(engine, 6_200);
    expect(engine.city.roads[0].capacity).toBe(4);
  });
});

/**
 * Extended fixture: adds path C = roads [8, 9] (cost 10 + 10 = 20) via node 4,
 * and road 4/5 capacity 3 (one truck fills the spillback headroom).
 * Route costs 0 -> 3: A [0,4] = 5 + 5 = 10 · B [2,6] = 8 + 8 = 16 · C = 20.
 * Road 0's length is overridable so reroute tests can keep a vehicle en route
 * (long) or queue it at the line (short) when an incident lands.
 */
function extendedRouteCity(road0Length = 50): City {
  const base = routeCity();
  const intersections: Intersection[] = [
    ...base.intersections.map((node) => ({ ...node, incoming: [...node.incoming], outgoing: [...node.outgoing] })),
    { id: 4, x: 5, y: -5, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
  ];
  const roads: Road[] = [
    ...base.roads.map((road) => {
      if (road.id === 0) {
        return { ...road, length: road0Length };
      }
      return road.id === 4 || road.id === 5 ? { ...road, capacity: 3 } : { ...road };
    }),
    { id: 8, from: 0, to: 4, length: 100, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false },
    { id: 9, from: 4, to: 3, length: 100, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false },
  ];
  intersections[0].outgoing.push(8);
  intersections[4].incoming.push(8);
  intersections[4].outgoing.push(9);
  intersections[3].incoming.push(9);
  return { ...base, intersections, roads };
}

describe("closure-triggered rerouting", () => {
  it("reroutes a moving vehicle: prefix kept, invalid suffix replaced", () => {
    const city = extendedRouteCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }],
      incidents: {
        seed: 1,
        script: [{ atMs: 1_000, kind: "close-road", targetRoadId: 4, durationMs: 60_000 }],
      },
    });
    runEngine(engine, 1_100);
    const vehicle = engine.traffic.vehicles[0];
    expect(vehicle.route).toEqual([0, 1, 2, 6]); // prefix [0] + alternate tail
    expect(vehicle.routeIndex).toBe(0);
    expect(vehicle.state).toBe("moving"); // never teleported or stopped
    expect(vehicle.progress).toBeCloseTo(11, 10); // physical state preserved (11 ticks)
    const snapshot = takeSnapshot(engine);
    expect(snapshot.incidents[0].affectedVehicleCount).toBe(1);
    expect(snapshot.incidents[0].successfulReroutes).toBe(1);
    expect(snapshot.rerouteStats).toEqual({ attempted: 1, succeeded: 1, failed: 0 });
  });

  it("uses occupancy-aware A* for the replacement route", () => {
    const make = (withParkers: boolean) => {
      // Long road 0 (100 m): the vehicle is still 70 m into it when the
      // closure lands at 7 s, by which time road 2's three parkers have built
      // its authoritative factor.
      const city = extendedRouteCity(100);
      const spawns: ScheduledSpawn[] = [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }];
      if (withParkers) {
        // Three cars park on road 2 (origin 0 -> destination 2), loading it.
        for (let i = 0; i < 3; i += 1) {
          spawns.push({ timeMs: 0, type: CAR, origin: 0, destination: 2 });
        }
      }
      return createEngine({
        city,
        controller: createFixedController(),
        spawns,
        incidents: {
          seed: 1,
          script: [{ atMs: 7_000, kind: "close-road", targetRoadId: 4, durationMs: 60_000 }],
        },
      });
    };
    // Control: B (16) beats C (20) -> the moving vehicle reroutes through B.
    const clear = make(false);
    runEngine(clear, 7_100);
    expect(clear.traffic.vehicles[0].route).toEqual([0, 1, 2, 6]);
    // Loaded road 2: after 7 s of three-car load the authoritative factor has
    // fallen to ~0.60 (3 of 4 units, build tau 5 s), so B's tail costs
    // 5 + 8/0.60 + 8 ≈ 26.3 > C's 25 -> path C wins. Occupancy reaches the
    // router ONLY through the same factor that slows vehicles and paints roads.
    const loaded = make(true);
    runEngine(loaded, 7_100);
    expect(loaded.traffic.vehicles[0].route).toEqual([0, 1, 8, 9]);
  });

  it("reroutes a pending vehicle from its origin, replacing the whole route", () => {
    const city = extendedRouteCity();
    const spawns: ScheduledSpawn[] = [];
    // Three cars saturate road 0 itself (origin 0 -> destination 1), so the
    // fourth entrant parks as pending.
    for (let i = 0; i < 3; i += 1) {
      spawns.push({ timeMs: 0, type: CAR, origin: 0, destination: 1 });
    }
    spawns.push({ timeMs: 0, type: CAR, origin: 0, destination: 3 });
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: {
        seed: 1,
        script: [{ atMs: 1_000, kind: "close-road", targetRoadId: 4, durationMs: 60_000 }],
      },
    });
    runEngine(engine, 900);
    const vehicle = engine.traffic.vehicles[3];
    expect(vehicle.state).toBe("pending"); // road 0 is saturated by the parkers
    expect(vehicle.route).toEqual([0, 4]);
    // The closure lands during the T=1000 tick (same convention as spawns):
    // it reroutes the pending vehicle from its origin, and the new first road
    // is open, so the pending retry enters it in that same tick.
    runEngine(engine, 1_100);
    expect(vehicle.route).toEqual([2, 6]); // whole route replaced from origin
    expect(vehicle.routeIndex).toBe(0);
    expect(vehicle.state).toBe("moving");
    expect(vehicle.roadId).toBe(2);
  });

  it("reroutes a queued vehicle without moving it off its road", () => {
    // Road 0 is short (20 m) so the car has already braked and queued at the
    // line (tick 30 = 20 + 10, derived) while the truck still holds road 4.
    const city = extendedRouteCity(20);
    const spawns: ScheduledSpawn[] = [
      { timeMs: 0, type: "truck", origin: 1, destination: 3 }, // parks on road 4 (2.0 of 3)
      { timeMs: 0, type: CAR, origin: 0, destination: 3 }, // route A; queued at road 0's end
    ];
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: {
        seed: 1,
        script: [{ atMs: 5_500, kind: "close-road", targetRoadId: 4, durationMs: 60_000 }],
      },
    });
    runEngine(engine, 5_400);
    const vehicle = engine.traffic.vehicles[1];
    expect(vehicle.state).toBe("queued"); // blocked by the truck's road (2 + 1 > 2.7)
    expect(vehicle.queuedSinceMs).toBe(3_000);
    expect(vehicle.route).toEqual([0, 4]);
    runEngine(engine, 5_600); // closure lands while queued; reroute + release
    expect(vehicle.route).toEqual([0, 1, 2, 6]); // rerouted, same physical place
    expect(vehicle.state).toBe("moving"); // released onto the new tail
    expect(vehicle.roadId).toBe(1);
  });

  it("does not reroute when only the vehicle's CURRENT road closes", () => {
    const city = extendedRouteCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }],
      incidents: {
        seed: 1,
        script: [{ atMs: 1_000, kind: "close-road", targetRoadId: 0, durationMs: 60_000 }],
      },
    });
    runEngine(engine, 1_100);
    const vehicle = engine.traffic.vehicles[0];
    expect(vehicle.route).toEqual([0, 4]); // unchanged: it may finish road 0
    expect(takeSnapshot(engine).incidents[0].affectedVehicleCount).toBe(0);
    runEngine(engine, 6_000); // finishes road 0, crosses onto the open road 4
    expect(vehicle.roadId).toBe(4);
    expect(vehicle.state).toBe("moving");
  });

  it("handles no-route failures with cooldown, then recovers on expiry", () => {
    const city = extendedRouteCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }],
      incidents: {
        seed: 1,
        script: [
          { atMs: 1_000, kind: "close-road", targetRoadId: 4, durationMs: 4_000 }, // expires 5000
          { atMs: 1_200, kind: "close-road", targetRoadId: 2, durationMs: 200_000 },
          { atMs: 1_300, kind: "close-road", targetRoadId: 8, durationMs: 200_000, allowDisconnect: true },
        ],
      },
    });
    runEngine(engine, 1_400);
    const vehicle = engine.traffic.vehicles[0];
    // 1000: reroute to B; 1200: road 2 closes -> reroute to C; 1300: road 8
    // closes -> no route at all: the vehicle keeps its state (no crash).
    expect(vehicle.route).toEqual([0, 1, 8, 9]);
    expect(vehicle.state).toBe("moving");
    expect(engine.rerouteStats).toEqual({ attempted: 3, succeeded: 2, failed: 1 });
    // Cooldown: no retry while it lasts (1300 + 5000), even under load.
    runEngine(engine, 4_900);
    expect(engine.rerouteStats.attempted).toBe(3);
    // Road 4's closure expires at 5000 -> topology recovery retries immediately
    // and the shortest path comes back.
    runEngine(engine, 6_000);
    expect(engine.rerouteStats.attempted).toBe(4);
    expect(engine.rerouteStats.succeeded).toBe(3);
    // By 5000 the vehicle has crossed onto road 1 (1->0); the recovery reroute
    // keeps that traveled prefix and appends the reopened shortest path.
    expect(vehicle.route).toEqual([0, 1, 0, 4]);
  });

  it("produces identical route changes for the same closure sequence", () => {
    const build = () => {
      const city = extendedRouteCity();
      return createEngine({
        city,
        controller: createFixedController(),
        spawns: [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }],
        incidents: {
          seed: 1,
          script: [{ atMs: 1_000, kind: "close-road", targetRoadId: 4, durationMs: 60_000 }],
        },
      });
    };
    const a = build();
    const b = build();
    runEngine(a, 2_000);
    runEngine(b, 2_000);
    expect(a.traffic.vehicles[0].route).toEqual(b.traffic.vehicles[0].route);
    expect(JSON.stringify(takeSnapshot(a))).toBe(JSON.stringify(takeSnapshot(b)));
  });
});

describe("closure overlap and expiry", () => {
  it("keeps a segment closed while any closure still applies", () => {
    const city = routeCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [],
      incidents: {
        seed: 1,
        script: [
          { atMs: 0, kind: "close-road", targetRoadId: 0, durationMs: 1_000 }, // until 1000
          { atMs: 0, kind: "close-road", targetRoadId: 1, durationMs: 3_000 }, // until 3000
        ],
      },
    });
    runEngine(engine, 1_500);
    // The first closure expired; the second still applies to the same pair.
    expect(engine.city.roads[0].closed).toBe(true);
    expect(engine.city.roads[1].closed).toBe(true);
    runEngine(engine, 3_100);
    expect(engine.city.roads[0].closed).toBe(false);
    expect(engine.city.roads[1].closed).toBe(false);
  });

  it("reports not-applicable cleanly when no bridge exists or no safe road", () => {
    const medium = generateCity("medium", 42); // no bridges, but close-road has candidates
    const engine = createEngine({
      city: medium,
      controller: createFixedController(),
      spawns: [],
      incidents: {
        seed: 2,
        script: [
          { atMs: 0, kind: "bridge-closed" },
          { atMs: 0, kind: "close-road" },
        ],
      },
    });
    runEngine(engine, 200);
    const snapshot = takeSnapshot(engine);
    expect(snapshot.incidents[0].status).toBe("not-applicable"); // no bridges
    expect(snapshot.incidents[1].status).toBe("active"); // close-road found a safe road
    expect(snapshot.incidents[1].roadIds.length).toBeGreaterThan(0);
    // A city with no bridges at all reports not-applicable for bridge-closed.
    const street = routeCity();
    const unsafe = createEngine({
      city: street,
      controller: createFixedController(),
      spawns: [],
      incidents: {
        seed: 2,
        script: [{ atMs: 0, kind: "bridge-closed" }],
      },
    });
    runEngine(unsafe, 200);
    expect(takeSnapshot(unsafe).incidents[0].status).toBe("not-applicable"); // no bridges here either
  });
});

describe("isolation, replay and Adaptive compatibility", () => {
  function chaosScript(seed: number): { seed: number; script: IncidentScriptEntry[] } {
    return {
      seed,
      script: [
        { atMs: 10_000, kind: "traffic-burst", durationMs: 20_000 },
        { atMs: 40_000, kind: "crash", durationMs: 20_000 },
        { atMs: 70_000, kind: "close-road", durationMs: 30_000 },
        { atMs: 100_000, kind: "event-release" },
        { atMs: 130_000, kind: "bridge-closed" },
      ],
    };
  }

  it("never mutates the caller's city, even under full chaos", () => {
    const city = generateCity("medium", 42);
    const before = JSON.stringify(city);
    const spawns = generateDemand({ city, level: "everyday", seed: 42, durationMs: 150_000 });
    const engine = createEngine({
      city,
      controller: createAdaptiveController(),
      spawns,
      incidents: chaosScript(42),
    });
    runEngine(engine, 150_000);
    expect(JSON.stringify(city)).toBe(before);
    expect(engine.city).not.toBe(city);
    expect(engine.city.roads.some((road) => road.closed)).toBe(false); // all recovered at end
    const snapshot = takeSnapshot(engine);
    expect(snapshot.roadConditions).toEqual([]);
  }, 120_000);

  it("replays byte-identically with incidents, for Fixed and Adaptive", () => {
    const city = generateCity("medium", 42);
    const spawns = generateDemand({ city, level: "rush-hour", seed: 42, durationMs: 90_000 });
    for (const controllerId of ["fixed", "adaptive"]) {
      const makeController = () =>
        controllerId === "adaptive" ? createAdaptiveController() : createFixedController();
      const run = () => {
        const engine = createEngine({
          city,
          controller: makeController(),
          spawns,
          incidents: chaosScript(7),
        });
        runEngine(engine, 90_000);
        return engine;
      };
      const a = run();
      const b = run();
      const snapshotA = JSON.stringify(takeSnapshot(a));
      const snapshotB = JSON.stringify(takeSnapshot(b));
      expect(snapshotA).toBe(snapshotB);
      expect(a.traffic.vehicles.map((v) => v.route)).toEqual(b.traffic.vehicles.map((v) => v.route));
      expect(JSON.stringify(a.incidents.records)).toBe(JSON.stringify(b.incidents.records));
    }
  }, 300_000);

  it("keeps Adaptive safe and legal under incidents", () => {
    const city = generateCity("medium", 42);
    const spawns = generateDemand({ city, level: "rush-hour", seed: 42, durationMs: 120_000 });
    const engine = createEngine({
      city,
      controller: createAdaptiveController(),
      spawns,
      incidents: chaosScript(11),
    });
    const closedOccupancy = new Map<number, number>();
    while (engine.traffic.timeMs < 120_000) {
      stepEngine(engine);
      if (engine.ticks % 25 === 0) {
        expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
        // While a road is closed, its occupancy may only drain — never refill.
        for (const road of engine.city.roads) {
          if (road.closed) {
            const previous = closedOccupancy.get(road.id);
            const current = engine.traffic.occupancy.get(road.id) ?? 0;
            if (previous !== undefined) {
              expect(current).toBeLessThanOrEqual(previous + 1e-9);
            }
            closedOccupancy.set(road.id, current);
          } else {
            closedOccupancy.delete(road.id);
          }
        }
      }
    }
    const metrics = takeSnapshot(engine).metrics;
    expect(metrics.completedTrips).toBeGreaterThan(0);
    for (const [key, value] of Object.entries(metrics)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), key).toBe(true);
      }
    }
  }, 300_000);

  it("leaves engines without incident configuration exactly as before", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [{ timeMs: 0, type: CAR, origin: 0, destination: 3 }];
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 500);
    const snapshot = takeSnapshot(engine);
    expect(snapshot.incidents).toEqual([]);
    expect(snapshot.roadConditions).toEqual([]);
    expect(snapshot.rerouteStats).toEqual({ attempted: 0, succeeded: 0, failed: 0 });
    expect(engine.city.roads[0].closed).toBe(false);
  });
});

describe("crash invariants under sustained load", () => {
  it("never invalidates resident occupancy: invariants hold against base and runtime", () => {
    const city = routeCity();
    const spawns: ScheduledSpawn[] = [];
    for (let t = 0; t < 3_000; t += 100) {
      spawns.push({ timeMs: t, type: CAR, origin: 0, destination: 3 });
    }
    const script: IncidentScriptEntry[] = [
      { atMs: 500, kind: "crash", targetRoadId: 0, durationMs: 3_000 },
    ];
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns,
      incidents: { seed: 6, script },
    });
    let previousClosedCapacity = Infinity;
    while (engine.traffic.timeMs < 4_000) {
      stepEngine(engine);
      expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
      if (engine.city.roads[0].capacity < 4) {
        // Capacity may only tighten toward the desired value as traffic drains.
        expect(engine.city.roads[0].capacity).toBeLessThanOrEqual(previousClosedCapacity);
        previousClosedCapacity = engine.city.roads[0].capacity;
      }
    }
    expect(engine.city.roads[0].capacity).toBe(4);
  });
});
