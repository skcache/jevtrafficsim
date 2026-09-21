/**
 * Authoritative road traffic dynamics: the ONE state that speed, colours and
 * routing all read. These tests pin the properties that make it trustworthy —
 * monotone pressure, asymmetric build/recover, and no rapid flashing — rather
 * than particular numbers.
 */
import { describe, expect, it } from "vitest";
import {
  ROAD_TRAFFIC,
  approachSpeed,
  brakingLimitSpeed,
  roadSeverity,
  severityForFactor,
  targetSpeedFactor,
} from "@/sim/road-traffic";
import { createTrafficState, stepTraffic, spawnVehicle } from "@/sim/traffic";
import type { City, Intersection, Road } from "@/sim/types";

function road(id: number, from: number, to: number, length = 400, capacity = 4): Road {
  return { id, from, to, length, lanes: 1, speedLimit: 10, capacity, kind: "local", closed: false };
}
function node(id: number, x: number, y: number, incoming: number[], outgoing: number[]): Intersection {
  return { id, x, y, incoming, outgoing, control: "uncontrolled", regionId: 0 };
}

/** A straight three-road chain: 0 -> 1 -> 2. */
function chain(): City {
  return {
    size: "medium",
    seed: 0,
    gridWidth: 0,
    gridHeight: 0,
    corridors: [],
    roads: [road(0, 0, 1), road(1, 1, 2)],
    intersections: [
      node(0, 0, 0, [], [0]),
      node(1, 400, 0, [0], [1]),
      node(2, 800, 0, [1], []),
    ],
  };
}

describe("road traffic state", () => {
  it("orders free above slower above severe, monotonically in pressure", () => {
    const free = targetSpeedFactor(0.1, 0, 4, 0);
    const busy = targetSpeedFactor(0.8, 0, 4, 0);
    const jammed = targetSpeedFactor(1.0, 4, 4, 30_000);
    expect(free).toBeGreaterThan(busy);
    expect(busy).toBeGreaterThan(jammed);
    expect(free).toBeCloseTo(1, 6);
    expect(jammed).toBeGreaterThanOrEqual(ROAD_TRAFFIC.minSpeedFactor);

    // Severity follows the factor, and is the ONLY flow -> colour mapping.
    expect(severityForFactor(1)).toBe("free");
    expect(severityForFactor(0.6)).toBe("slower");
    expect(severityForFactor(0.2)).toBe("severe");
  });

  it("builds congestion faster than it recovers (asymmetric hysteresis)", () => {
    const city = chain();
    const buildState = createTrafficState();
    buildState.occupancy.set(0, 4);
    let buildTicks = 0;
    while (roadSeverity(buildState.roadTraffic, 0) !== "severe" && buildTicks < 2_000) {
      stepTraffic(city, buildState, 100);
      buildTicks += 1;
    }

    const recoverState = createTrafficState();
    recoverState.occupancy.set(0, 4);
    while (roadSeverity(recoverState.roadTraffic, 0) !== "severe") {
      stepTraffic(city, recoverState, 100);
    }
    recoverState.occupancy.set(0, 0);
    let recoverTicks = 0;
    while (roadSeverity(recoverState.roadTraffic, 0) !== "free" && recoverTicks < 5_000) {
      stepTraffic(city, recoverState, 100);
      recoverTicks += 1;
    }

    // Both happen, and clearing is deliberately the slower of the two: that
    // lag is what stops a road flashing as one car crosses an intersection.
    expect(buildTicks).toBeGreaterThan(0);
    expect(buildTicks).toBeLessThan(2_000);
    expect(recoverTicks).toBeGreaterThan(buildTicks);
  });

  it("does not flash when pressure hovers at a boundary", () => {
    const city = chain();
    const state = createTrafficState();
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      // Oscillate occupancy around the free boundary every tick.
      state.occupancy.set(0, i % 2 === 0 ? 2 : 3);
      stepTraffic(city, state, 100);
      seen.add(roadSeverity(state.roadTraffic, 0));
    }
    // Smoothing means the road never swings across all three states.
    expect(seen.size).toBeLessThanOrEqual(2);
  });

  it("is deterministic: same occupancy history, same factors", () => {
    const run = (): number[] => {
      const city = chain();
      const state = createTrafficState();
      const factors: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        state.occupancy.set(0, i < 20 ? 4 : 0);
        stepTraffic(city, state, 100);
        factors.push(state.roadTraffic.factor.get(0) ?? 1);
      }
      return factors;
    };
    expect(run()).toEqual(run());
  });

  it("drops fully recovered roads, keeping the state sparse", () => {
    const city = chain();
    const state = createTrafficState();
    state.occupancy.set(0, 4);
    stepTraffic(city, state, 100);
    expect(state.roadTraffic.factor.size).toBeGreaterThan(0);
    state.occupancy.set(0, 0);
    for (let i = 0; i < 2_000; i += 1) {
      stepTraffic(city, state, 100);
    }
    expect(state.roadTraffic.factor.size).toBe(0);
    expect(roadSeverity(state.roadTraffic, 0)).toBe("free");
  });

  it("keeps a moving vehicle on a free road at its road speed", () => {
    // The state must not invent congestion where there is none: a lone vehicle
    // on an empty road drives at free flow.
    const city = chain();
    const state = createTrafficState();
    spawnVehicle(city, state, { id: 0, type: "car", origin: 0, destination: 2, route: [0, 1] });
    stepTraffic(city, state, 100);
    expect(roadSeverity(state.roadTraffic, 0)).toBe("free");
  });
});

describe("longitudinal model primitives", () => {
  it("never exceeds what the brakes can achieve for the distance left", () => {
    // Far from the stop line there is no cap; at the line the cap is zero.
    expect(brakingLimitSpeed(200)).toBeGreaterThan(20);
    expect(brakingLimitSpeed(0)).toBe(0);
    expect(brakingLimitSpeed(-5)).toBe(0);
    // Halving the distance lowers the limit by sqrt(2).
    expect(brakingLimitSpeed(50) / brakingLimitSpeed(100)).toBeCloseTo(Math.SQRT1_2, 6);
  });

  it("approaches a target with bounded acceleration and braking", () => {
    // From standstill, one second of acceleration is exactly accel * 1s.
    const accelerated = approachSpeed(0, 20, 1);
    expect(accelerated).toBeCloseTo(2.2, 6);
    // Braking is bounded too, and never overshoots below the target.
    expect(approachSpeed(20, 0, 1)).toBeCloseTo(16.4, 6);
    expect(approachSpeed(1, 0, 5)).toBe(0);
    // A target above current speed is approached, not jumped to.
    expect(approachSpeed(5, 12, 0.1)).toBeCloseTo(5.22, 6);
  });
});
