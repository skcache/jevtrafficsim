import { describe, expect, it } from "vitest";
import { SIMULATION_TIMESTEP_MS as DT, type SignalTiming } from "@/sim/config";
import { createSignalState } from "@/sim/signals";
import {
  checkTrafficInvariants,
  createTrafficState,
  roadOccupancy,
  spawnVehicle,
  stepTraffic,
} from "@/sim/traffic";
import type { TrafficState } from "@/sim/traffic";
import type { City } from "@/sim/types";
import { makeCrossroads, snapshotTraffic } from "./traffic-support";

const FAST_TIMING: SignalTiming = {
  minGreenMs: 300,
  maxGreenMs: 1000,
  yellowMs: 200,
  allRedMs: 100,
};

function signalCity() {
  return makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 2 },
      { angleDeg: 90, length: 2 },
      { angleDeg: 180, length: 2 },
      { angleDeg: 270, length: 2 },
    ],
  });
}

function spawn(
  city: City,
  state: TrafficState,
  id: number,
  route: number[],
  origin: number,
  destination: number,
): void {
  spawnVehicle(city, state, { id, type: "car", origin, destination, route });
}

function stepChecked(city: City, state: TrafficState, ticks: number): void {
  for (let i = 0; i < ticks; i += 1) {
    stepTraffic(city, state);
    expect(checkTrafficInvariants(city, state)).toEqual([]);
  }
}

describe("signalized intersection traffic", () => {
  it("queues at red, holds upstream capacity, and releases on green with Task-05 wait rules", () => {
    const { city, centerId, approachRoadIds, exitRoadIds } = signalCity();
    const state = createTrafficState();
    state.signals.set(centerId, createSignalState(city, centerId, FAST_TIMING));
    // Arm 1 (90deg) belongs to group 1, which is red while group 0 is green.
    const approach = approachRoadIds[1];
    const exit = exitRoadIds[1];
    spawn(city, state, 0, [approach, exit], 3, 4);

    stepChecked(city, state, 2); // reaches the road end; group 1 is red
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("queued");
    expect(vehicle.roadId).toBe(approach);
    expect(roadOccupancy(state, approach)).toBe(1);
    expect(vehicle.waitTimeMs).toBe(1 * DT); // blocked at end of tick 2

    stepChecked(city, state, 10); // through tick 12 (yellow tick 10-11, all-red tick 12)
    expect(vehicle.state).toBe("queued");
    expect(vehicle.waitTimeMs).toBe(11 * DT); // ticks 2..12 blocked

    stepChecked(city, state, 1); // tick 13: group 1 green — released with empty downstream
    expect(vehicle.state).toBe("moving");
    expect(vehicle.roadId).toBe(exit);
    expect(roadOccupancy(state, approach)).toBe(0);
    expect(roadOccupancy(state, exit)).toBe(1);
    expect(vehicle.waitTimeMs).toBe(11 * DT); // release tick never waits

    stepChecked(city, state, 1); // tick 14: reaches the exit end and arrives
    expect(vehicle.state).toBe("arrived");
    expect(vehicle.tripTimeMs).toBe(14 * DT);
  });

  it("keeps a green approach blocked while the downstream road is full", () => {
    const { city, centerId, approachRoadIds, exitRoadIds } = signalCity();
    const edited = {
      ...city,
      roads: city.roads.map((road) =>
        road.id === exitRoadIds[1] ? { ...road, capacity: 2 } : road,
      ),
    };
    const state = createTrafficState();
    state.signals.set(centerId, createSignalState(edited, centerId, FAST_TIMING));
    const approach = approachRoadIds[1];
    const exit = exitRoadIds[1];
    spawn(edited, state, 0, [approach, exit], 3, 4);
    spawn(edited, state, 1, [approach, exit], 3, 4);

    stepChecked(edited, state, 12); // both queued through red
    stepChecked(edited, state, 1); // tick 13: green, but one car aboard blocks the next (1 + 1 > 0.9 * 2)
    expect(state.vehicles[0].state).toBe("moving");
    expect(state.vehicles[0].roadId).toBe(exit);
    expect(state.vehicles[1].state).toBe("queued"); // green && downstream full => blocked

    stepChecked(edited, state, 2); // tick 14: A arrives; tick 15: capacity visible, B released
    expect(state.vehicles[0].state).toBe("arrived");
    expect(state.vehicles[1].state).toBe("moving");
    expect(state.vehicles[1].waitTimeMs).toBe(13 * DT);
  });

  it("is deterministic across identical runs including signal state", () => {
    const build = (): { city: City; state: TrafficState } => {
      const { city, centerId, approachRoadIds, exitRoadIds } = signalCity();
      const state = createTrafficState();
      state.signals.set(centerId, createSignalState(city, centerId, FAST_TIMING));
      spawn(city, state, 0, [approachRoadIds[1], exitRoadIds[1]], 3, 4);
      spawn(city, state, 1, [approachRoadIds[3], exitRoadIds[3]], 7, 8);
      return { city, state };
    };
    const a = build();
    const b = build();
    for (let i = 0; i < 60; i += 1) {
      stepTraffic(a.city, a.state);
      stepTraffic(b.city, b.state);
    }
    expect(snapshotTraffic(a.state)).toBe(snapshotTraffic(b.state));
  });
});
