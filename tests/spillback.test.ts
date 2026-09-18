import { describe, expect, it } from "vitest";
import { SPILLBACK_ADMISSION_RATIO } from "@/sim/config";
import { createTrafficState, spawnVehicle, stepTraffic } from "@/sim/traffic";
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

  it("reopens admission once occupancy falls back below the headroom", () => {
    // Short road so the whole fleet cycles through within the test window:
    // trucks cover 0.56 units per 100ms tick, bikes 0.64, cars 1.0.
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
    for (let tick = 0; tick < 600; tick += 1) {
      stepTraffic(city, state);
    }
    for (const vehicle of state.vehicles) {
      expect(vehicle.state).toBe("arrived");
    }
    expect(state.occupancy.size).toBe(0);
  });
});
