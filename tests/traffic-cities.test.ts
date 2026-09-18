import { describe, expect, it } from "vitest";
import { findRoute } from "@/sim/astar";
import { generateCity } from "@/sim/city-generator";
import { checkTrafficInvariants, createTrafficState, spawnVehicle, stepTraffic } from "@/sim/traffic";
import type { CitySize, VehicleType } from "@/sim/types";

const ALL_SIZES: CitySize[] = [
  "small",
  "small-medium",
  "medium",
  "medium-large",
  "large",
];

const TYPES: VehicleType[] = ["car", "truck", "bicycle"];

describe("vehicle movement on generated cities", () => {
  it("routes, spawns, and moves all three vehicle classes to arrival on every size", () => {
    for (const size of ALL_SIZES) {
      const city = generateCity(size, 42);
      const goal = city.intersections.length - 1;
      const route = findRoute(city, 0, goal);
      expect(route.found).toBe(true);
      if (!route.found) {
        continue;
      }

      const state = createTrafficState();
      TYPES.forEach((type, index) => {
        spawnVehicle(city, state, {
          id: index,
          type,
          origin: 0,
          destination: goal,
          route: route.roadIds,
        });
      });

      const maxTicks = 20000;
      let ticks = 0;
      while (
        state.vehicles.some((vehicle) => vehicle.state !== "arrived") &&
        ticks < maxTicks
      ) {
        stepTraffic(city, state);
        ticks += 1;
        if (ticks % 25 === 0) {
          expect(checkTrafficInvariants(city, state)).toEqual([]);
        }
        for (const vehicle of state.vehicles) {
          if (vehicle.roadId !== null && vehicle.state !== "arrived") {
            expect(state.occupancy.get(vehicle.roadId) ?? 0).toBeLessThanOrEqual(
              city.roads[vehicle.roadId].capacity + 1e-9,
            );
          }
        }
      }

      expect(ticks).toBeLessThan(maxTicks);
      expect(checkTrafficInvariants(city, state)).toEqual([]);
      for (const vehicle of state.vehicles) {
        expect(vehicle.state).toBe("arrived");
        expect(vehicle.tripTimeMs).toBeGreaterThan(0);
      }
      expect(state.occupancy.size).toBe(0);
      // Cross-class trip-time ordering is not asserted here: signal waits make
      // it non-monotonic. Class speed ordering is covered by unit movement tests.
    }
  });
});
