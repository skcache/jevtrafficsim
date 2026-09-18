import { describe, expect, it } from "vitest";
import {
  SIMULATION_TIMESTEP_MS as DT,
  STOP_SIGN_MIN_STOP_MS,
} from "@/sim/config";
import {
  checkTrafficInvariants,
  createTrafficState,
  spawnVehicle,
  stepTraffic,
} from "@/sim/traffic";
import type { TrafficState } from "@/sim/traffic";
import type { City } from "@/sim/types";
import { makeCrossroads } from "./traffic-support";

// STOP_SIGN_MIN_STOP_MS / DT = 15 ticks of minimum stop.
const STOP_TICKS = STOP_SIGN_MIN_STOP_MS / DT;

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

describe("stop-controlled intersections", () => {
  it("requires the minimum stop duration even with an empty downstream", () => {
    const { city, approachRoadIds, exitRoadIds } = makeCrossroads({
      control: "stop",
      arms: [
        { angleDeg: 0, length: 2 },
        { angleDeg: 90, length: 2 },
      ],
    });
    const state = createTrafficState();
    spawn(city, state, 0, [approachRoadIds[0], exitRoadIds[0]], 1, 2);

    stepChecked(city, state, 2); // arrives at the road end on tick 2
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("queued");
    expect(vehicle.roadId).toBe(approachRoadIds[0]);
    expect(vehicle.queuedSinceMs).toBe(2 * DT);

    stepChecked(city, state, STOP_TICKS - 2); // ticks 3..15: still inside the minimum stop
    expect(vehicle.state).toBe("queued");

    stepChecked(city, state, 1); // tick 16: 1400ms since arrival — still blocked
    expect(vehicle.state).toBe("queued");
    expect(vehicle.waitTimeMs).toBe(15 * DT);

    stepChecked(city, state, 1); // tick 17: 1500ms reached — released
    expect(vehicle.state).toBe("moving");
    expect(vehicle.roadId).toBe(exitRoadIds[0]);
    expect(vehicle.waitTimeMs).toBe(15 * DT); // release tick does not wait
  });

  it("a later same-road vehicle cannot pass a waiting one and ties break by id", () => {
    const { city, approachRoadIds, exitRoadIds } = makeCrossroads({
      control: "stop",
      arms: [{ angleDeg: 0, length: 2 }],
    });
    const state = createTrafficState();
    spawn(city, state, 0, [approachRoadIds[0], exitRoadIds[0]], 1, 2);
    spawn(city, state, 1, [approachRoadIds[0], exitRoadIds[0]], 1, 2);

    stepChecked(city, state, 2);
    expect(state.vehicles[0].state).toBe("queued");
    expect(state.vehicles[1].state).toBe("queued");

    stepChecked(city, state, STOP_TICKS - 2); // through tick 15
    stepChecked(city, state, 1); // tick 16
    expect(state.vehicles[0].state).toBe("queued");

    stepChecked(city, state, 1); // tick 17: only the lower id may cross
    expect(state.vehicles[0].state).toBe("moving");
    expect(state.vehicles[0].roadId).toBe(exitRoadIds[0]);
    expect(state.vehicles[1].state).toBe("queued");

    stepChecked(city, state, 1); // tick 18: the second follows
    expect(state.vehicles[1].state).toBe("moving");
    expect(state.vehicles[1].roadId).toBe(exitRoadIds[0]);

    expect(state.vehicles[0].waitTimeMs).toBe(15 * DT);
    expect(state.vehicles[1].waitTimeMs).toBe(16 * DT);
  });

  it("serves the earlier arrival first across different approaches", () => {
    const { city, approachRoadIds, exitRoadIds } = makeCrossroads({
      control: "stop",
      arms: [
        { angleDeg: 90, length: 2 },
        { angleDeg: 270, length: 5 },
      ],
    });
    const state = createTrafficState();
    spawn(city, state, 0, [approachRoadIds[0], exitRoadIds[0]], 1, 2);
    spawn(city, state, 1, [approachRoadIds[1], exitRoadIds[1]], 3, 4);

    stepChecked(city, state, 2);
    expect(state.vehicles[0].state).toBe("queued");
    expect(state.vehicles[1].state).toBe("moving"); // still travelling its longer approach

    stepChecked(city, state, 3); // tick 5: the second arrives at the stop line
    expect(state.vehicles[1].state).toBe("queued");
    expect(state.vehicles[1].queuedSinceMs).toBe(5 * DT);

    stepChecked(city, state, STOP_TICKS - 2 - 3); // through tick 15
    stepChecked(city, state, 1); // tick 16
    stepChecked(city, state, 1); // tick 17: earliest arrival released
    expect(state.vehicles[0].state).toBe("moving");
    expect(state.vehicles[1].state).toBe("queued"); // not yet at its own 1500ms

    stepChecked(city, state, 3); // tick 20: second satisfies its minimum stop
    expect(state.vehicles[1].state).toBe("moving");
    expect(state.vehicles[0].waitTimeMs).toBe(15 * DT);
    expect(state.vehicles[1].waitTimeMs).toBe(15 * DT);
  });

  it("lets the earliest eligible FEASIBLE vehicle cross while a blocked head waits", () => {
    // Policy under test (see sim/intersection.ts): the stop-sign slot goes to
    // the earliest eligible feasible vehicle in queue order — a capacity-blocked
    // head does not consume its turn, so a later feasible vehicle may proceed.
    const fixture = makeCrossroads({
      control: "stop",
      arms: [
        { angleDeg: 90, length: 2 },
        { angleDeg: 270, length: 2 },
      ],
    });
    const approachA = fixture.city.roads[0];
    const exitA = { ...fixture.city.roads[1], capacity: 1, length: 20 };
    const approachB = fixture.city.roads[2];
    const exitB = fixture.city.roads[3];
    const city = { ...fixture.city, roads: [approachA, exitA, approachB, exitB] };
    const state = createTrafficState();
    spawn(city, state, 0, [exitA.id], 0, 2); // C parks on A's exit road
    spawn(city, state, 1, [approachA.id, exitA.id], 1, 2); // earliest arrival, blocked downstream
    spawn(city, state, 2, [approachB.id, exitB.id], 3, 4); // later arrival, clear downstream

    stepChecked(city, state, 2);
    expect(state.vehicles[1].state).toBe("queued");
    expect(state.vehicles[2].state).toBe("queued");

    stepChecked(city, state, STOP_TICKS); // through tick 17 (both past their stop minimum)
    expect(state.vehicles[1].state).toBe("queued"); // feasible check fails for A
    expect(state.vehicles[2].state).toBe("moving"); // feasible B crosses at tick 17
    expect(state.vehicles[2].waitTimeMs).toBe(15 * DT);

    stepChecked(city, state, 3); // ticks 18-20: C clears its exit road on tick 20
    expect(state.vehicles[1].state).toBe("queued");
    stepChecked(city, state, 1); // tick 21: A finally feasible
    expect(state.vehicles[1].state).toBe("moving");
    expect(state.vehicles[1].waitTimeMs).toBe(19 * DT);
  });

  it("keeps a blocked head vehicle waiting and never lets the follower through", () => {
    const fixture = makeCrossroads({
      control: "stop",
      arms: [{ angleDeg: 90, length: 2 }],
    });
    const approachRoad = fixture.city.roads[0];
    const exitRoad = { ...fixture.city.roads[1], capacity: 1, length: 20 };
    const exitEnd = 2;
    const edited = {
      ...fixture.city,
      roads: [approachRoad, exitRoad],
    };
    const state = createTrafficState();
    // C parks on the exit road (occupying its only capacity unit until tick 20).
    spawn(edited, state, 0, [exitRoad.id], 0, exitEnd);
    spawn(edited, state, 1, [approachRoad.id, exitRoad.id], 1, exitEnd);
    spawn(edited, state, 2, [approachRoad.id, exitRoad.id], 1, exitEnd);

    stepChecked(edited, state, 2);
    expect(state.vehicles[1].state).toBe("queued");
    expect(state.vehicles[2].state).toBe("queued");

    stepChecked(edited, state, 18); // ticks 3..20: C reaches the exit end on tick 20
    expect(state.vehicles[0].state).toBe("arrived");
    expect(state.vehicles[1].state).toBe("queued"); // capacity visible next tick
    expect(state.vehicles[2].state).toBe("queued");

    stepChecked(edited, state, 1); // tick 21: head of the queue proceeds
    expect(state.vehicles[1].state).toBe("moving");
    expect(state.vehicles[1].roadId).toBe(exitRoad.id);
    expect(state.vehicles[2].state).toBe("queued");

    stepChecked(edited, state, 19); // ticks 22..40: A traverses the 20-length exit road
    stepChecked(edited, state, 1); // tick 41: follower finally crosses
    expect(state.vehicles[2].state).toBe("moving");
    expect(state.vehicles[1].waitTimeMs).toBe(19 * DT);
    expect(state.vehicles[2].waitTimeMs).toBe(39 * DT);
  });

  it("treats uncontrolled intersections as permissive (Task 05 behaviour)", () => {
    const { city, approachRoadIds, exitRoadIds } = makeCrossroads({
      control: "uncontrolled",
      arms: [{ angleDeg: 0, length: 2 }],
    });
    const state = createTrafficState();
    spawn(city, state, 0, [approachRoadIds[0], exitRoadIds[0]], 1, 2);
    stepChecked(city, state, 2); // crosses the empty intersection in the movement phase
    expect(state.vehicles[0].state).toBe("moving");
    expect(state.vehicles[0].roadId).toBe(exitRoadIds[0]);
    stepChecked(city, state, 2);
    expect(state.vehicles[0].state).toBe("arrived");
    expect(state.vehicles[0].waitTimeMs).toBe(0);
    expect(state.vehicles[0].tripTimeMs).toBe(4 * DT);
  });
});
