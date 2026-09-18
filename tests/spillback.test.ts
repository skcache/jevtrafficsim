import { describe, expect, it } from "vitest";
import { SPILLBACK_ADMISSION_RATIO } from "@/sim/config";
import { createTrafficState, spawnVehicle, stepTraffic } from "@/sim/traffic";
import { makeStreet } from "./traffic-support";

describe("spillback admission", () => {
  it("restricts admission once occupancy approaches capacity", () => {
    const { city } = makeStreet([{ length: 1000, capacity: 20 }]);
    const state = createTrafficState();
    // Nine trucks fill exactly 90% of capacity (18.0 of 20 units).
    for (let i = 0; i < 9; i += 1) {
      spawnVehicle(city, state, { id: i, type: "truck", origin: 0, destination: 1, route: [0] });
    }
    expect(state.occupancy.get(0)).toBeCloseTo(18, 9);
    // A bicycle still fits within the spillback headroom (18.0 <= 0.9 * 20).
    spawnVehicle(city, state, { id: 9, type: "bicycle", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[9].state).toBe("moving");
    expect(state.occupancy.get(0)).toBeCloseTo(18.3, 9);
    // Occupancy now exceeds the headroom: further entrants are refused even
    // though absolute capacity (20) would still admit them.
    spawnVehicle(city, state, { id: 10, type: "bicycle", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[10].state).toBe("pending"); // 18.3 + 0.3 <= 20 absolute
    spawnVehicle(city, state, { id: 11, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[11].state).toBe("pending"); // 18.3 + 1.0 = 19.3 <= 20 absolute
    expect(state.occupancy.get(0)).toBeCloseTo(18.3, 9);
    expect(SPILLBACK_ADMISSION_RATIO).toBe(0.9);
  });

  it("still admits freely up to the headroom and never exceeds absolute capacity", () => {
    const { city } = makeStreet([{ length: 1000, capacity: 4 }]);
    const state = createTrafficState();
    for (let i = 0; i < 4; i += 1) {
      spawnVehicle(city, state, { id: i, type: "car", origin: 0, destination: 1, route: [0] });
      expect(state.vehicles[i].state).toBe("moving");
    }
    expect(state.occupancy.get(0)).toBeCloseTo(4, 9);
    spawnVehicle(city, state, { id: 4, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[4].state).toBe("pending");
    expect(state.occupancy.get(0)).toBeCloseTo(4, 9);
  });

  it("reopens admission once occupancy falls back below the headroom", () => {
    // Short road so the whole fleet cycles through within the test window:
    // trucks cover 0.56 units per 100ms tick, bikes 0.64, cars 1.0.
    const { city } = makeStreet([{ length: 100, capacity: 20 }]);
    const state = createTrafficState();
    for (let i = 0; i < 9; i += 1) {
      spawnVehicle(city, state, { id: i, type: "truck", origin: 0, destination: 1, route: [0] });
    }
    spawnVehicle(city, state, { id: 9, type: "bicycle", origin: 0, destination: 1, route: [0] });
    spawnVehicle(city, state, { id: 10, type: "bicycle", origin: 0, destination: 1, route: [0] });
    spawnVehicle(city, state, { id: 11, type: "car", origin: 0, destination: 1, route: [0] });
    expect(state.vehicles[10].state).toBe("pending");
    expect(state.vehicles[11].state).toBe("pending");
    for (let tick = 0; tick < 600; tick += 1) {
      stepTraffic(city, state);
    }
    for (const vehicle of state.vehicles) {
      expect(vehicle.state).toBe("arrived");
    }
    expect(state.occupancy.size).toBe(0);
  });
});
