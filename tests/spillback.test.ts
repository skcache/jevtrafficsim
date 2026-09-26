import { describe, expect, it } from "vitest";
import {
  SIMULATION_TIMESTEP_MS,
  SPILLBACK_ADMISSION_RATIO,
  SPILLBACK_RELEASE_MS,
} from "@/sim/config";
import {
  checkTrafficInvariants,
  createTrafficState,
  spawnVehicle,
  stepTraffic,
} from "@/sim/traffic";
import type { City, Intersection, Road } from "@/sim/types";
import { makeStreet } from "./traffic-support";

describe("spillback admission (decided on projected occupancy)", () => {
  it("stops admitting NEW vehicles once occupancy reaches the threshold", () => {
    const { city } = makeStreet([{ length: 1000, capacity: 20 }]);
    const state = createTrafficState();
    // Nine trucks fill exactly 90% of capacity (18.0 of 20 units).
    for (let i = 0; i < 9; i += 1) {
      spawnVehicle(city, state, { id: i, type: "truck", origin: 0, destination: 1, route: [0] });
    }
    expect(state.occupancy.get(0)).toBeCloseTo(18, 9);
    // Occupancy has reached the threshold: even a bicycle is refused — its
    // entry would project 18.3, past the 18.0 spillback limit.
    spawnVehicle(city, state, { id: 9, type: "bicycle", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[9].state).toBe("pending");
    spawnVehicle(city, state, { id: 10, type: "bicycle", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[10].state).toBe("pending");
    spawnVehicle(city, state, { id: 11, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[11].state).toBe("pending");
    expect(state.occupancy.get(0)).toBeCloseTo(18, 9);
    expect(SPILLBACK_ADMISSION_RATIO).toBe(0.9);
  });

  it("lets occupancy land exactly on the threshold but never past it", () => {
    // Coarse footprints: at 17.0 of 20 units a truck would project 19.0 and is
    // refused, while a car projects exactly 18.0 and is admitted. That is the
    // point of projecting: no admitted vehicle may overshoot the threshold.
    const { city } = makeStreet([{ length: 1000, capacity: 20 }]);
    const state = createTrafficState();
    for (let i = 0; i < 8; i += 1) {
      spawnVehicle(city, state, { id: i, type: "truck", origin: 0, destination: 1, route: [0] });
    }
    spawnVehicle(city, state, { id: 8, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.occupancy.get(0)).toBeCloseTo(17, 9);
    spawnVehicle(city, state, { id: 9, type: "truck", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[9].state).toBe("pending"); // 17.0 + 2.0 = 19.0 > 18.0
    spawnVehicle(city, state, { id: 10, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[10].state).toBe("moving"); // 17.0 + 1.0 = 18.0, exactly on the limit
    expect(state.occupancy.get(0)).toBeCloseTo(18, 9);
    // At exactly the threshold the next car is refused, not admitted.
    spawnVehicle(city, state, { id: 11, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[11].state).toBe("pending");
    expect(state.occupancy.get(0)).toBeCloseTo(18, 9);
  });

  it("admits only while the projected occupancy stays within the headroom", () => {
    const { city } = makeStreet([{ length: 1000, capacity: 4 }]);
    const state = createTrafficState();
    for (let i = 0; i < 3; i += 1) {
      spawnVehicle(city, state, { id: i, type: "car", origin: 0, destination: 1, route: [0] });
      expect(state.vehicles[i].state).toBe("moving");
    }
    expect(state.occupancy.get(0)).toBeCloseTo(3, 9);
    // 3.0 + 1.0 = 4.0 fits the absolute capacity but exceeds the 3.6 headroom.
    spawnVehicle(city, state, { id: 3, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[3].state).toBe("pending");
    expect(state.occupancy.get(0)).toBeCloseTo(3, 9);
  });

  it("keeps an empty capacity-1 road usable (empty-road exception)", () => {
    const { city } = makeStreet([{ length: 10, capacity: 1 }]);
    const state = createTrafficState();
    // A car footprint (1.0) exceeds the 0.9 headroom, but an EMPTY road with
    // finite capacity must never be unusable: the first car enters.
    spawnVehicle(city, state, { id: 0, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[0].state).toBe("moving");
    expect(state.occupancy.get(0)).toBe(1);
    // Once occupied, projected spillback applies normally: the next car waits.
    spawnVehicle(city, state, { id: 1, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[1].state).toBe("pending");
    // Drain, then reopen — the rule is a pure function of state, no hysteresis.
    // A lone car at 100% occupancy is SEVERE traffic (factor -> 0.12), so it
    // crawls the 10 m and arrives on tick 12 (derived with tools/model-timing.py),
    // not the 10 ticks the old constant-speed law implied.
    for (let tick = 0; tick < 12; tick += 1) {
      stepTraffic(city, state);
    }
    expect(state.vehicles[0].state).toBe("arrived");
    stepTraffic(city, state); // tick 13: road empty again
    expect(state.vehicles[1].state).toBe("moving");
    // Absolute capacity stays hard: an oversized footprint is refused even on
    // an empty road (truck 2.0 > capacity 1.0).
    const emptyState = createTrafficState();
    spawnVehicle(city, emptyState, { id: 0, type: "truck", origin: 0, destination: 1, route: [0] });
    expect(emptyState.vehicles[0].state).toBe("pending");
  });

  it("reopens admission once occupancy falls back below the headroom", () => {
    // Short road so the whole fleet cycles through within a bounded horizon:
    // trucks cover 0.7 * factor * 10 * 0.1 per tick, and while occupancy sits
    // at 90% the road is SEVERE (factor -> 0.12), so the fleet crawls and the
    // factor recovers only after the road drains. All twelve arrive at tick
    // 754 (75.4 s of simulation), derived with tools/model-timing.py.
    const { city } = makeStreet([{ length: 100, capacity: 20 }]);
    const state = createTrafficState();
    for (let i = 0; i < 9; i += 1) {
      spawnVehicle(city, state, { id: i, type: "truck", origin: 0, destination: 1, route: [0] });
    }
    // The road sits exactly on the threshold: all three newcomers wait.
    spawnVehicle(city, state, { id: 9, type: "bicycle", origin: 0, destination: 1, route: [0] });
    spawnVehicle(city, state, { id: 10, type: "bicycle", origin: 0, destination: 1, route: [0] });
    spawnVehicle(city, state, { id: 11, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[9].state).toBe("pending");
    expect(state.vehicles[10].state).toBe("pending");
    expect(state.vehicles[11].state).toBe("pending");
    for (let tick = 0; tick < 754; tick += 1) {
      stepTraffic(city, state);
    }
    for (const vehicle of state.vehicles) {
      expect(vehicle.state).toBe("arrived");
    }
    expect(state.occupancy.size).toBe(0);
  });
});

/**
 * Gridlock valve (SPILLBACK_RELEASE_MS).
 *
 * The spillback reservation is unusable BY CONSTRUCTION once a road sits on
 * the threshold, so a ring of saturated roads is an absorbing state: every
 * member refuses the next vehicle and no member's occupancy can fall. These
 * fixtures are the minimum shape of that ring — the two-road, two-vehicle case
 * is what Chicago's downtown one-way block loops (12-13 m links, capacity 3)
 * collapse into, and they held each other for over 1 000 simulated seconds
 * with no escape before the valve existed.
 */
describe("gridlock valve (blocked long enough, the reserved headroom opens)", () => {
  /** Two one-way roads forming a directed ring: 0 -> 1 and 1 -> 0. */
  function makeRing(options: { capacity: number; length: number }): City {
    const intersections: Intersection[] = [0, 1].map((id) => ({
      id,
      x: id * 10,
      y: 0,
      incoming: [],
      outgoing: [],
      control: "uncontrolled" as const,
      regionId: 0,
    }));
    const roads: Road[] = [
      {
        id: 0,
        from: 0,
        to: 1,
        length: options.length,
        lanes: 1,
        speedLimit: 10,
        capacity: options.capacity,
        kind: "local",
        closed: false,
      },
      {
        id: 1,
        from: 1,
        to: 0,
        length: options.length,
        lanes: 1,
        speedLimit: 10,
        capacity: options.capacity,
        kind: "local",
        closed: false,
      },
    ];
    for (const road of roads) {
      intersections[road.from].outgoing.push(road.id);
      intersections[road.to].incoming.push(road.id);
    }
    return {
      size: "small",
      seed: 0,
      gridWidth: 2,
      gridHeight: 1,
      intersections,
      roads,
      corridors: [],
    };
  }

  const RELEASE_TICKS = SPILLBACK_RELEASE_MS / SIMULATION_TIMESTEP_MS;

  it("unlocks two vehicles that block each other at the spillback threshold", () => {
    const city = makeRing({ capacity: 2, length: 300 });
    const state = createTrafficState();
    spawnVehicle(city, state, { id: 0, type: "car", origin: 0, destination: 0, route: [0, 1] });
    spawnVehicle(city, state, { id: 1, type: "car", origin: 1, destination: 1, route: [1, 0] });
    // Each road holds one car (1.0 of capacity 2) and the other road is on the
    // threshold: 1.0 + 1.0 > 0.9 * 2, so neither may cross. Neither can leave:
    // the road it wants is the one the other vehicle is standing on.
    let ticks = 0;
    while (state.vehicles[0].state !== "queued" || state.vehicles[1].state !== "queued") {
      stepTraffic(city, state);
      ticks += 1;
      expect(ticks).toBeLessThan(600);
    }
    expect(state.occupancy.get(0)).toBeCloseTo(1, 9);
    expect(state.occupancy.get(1)).toBeCloseTo(1, 9);

    // One tick short of the release window: still deadlocked, exactly as a
    // draining approach would be. The valve is not a shortcut.
    for (let tick = 0; tick < RELEASE_TICKS - 1; tick += 1) {
      stepTraffic(city, state);
      expect(checkTrafficInvariants(city, state)).toEqual([]);
    }
    expect(state.vehicles[0].routeIndex).toBe(0);
    expect(state.vehicles[1].routeIndex).toBe(0);

    // The window elapses: the reserved headroom opens (absolute capacity, 2.0
    // of 2.0, still admits) and both vehicles cross in queue order.
    stepTraffic(city, state);
    expect(state.vehicles[0].routeIndex).toBe(1);
    expect(state.vehicles[1].routeIndex).toBe(1);
    expect(state.occupancy.get(0)).toBeCloseTo(1, 9);

    // ...and the ring empties: both reach their destination and arrive. The
    // horizon is generous because both vehicles have to crawl out of a road
    // whose flow state was driven SEVERE by the queue that just released
    // (recovery is deliberately slower than the build: see sim/road-traffic.ts).
    for (let tick = 0; tick < 2_500; tick += 1) {
      stepTraffic(city, state);
      expect(checkTrafficInvariants(city, state)).toEqual([]);
    }
    expect(state.vehicles[0].state).toBe("arrived");
    expect(state.vehicles[1].state).toBe("arrived");
    expect(state.occupancy.size).toBe(0);
  });

  it("never crosses absolute capacity, even for a vehicle that has waited the window", () => {
    // Road 1 is ABSOLUTELY full: a truck (footprint 2.0 of capacity 2) parked at
    // its end because road 2 is closed. A car that has waited far beyond the
    // release window still cannot enter — the valve only opens the RESERVED
    // headroom, never the hard ceiling.
    const { city } = makeStreet([
      { length: 500, capacity: 4 },
      { length: 500, capacity: 2 },
      { length: 500, capacity: 4, closed: true },
    ]);
    const state = createTrafficState();
    spawnVehicle(city, state, { id: 0, type: "truck", origin: 1, destination: 3, route: [1, 2] });
    spawnVehicle(city, state, { id: 1, type: "car", origin: 0, destination: 3, route: [0, 1, 2] });
    expect(state.occupancy.get(1)).toBeCloseTo(2, 9);
    let queuedAtTick = -1;
    for (let tick = 0; tick < 2_000; tick += 1) {
      stepTraffic(city, state);
      if (queuedAtTick < 0 && state.vehicles[1].state === "queued") {
        queuedAtTick = tick;
      }
      expect(checkTrafficInvariants(city, state)).toEqual([]);
    }
    expect(queuedAtTick).toBeGreaterThanOrEqual(0);
    // 2 000 ticks = 200 s of continuous blocking, well past the 90 s window.
    expect(state.vehicles[1].state).toBe("queued");
    expect(state.vehicles[1].routeIndex).toBe(0);
    expect(state.occupancy.get(1)).toBeCloseTo(2, 9);
  });

  it("lets a blocked spawn enter its first road once the window elapses", () => {
    // The first road sits on the threshold with three cars (3.0 of capacity 4,
    // headroom 3.6), all held because road 1 is closed. A fourth vehicle cannot
    // spawn onto it normally; after the window it enters the reserved headroom
    // (4.0 = absolute capacity, still legal).
    const { city } = makeStreet([
      { length: 500, capacity: 4 },
      { length: 500, capacity: 4, closed: true },
    ]);
    const state = createTrafficState();
    for (let i = 0; i < 3; i += 1) {
      spawnVehicle(city, state, { id: i, type: "car", origin: 0, destination: 2, route: [0, 1] });
    }
    spawnVehicle(city, state, { id: 3, type: "car", origin: 0, destination: 2, route: [0, 1] });
    expect(state.vehicles[3].state).toBe("pending");
    // Pending retries run in tick step 4, BEFORE that tick's wait accrual (step
    // 7), so a pending vehicle reads one tick less wait than a queued one at
    // the same simulated time: it needs the release tick PLUS one.
    for (let tick = 0; tick < RELEASE_TICKS; tick += 1) {
      stepTraffic(city, state);
    }
    expect(state.vehicles[3].state).toBe("pending");
    stepTraffic(city, state);
    expect(state.vehicles[3].state).toBe("moving");
    expect(state.occupancy.get(0)).toBeCloseTo(4, 9);
    expect(checkTrafficInvariants(city, state)).toEqual([]);
  });
});
