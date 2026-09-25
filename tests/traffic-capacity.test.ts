import { describe, expect, it } from "vitest";
import { SIMULATION_TIMESTEP_MS as DT } from "@/sim/config";
import {
  checkTrafficInvariants,
  createTrafficState,
  roadOccupancy,
  spawnVehicle,
  stepTraffic,
} from "@/sim/traffic";
import type { TrafficState } from "@/sim/traffic";
import type { City } from "@/sim/types";
import { makeStreet, withClosedRoads } from "./traffic-support";

function spawn(
  city: City,
  state: TrafficState,
  id: number,
  type: "car" | "truck" | "bicycle",
  route: number[],
  origin: number,
  destination: number,
): void {
  spawnVehicle(city, state, { id, type, origin, destination, route });
}

function stepChecked(city: City, state: TrafficState, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    stepTraffic(city, state);
    expect(checkTrafficInvariants(city, state)).toEqual([]);
  }
}

describe("capacity semantics", () => {
  it("never exceeds the spillback headroom (cars)", () => {
    const { city } = makeStreet([{ length: 10, capacity: 4 }]);
    const state = createTrafficState();
    for (let i = 0; i < 3; i += 1) {
      spawn(city, state, i, "car", [0], 0, 1);
    }
    const waiting = spawnVehicle(city, state, {
      id: 3,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
    });
    expect(roadOccupancy(state, 0)).toBe(3); // 4.0 would exceed 0.9 * 4
    expect(waiting.state).toBe("pending");
  });

  it("charges trucks double and bicycles fractional capacity", () => {
    const { city } = makeStreet([{ length: 10, capacity: 4 }]);
    const state = createTrafficState();
    spawn(city, state, 0, "car", [0], 0, 1);
    spawn(city, state, 1, "truck", [0], 0, 1);
    spawn(city, state, 2, "bicycle", [0], 0, 1);
    expect(roadOccupancy(state, 0)).toBeCloseTo(3.3, 10);
    const extra = spawnVehicle(city, state, {
      id: 3,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
    });
    expect(extra.state).toBe("pending");

    const { city: bikeCity } = makeStreet([{ length: 10, capacity: 1 }]);
    const bikeState = createTrafficState();
    for (let i = 0; i < 3; i += 1) {
      spawn(bikeCity, bikeState, i, "bicycle", [0], 0, 1);
    }
    expect(roadOccupancy(bikeState, 0)).toBeCloseTo(0.9, 10);
    const fourth = spawnVehicle(bikeCity, bikeState, {
      id: 3,
      type: "bicycle",
      origin: 0,
      destination: 1,
      route: [0],
    });
    expect(fourth.state).toBe("pending");
  });

  it("frees capacity exactly on transfer and arrival", () => {
    const { city } = makeStreet([
      { length: 2, speedLimit: 10 },
      { length: 10, speedLimit: 10 },
    ]);
    const state = createTrafficState();
    spawn(city, state, 0, "car", [0, 1], 0, 2);
    stepChecked(city, state, 2);
    expect(state.vehicles[0].roadId).toBe(1);
    expect(state.vehicles[0].routeIndex).toBe(1);
    expect(roadOccupancy(state, 0)).toBe(0);
    expect(roadOccupancy(state, 1)).toBe(1);
    stepChecked(city, state, 10);
    expect(state.vehicles[0].state).toBe("arrived");
    expect(state.occupancy.size).toBe(0);
    expect(state.vehicles[0].tripTimeMs).toBe(12 * DT);
    expect(state.vehicles[0].waitTimeMs).toBe(0);
  });
});

describe("queueing", () => {
  it("waits while the downstream road is full and holds upstream capacity", () => {
    // Approaches scale up past the braking distance (v^2/2a = 13.89 m at
    // 10 m/s): the 30 m approach lets the waiter cruise, brake and stop AT the
    // line (tick 40 = 30 + 10, see tools/model-timing.py) while the 80 m
    // downstream road keeps its lone occupant aboard long enough to hold the
    // waiter there. Timings re-derived with tools/model-timing.py for the
    // 9 s congestion build interval: the blocker clears on tick 83.
    const { city } = makeStreet([
      { length: 30, speedLimit: 10, capacity: 4 },
      // Capacity 2 with one car aboard: the spillback headroom (1.8) admits
      // no second car, so this road blocks downstream exactly as before.
      { length: 80, speedLimit: 10, capacity: 2 },
    ]);
    const state = createTrafficState();
    spawn(city, state, 0, "car", [1], 1, 2); // occupies road 1
    spawn(city, state, 1, "car", [0, 1], 0, 2); // queued at road 0 end
    stepChecked(city, state, 40);
    const waiting = state.vehicles[1];
    expect(waiting.state).toBe("queued");
    expect(waiting.progress).toBeCloseTo(30, 10);
    expect(waiting.queuedSinceMs).toBe(40 * DT);
    expect(roadOccupancy(state, 0)).toBe(1);

    stepChecked(city, state, 43); // road-1 car arrives on tick 83
    expect(waiting.state).toBe("queued");
    expect(waiting.waitTimeMs).toBe(44 * DT);
    expect(waiting.tripTimeMs).toBe(83 * DT);

    stepChecked(city, state, 1); // capacity visible from tick 84
    expect(waiting.state).toBe("moving");
    expect(waiting.roadId).toBe(1);
    expect(roadOccupancy(state, 0)).toBe(0);
    expect(roadOccupancy(state, 1)).toBe(1);
    expect(waiting.waitTimeMs).toBe(44 * DT); // release tick does not wait

    stepChecked(city, state, 99); // arrives at tick 183 after 99 more
    expect(waiting.state).toBe("arrived");
    expect(waiting.tripTimeMs).toBe(183 * DT);
    expect(waiting.waitTimeMs).toBe(44 * DT);
  });

  it("releases waiters in queue order without jumping", () => {
    // Timings re-derived with tools/model-timing.py (scenario "derived") for the
    // 9 s congestion build interval: the blocker clears on tick 41, the first
    // waiter leaves on 42, the second on 99, the newcomer on 156.
    const { city } = makeStreet([
      { length: 30, speedLimit: 10, capacity: 8 },
      // Capacity 2 with one car aboard: no second car may be admitted.
      { length: 40, speedLimit: 10, capacity: 2 },
    ]);
    const state = createTrafficState();
    spawn(city, state, 0, "car", [1], 1, 2); // blocks road 1 until tick 41
    spawn(city, state, 1, "car", [0, 1], 0, 2); // first waiter
    spawn(city, state, 2, "car", [0, 1], 0, 2); // second waiter
    stepChecked(city, state, 41);
    const [blocker, first, second] = state.vehicles;
    expect(blocker.state).toBe("arrived");
    expect(first.state).toBe("queued");
    expect(second.state).toBe("queued");

    stepChecked(city, state, 1); // tick 42: release
    expect(first.state).toBe("moving");
    expect(first.roadId).toBe(1);
    expect(second.state).toBe("queued");
    expect(first.waitTimeMs).toBe(2 * DT);
    expect(second.waitTimeMs).toBe(3 * DT);

    stepChecked(city, state, 1); // tick 43: the second waiter still holds
    expect(first.state).toBe("moving");
    expect(second.state).toBe("queued");
    expect(first.waitTimeMs).toBe(2 * DT);
    expect(second.waitTimeMs).toBe(4 * DT);

    // A vehicle spawning later must not overtake the waiters.
    spawn(city, state, 3, "car", [0, 1], 0, 2);
    stepChecked(city, state, 55); // tick 98: first arrives on road 1
    expect(first.state).toBe("arrived");
    stepChecked(city, state, 1); // tick 99: second released, newcomer still behind
    expect(second.state).toBe("moving");
    expect(state.vehicles[3].state).toBe("queued");
    stepChecked(city, state, 56); // second arrives at tick 155
    expect(second.state).toBe("arrived");
    stepChecked(city, state, 1); // tick 156: newcomer finally released
    expect(state.vehicles[3].state).toBe("moving");
    expect(state.vehicles[3].waitTimeMs).toBe(73 * DT);
  });

  it("does not accumulate wait time after arrival", () => {
    const { city } = makeStreet([{ length: 10, speedLimit: 10 }]);
    const state = createTrafficState();
    spawn(city, state, 0, "car", [0], 0, 1);
    stepChecked(city, state, 10);
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("arrived");
    const trip = vehicle.tripTimeMs;
    stepChecked(city, state, 5);
    expect(vehicle.tripTimeMs).toBe(trip);
    expect(vehicle.waitTimeMs).toBe(0);
  });
});

describe("closed roads", () => {
  it("keeps a pending vehicle out of a closed first road until it opens", () => {
    const { city } = makeStreet([{ length: 10, speedLimit: 10, closed: true }]);
    const state = createTrafficState();
    const vehicle = spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
    });
    stepChecked(city, state, 3);
    expect(vehicle.state).toBe("pending");
    expect(vehicle.waitTimeMs).toBe(3 * DT);
    expect(vehicle.tripTimeMs).toBe(3 * DT);

    const opened: { city: City } = makeStreet([{ length: 10, speedLimit: 10 }]); // same topology, road open
    stepChecked(opened.city, state, 1);
    expect(vehicle.state).toBe("moving");
    expect(vehicle.waitTimeMs).toBe(3 * DT);
  });

  it("never transfers onto a closed next road", () => {
    const { city } = makeStreet([
      { length: 30, speedLimit: 10 },
      { length: 30, speedLimit: 10 },
    ]);
    const state = createTrafficState();
    const vehicle = spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 2,
      route: [0, 1],
    });
    const closed = withClosedRoads(city, [1]);
    stepChecked(closed, state, 40); // brakes and stops AT the line (30 + 10 ticks)
    expect(vehicle.state).toBe("queued");
    expect(vehicle.roadId).toBe(0);
    expect(roadOccupancy(state, 0)).toBe(1);

    const reopened = withClosedRoads(city, []);
    stepChecked(reopened, state, 1);
    expect(vehicle.state).toBe("moving");
    expect(vehicle.roadId).toBe(1);
  });

  it("lets a vehicle finish a road that becomes closed underneath it", () => {
    const { city } = makeStreet([
      { length: 5, speedLimit: 10 },
      { length: 5, speedLimit: 10 },
    ]);
    const state = createTrafficState();
    const vehicle = spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 2,
      route: [0, 1],
    });
    stepChecked(city, state, 1);
    expect(vehicle.progress).toBeCloseTo(1, 10);
    const closed = withClosedRoads(city, [0]);
    stepChecked(closed, state, 4);
    expect(vehicle.roadId).toBe(1); // finished road 0 and transferred
    expect(vehicle.state).toBe("moving");
    stepChecked(closed, state, 5);
    expect(vehicle.state).toBe("arrived");
    expect(vehicle.tripTimeMs).toBe(10 * DT);
  });

  it("queues at the end of a closed current road if the next is closed too", () => {
    const { city } = makeStreet([
      { length: 5, speedLimit: 10 },
      { length: 5, speedLimit: 10 },
    ]);
    const state = createTrafficState();
    spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 2,
      route: [0, 1],
    });
    const closed = withClosedRoads(city, [0, 1]);
    stepChecked(closed, state, 6);
    expect(state.vehicles[0].state).toBe("queued");
    expect(state.vehicles[0].roadId).toBe(0);
    expect(roadOccupancy(state, 0)).toBe(1);
  });
});
