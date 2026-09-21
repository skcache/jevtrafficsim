import { describe, expect, it } from "vitest";
import { SIMULATION_TIMESTEP_MS } from "@/sim/config";
import { createTrafficState, spawnVehicle, stepTraffic } from "@/sim/traffic";
import type { TrafficState } from "@/sim/traffic";
import type { City, VehicleType } from "@/sim/types";
import { makeStreet, snapshotTraffic } from "./traffic-support";

function spawnCarOnStreet(
  city: City,
  state: TrafficState,
  id: number,
  type: VehicleType,
  route: number[],
  origin = 0,
  destination = 1,
): void {
  spawnVehicle(city, state, { id, type, origin, destination, route });
}

describe("movement at the fixed timestep", () => {
  it("advances vehicles by speedLimit * multiplier * dt", () => {
    for (const type of ["car", "truck", "bicycle"] as VehicleType[]) {
      // Capacity 8 is the local-kind default: a lone vehicle (footprint 1-2)
      // stays at a quarter of the road at most, below the free-flow occupancy
      // threshold (0.45), so this fixture isolates the pure speed law from the
      // road-traffic factor that couples density to speed.
      const { city } = makeStreet([{ length: 50, speedLimit: 10, capacity: 8 }]);
      const state = createTrafficState();
      spawnCarOnStreet(city, state, 0, type, [0]);
      stepTraffic(city, state);
      const expected = 10 * (type === "car" ? 1 : type === "truck" ? 0.7 : 0.8) * 0.1;
      expect(state.vehicles[0].progress).toBeCloseTo(expected, 10);
      stepTraffic(city, state);
      stepTraffic(city, state);
      expect(state.vehicles[0].progress).toBeCloseTo(expected * 3, 10);
    }
  });

  it("arrives exactly at the end of the final road", () => {
    const { city } = makeStreet([{ length: 10, speedLimit: 10 }]);
    const state = createTrafficState();
    spawnCarOnStreet(city, state, 0, "car", [0]);
    for (let i = 0; i < 9; i += 1) {
      stepTraffic(city, state);
    }
    expect(state.vehicles[0].state).toBe("moving");
    expect(state.vehicles[0].progress).toBeCloseTo(9, 10);
    stepTraffic(city, state);
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("arrived");
    expect(vehicle.tripTimeMs).toBe(10 * SIMULATION_TIMESTEP_MS);
    expect(vehicle.waitTimeMs).toBe(0);
    expect(state.occupancy.size).toBe(0);
  });

  it("carries leftover distance across road boundaries within one tick", () => {
    const { city } = makeStreet([
      { length: 0.4, speedLimit: 10 },
      { length: 0.4, speedLimit: 10 },
      { length: 0.4, speedLimit: 10 },
    ]);
    const state = createTrafficState();
    spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 3,
      route: [0, 1, 2],
    });
    stepTraffic(city, state);
    const vehicle = state.vehicles[0];
    expect(vehicle.roadId).toBe(2);
    expect(vehicle.routeIndex).toBe(2);
    expect(vehicle.progress).toBeCloseTo(0.2, 10);
    expect(vehicle.state).toBe("moving");
    stepTraffic(city, state);
    expect(vehicle.state).toBe("arrived");
    expect(vehicle.tripTimeMs).toBe(2 * SIMULATION_TIMESTEP_MS);
    expect(vehicle.waitTimeMs).toBe(0);
  });

  it("steps by an explicit dt override and rejects invalid dt", () => {
    const { city } = makeStreet([{ length: 50, speedLimit: 10 }]);
    const state = createTrafficState();
    spawnCarOnStreet(city, state, 0, "car", [0]);
    stepTraffic(city, state, 200);
    expect(state.vehicles[0].progress).toBeCloseTo(2, 10);
    expect(state.timeMs).toBe(200);
    expect(() => stepTraffic(city, state, 0)).toThrow(RangeError);
    expect(() => stepTraffic(city, state, -100)).toThrow(RangeError);
    expect(() => stepTraffic(city, state, Number.NaN)).toThrow(RangeError);
  });

  it("is deterministic for identical initial state and tick sequences", () => {
    const build = (): { city: City; state: TrafficState } => {
      const { city } = makeStreet([
        { length: 2, speedLimit: 10 },
        { length: 10, speedLimit: 10, capacity: 2 },
      ]);
      const state = createTrafficState();
      spawnVehicle(city, state, {
        id: 0,
        type: "car",
        origin: 1,
        destination: 2,
        route: [1],
      });
      spawnVehicle(city, state, {
        id: 1,
        type: "car",
        origin: 0,
        destination: 2,
        route: [0, 1],
      });
      spawnVehicle(city, state, {
        id: 2,
        type: "bicycle",
        origin: 0,
        destination: 2,
        route: [0, 1],
      });
      return { city, state };
    };
    const a = build();
    const b = build();
    for (let i = 0; i < 40; i += 1) {
      stepTraffic(a.city, a.state);
      stepTraffic(b.city, b.state);
    }
    expect(snapshotTraffic(a.state)).toBe(snapshotTraffic(b.state));
  });
});
