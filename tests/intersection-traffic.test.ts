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
  // Arms are 30 m — more than twice the 13.89 m braking distance at 10 m/s —
  // so a car reaching a red light genuinely brakes to the line. With the FAST
  // timing cycle (green 10 ticks, yellow 2, all-red 1 per group = 26 ticks),
  // the arm-1 car queues at tick 32 (tool/model-timing.py derivation) and the
  // next group-1 green starts at tick 39.
  return makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 30 },
      { angleDeg: 90, length: 30 },
      { angleDeg: 180, length: 30 },
      { angleDeg: 270, length: 30 },
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

    stepChecked(city, state, 32); // reaches the road end; group 1 is red
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("queued");
    expect(vehicle.roadId).toBe(approach);
    expect(roadOccupancy(state, approach)).toBe(1);
    expect(vehicle.waitTimeMs).toBe(1 * DT); // blocked at end of tick 32

    stepChecked(city, state, 6); // through tick 38 (cycle: green 26-35, yellow 36-37, all-red 38)
    expect(vehicle.state).toBe("queued");
    expect(vehicle.waitTimeMs).toBe(7 * DT); // ticks 32..38 blocked

    stepChecked(city, state, 1); // tick 39: group 1 green — released with empty downstream
    expect(vehicle.state).toBe("moving");
    expect(vehicle.roadId).toBe(exit);
    expect(roadOccupancy(state, approach)).toBe(0);
    expect(roadOccupancy(state, exit)).toBe(1);
    expect(vehicle.waitTimeMs).toBe(7 * DT); // release tick never waits

    stepChecked(city, state, 32); // tick 71: reaches the exit end and arrives
    expect(vehicle.state).toBe("arrived");
    expect(vehicle.tripTimeMs).toBe(71 * DT);
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

    stepChecked(edited, state, 34); // both braked and queued through red (cap 4 couples density: 34, not 32)
    stepChecked(edited, state, 4); // through tick 38
    stepChecked(edited, state, 1); // tick 39: green, but one car aboard blocks the next (1 + 1 > 0.9 * 2)
    expect(state.vehicles[0].state).toBe("moving");
    expect(state.vehicles[0].roadId).toBe(exit);
    expect(state.vehicles[1].state).toBe("queued"); // green && downstream full => blocked

    stepChecked(edited, state, 34); // tick 73: A arrives on the 30 m exit; capacity visible next tick
    expect(state.vehicles[0].state).toBe("arrived");
    stepChecked(edited, state, 1); // tick 74: still inside the group-1 green [65..75], B goes
    expect(state.vehicles[1].state).toBe("moving");
    expect(state.vehicles[1].waitTimeMs).toBe(41 * DT);
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
