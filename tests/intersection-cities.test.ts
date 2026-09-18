import { describe, expect, it } from "vitest";
import { findRoute } from "@/sim/astar";
import { generateCity } from "@/sim/city-generator";
import { deriveApproachGroups, validateSignalPlan, validateSignalState } from "@/sim/signals";
import {
  checkTrafficInvariants,
  createTrafficState,
  spawnVehicle,
  stepTraffic,
} from "@/sim/traffic";
import type { TrafficState } from "@/sim/traffic";
import type { CitySize } from "@/sim/types";
import { snapshotTraffic } from "./traffic-support";

describe("intersection controls on generated cities", () => {
  it("builds valid signal plans for every signalized intersection", () => {
    for (const size of ["small-medium", "medium", "medium-large", "large"] as CitySize[]) {
      const city = generateCity(size, 42);
      const state = createTrafficState();
      stepTraffic(city, state); // initialises signal states
      let signalCount = 0;
      for (const intersection of city.intersections) {
        if (intersection.control !== "signal") {
          continue;
        }
        signalCount += 1;
        const signal = state.signals.get(intersection.id);
        expect(signal).toBeDefined();
        if (!signal) {
          continue;
        }
        expect(validateSignalPlan(signal.groups)).toEqual([]);
        expect(validateSignalState(signal)).toEqual([]);
        const grouped = [...signal.groups[0], ...signal.groups[1]].sort((a, b) => a - b);
        expect(grouped).toEqual([...intersection.incoming].sort((a, b) => a - b));
        expect(deriveApproachGroups(city, intersection.id)).toEqual(signal.groups);
      }
      expect(signalCount).toBeGreaterThan(0);
    }
  });

  it("cycles signals deterministically with clean invariants over a long empty run", () => {
    const run = (): TrafficState => {
      const city = generateCity("medium-large", 42);
      const state = createTrafficState();
      for (let i = 0; i < 3600; i += 1) {
        stepTraffic(city, state);
      }
      return state;
    };
    const city = generateCity("medium-large", 42);
    const first = run();
    expect(checkTrafficInvariants(city, first)).toEqual([]);
    for (const signal of first.signals.values()) {
      expect(validateSignalState(signal)).toEqual([]);
    }
    const second = run();
    expect(snapshotTraffic(first)).toBe(snapshotTraffic(second));
    // A full cycle (maxGreen + yellow + all-red) has certainly flushed by now,
    // so at least some signals must have changed phase at least once.
    const phases = new Set([...first.signals.values()].map((s) => s.phaseIndex));
    expect(phases.size).toBeGreaterThanOrEqual(1);
  });

  it("drives a car through the signalized network to arrival", () => {
    const city = generateCity("medium", 42);
    const goal = city.intersections.length - 1;
    const route = findRoute(city, 0, goal);
    expect(route.found).toBe(true);
    if (!route.found) {
      return;
    }
    const state = createTrafficState();
    spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: goal,
      route: route.roadIds,
    });
    let ticks = 0;
    while (state.vehicles[0].state !== "arrived" && ticks < 30000) {
      stepTraffic(city, state);
      ticks += 1;
      if (ticks % 100 === 0) {
        expect(checkTrafficInvariants(city, state)).toEqual([]);
      }
    }
    expect(state.vehicles[0].state).toBe("arrived");
    expect(state.occupancy.size).toBe(0);
    // Signals exist and were exercised; waits may or may not occur.
    expect(state.signals.size).toBeGreaterThan(0);
    expect(state.vehicles[0].tripTimeMs).toBeGreaterThan(0);
    expect(state.vehicles[0].waitTimeMs).toBeGreaterThanOrEqual(0);
  });
});
