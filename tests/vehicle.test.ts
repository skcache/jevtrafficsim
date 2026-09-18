import { describe, expect, it } from "vitest";
import { VEHICLE_TYPE_SPECS } from "@/sim/config";
import { createTrafficState, spawnVehicle } from "@/sim/traffic";
import {
  effectiveSpeed,
  vehicleFootprint,
  vehicleSpeedMultiplier,
} from "@/sim/vehicle";
import { makeStreet } from "./traffic-support";

describe("vehicle type configuration", () => {
  it("matches the PRD footprints and speed multipliers", () => {
    expect(VEHICLE_TYPE_SPECS.car).toEqual({ footprint: 1, speedMultiplier: 1 });
    expect(VEHICLE_TYPE_SPECS.truck).toEqual({
      footprint: 2,
      speedMultiplier: 0.7,
    });
    expect(VEHICLE_TYPE_SPECS.bicycle).toEqual({
      footprint: 0.3,
      speedMultiplier: 0.8,
    });
    expect(vehicleFootprint("car")).toBe(1);
    expect(vehicleFootprint("truck")).toBe(2);
    expect(vehicleFootprint("bicycle")).toBe(0.3);
    expect(vehicleSpeedMultiplier("truck")).toBe(0.7);
  });

  it("derives effective speed from the road limit and vehicle type", () => {
    const { city } = makeStreet([{ length: 100, speedLimit: 20 }]);
    const road = city.roads[0];
    expect(effectiveSpeed(road, "car")).toBe(20);
    expect(effectiveSpeed(road, "truck")).toBeCloseTo(14, 10);
    expect(effectiveSpeed(road, "bicycle")).toBeCloseTo(16, 10);
  });
});

describe("spawn validation", () => {
  it("requires sequential vehicle ids", () => {
    const { city } = makeStreet([{ length: 10 }]);
    const state = createTrafficState();
    spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
    });
    expect(() =>
      spawnVehicle(city, state, {
        id: 7,
        type: "car",
        origin: 0,
        destination: 1,
        route: [0],
      }),
    ).toThrow(RangeError);
  });

  it("rejects routes with unknown or discontinuous roads", () => {
    const { city } = makeStreet([{ length: 10 }, { length: 10 }, { length: 10 }]);
    const state = createTrafficState();
    expect(() =>
      spawnVehicle(city, state, {
        id: 0,
        type: "car",
        origin: 0,
        destination: 3,
        route: [0, 99],
      }),
    ).toThrow(RangeError);
    expect(() =>
      spawnVehicle(city, state, {
        id: 0,
        type: "car",
        origin: 0,
        destination: 3,
        route: [0, 2],
      }),
    ).toThrow(RangeError);
  });

  it("rejects origin/destination mismatches", () => {
    const { city } = makeStreet([{ length: 10 }]);
    const state = createTrafficState();
    expect(() =>
      spawnVehicle(city, state, {
        id: 0,
        type: "car",
        origin: 1,
        destination: 1,
        route: [0],
      }),
    ).toThrow(RangeError);
    expect(() =>
      spawnVehicle(city, state, {
        id: 0,
        type: "car",
        origin: 0,
        destination: 5,
        route: [0],
      }),
    ).toThrow(RangeError);
  });

  it("allows an empty route only when origin equals destination", () => {
    const { city } = makeStreet([{ length: 10 }]);
    const state = createTrafficState();
    const vehicle = spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 0,
      route: [],
    });
    expect(vehicle.state).toBe("arrived");
    expect(vehicle.roadId).toBeNull();
    expect(vehicle.tripTimeMs).toBe(0);
    expect(() =>
      spawnVehicle(city, state, {
        id: 1,
        type: "car",
        origin: 0,
        destination: 1,
        route: [],
      }),
    ).toThrow(RangeError);
  });

  it("enters an open first road immediately with a footprint charge", () => {
    const { city } = makeStreet([{ length: 10, speedLimit: 20 }]);
    const state = createTrafficState();
    const vehicle = spawnVehicle(city, state, {
      id: 0,
      type: "truck",
      origin: 0,
      destination: 1,
      route: [0],
    });
    expect(vehicle.state).toBe("moving");
    expect(vehicle.roadId).toBe(0);
    expect(vehicle.progress).toBe(0);
    expect(vehicle.speed).toBeCloseTo(14, 10);
    expect(vehicle.spawnTimeMs).toBe(0);
    expect(state.occupancy.get(0)).toBe(2);
  });

  it("creates pending vehicles on a closed or full first road", () => {
    const closed = makeStreet([{ length: 10, closed: true }]);
    const closedState = createTrafficState();
    const blocked = spawnVehicle(closed.city, closedState, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
    });
    expect(blocked.state).toBe("pending");
    expect(blocked.roadId).toBeNull();
    expect(closedState.occupancy.size).toBe(0);

    // Capacity 2 with one car aboard: the second car (1 + 1 > 1.8) waits.
    const full = makeStreet([{ length: 10, capacity: 2 }]);
    const fullState = createTrafficState();
    spawnVehicle(full.city, fullState, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
    });
    const waiting = spawnVehicle(full.city, fullState, {
      id: 1,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
    });
    expect(waiting.state).toBe("pending");
    expect(fullState.occupancy.get(0)).toBe(1);
  });
});
