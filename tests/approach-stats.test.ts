import { describe, expect, it } from "vitest";
import { createApproachStats, updateApproachStats } from "@/sim/approach-stats";
import { SIMULATION_TIMESTEP_MS as DT, type SignalTiming } from "@/sim/config";
import { computeMetrics, createMetricsAccumulator, recordTick } from "@/sim/metrics";
import { createSignalState } from "@/sim/signals";
import { createTrafficState, spawnVehicle, stepTraffic } from "@/sim/traffic";
import type { Intersection, Road } from "@/sim/types";
import { makeCrossroads } from "./traffic-support";

const FAST_TIMING: SignalTiming = {
  minGreenMs: 300,
  maxGreenMs: 1000,
  yellowMs: 200,
  allRedMs: 100,
};

function queuedFixture() {
  // 48 m arms (3.5x the 13.89 m braking distance at 10 m/s) and capacity 8
  // (the local-kind default): every approach stays free-flowing, so all three
  // cars brake to the red line and queue on the SAME tick (49) and the
  // tie-break is genuinely canonical, not an artifact of density. The next
  // group-1 green releases them at tick 65 (derived with tools/model-timing.py).
  const { city, centerId, approachRoadIds, exitRoadIds } = makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 48, capacity: 8 },
      { angleDeg: 90, length: 48, capacity: 8 },
      { angleDeg: 180, length: 48, capacity: 8 },
      { angleDeg: 270, length: 48, capacity: 8 },
    ],
  });
  const state = createTrafficState();
  state.signals.set(centerId, createSignalState(city, centerId, FAST_TIMING));
  // group 1 (90deg + 270deg arms) is red until tick 39, green 39..48, then
  // red again until the next group-1 green. The 270deg car (road 6)
  // spawns FIRST so encounter order differs from road-id order — tie-breaking
  // must be canonical, not order-of-sight.
  spawnVehicle(city, state, { id: 0, type: "car", origin: 7, destination: 8, route: [approachRoadIds[3], exitRoadIds[3]] });
  spawnVehicle(city, state, { id: 1, type: "car", origin: 3, destination: 4, route: [approachRoadIds[1], exitRoadIds[1]] });
  spawnVehicle(city, state, { id: 2, type: "car", origin: 3, destination: 4, route: [approachRoadIds[1], exitRoadIds[1]] });
  return { city, state, approachRoadIds, exitRoadIds };
}

describe("approach queue statistics", () => {
  it("tracks per-approach queue length, max wait, occupancy ratio and peaks", () => {
    const { city, state, approachRoadIds } = queuedFixture();
    const stats = createApproachStats();
    for (let tick = 0; tick < 60; tick += 1) {
      stepTraffic(city, state);
      updateApproachStats(stats, city, state);
    }
    const road90 = approachRoadIds[1];
    const road270 = approachRoadIds[3];
    const first = stats.current.get(road90);
    expect(first).toBeDefined();
    expect(first?.queued).toBe(2);
    expect(first?.maxWaitMs).toBe(1100); // continuous wait: timeMs - queuedSinceMs (4900) at tick 60
    expect(first?.occupancyRatio).toBeCloseTo(0.25, 9); // 2 cars on a capacity-8 road
    const other = stats.current.get(road270);
    expect(other?.queued).toBe(1);
    expect(other?.maxWaitMs).toBe(1100);
    expect(stats.peakWaitMs.get(road90)).toBe(1100);
    expect(stats.worstPeakWaitMs).toBe(1100);
    // Equal peaks resolve to the LOWEST road id (canonical), regardless of
    // which vehicle queued first.
    expect(stats.worstPeakRoadId).toBe(road90);
    expect(road90).toBeLessThan(road270);
  });

  it("keeps historical peaks after the queue drains", () => {
    const { city, state, approachRoadIds } = queuedFixture();
    const stats = createApproachStats();
    for (let tick = 0; tick < 120; tick += 1) {
      stepTraffic(city, state);
      updateApproachStats(stats, city, state);
    }
    expect(stats.current.size).toBe(0); // everyone released (tick 65) and arrived (tick 113)
    const road90 = approachRoadIds[1];
    // The last queued sample is tick 64: 6400 - 4900 = 1500 ms.
    expect(stats.peakWaitMs.get(road90)).toBe(1500);
    expect(stats.worstPeakWaitMs).toBe(1500);
  });

  it("attributes waits to the CURRENT approach, not the vehicle's lifetime", () => {
    // One vehicle: waits 30 s at signal S1 (node 1), then queues briefly at
    // signal S2 (node 3) whose red window ends ~1 s later. The S2 approach
    // must report the CONTINUOUS queue time (~400 ms at the observation),
    // never the lifetime. Road lengths are scaled past the braking distance:
    // road 0 (S1 approach) 30 m, road 1 30 m, road 2 (S2 approach) 60 m so
    // the car reaches S2 during a red window (tick 446, derived) and waits
    // for the next group-1 green at 455.
    const nodes: Intersection[] = [
      { id: 0, x: 0, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 1, x: 0, y: 10, incoming: [], outgoing: [], control: "signal", regionId: 0 },
      { id: 2, x: 20, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 3, x: 20, y: 10, incoming: [], outgoing: [], control: "signal", regionId: 0 },
      { id: 4, x: -10, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 5, x: 10, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 6, x: 30, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    ];
    const roads: Road[] = [
      { id: 0, from: 0, to: 1, length: 30, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // S1 approach
      { id: 1, from: 1, to: 2, length: 30, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false },
      { id: 2, from: 2, to: 3, length: 60, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // S2 approach
      { id: 3, from: 3, to: 6, length: 30, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false },
      { id: 4, from: 4, to: 1, length: 30, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // S1 dummy axis
      { id: 5, from: 5, to: 3, length: 30, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false }, // S2 dummy axis
    ];
    for (const road of roads) {
      nodes[road.from].outgoing.push(road.id);
      nodes[road.to].incoming.push(road.id);
    }
    const city = {
      size: "small" as const,
      seed: 0,
      gridWidth: 2,
      gridHeight: 2,
      intersections: nodes,
      roads,
      corridors: [],
    };
    const state = createTrafficState();
    // S1 runs default timing (long first red); S2 runs FAST timing so its
    // second-group green arrives ~1 s after the vehicle reaches S2.
    state.signals.set(3, createSignalState(city, 3, FAST_TIMING));
    spawnVehicle(city, state, { id: 0, type: "car", origin: 0, destination: 6, route: [0, 1, 2, 3] });
    const stats = createApproachStats();
    const metrics = createMetricsAccumulator();
    for (let tick = 0; tick < 450; tick += 1) {
      stepTraffic(city, state);
      updateApproachStats(stats, city, state);
      recordTick(metrics, city, state, DT);
    }
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("queued"); // waiting at S2's red light
    expect(vehicle.roadId).toBe(2);
    const s2 = stats.current.get(2);
    expect(s2?.queued).toBe(1);
    expect(s2?.maxWaitMs).toBe(400); // continuous at S2: queued since tick 446
    // The 30.5 s lifetime (long S1 wait + short S2 wait) must NOT leak into
    // the approach statistic.
    expect(vehicle.waitTimeMs).toBe(30_500);
    expect(s2?.maxWaitMs).toBeLessThan(vehicle.waitTimeMs);
    // The run metric is the peak CONTINUOUS approach wait (S1's 29.9 s); the
    // lifetime-inflated 30.5 s at S2 must not become the maximum.
    const result = computeMetrics(metrics, state);
    expect(result.maxApproachWaitMs).toBe(29_900);
    expect(stats.peakWaitMs.get(0)).toBe(29_900);
    expect(stats.worstPeakRoadId).toBe(0);
  });

  it("is deterministic across identical runs", () => {
    const serialize = () => {
      const { city, state } = queuedFixture();
      const stats = createApproachStats();
      for (let tick = 0; tick < 30; tick += 1) {
        stepTraffic(city, state);
        updateApproachStats(stats, city, state);
      }
      return JSON.stringify({
        current: [...stats.current.entries()].sort((a, b) => a[0] - b[0]),
        peak: [...stats.peakWaitMs.entries()].sort((a, b) => a[0] - b[0]),
        worst: stats.worstPeakWaitMs,
        worstRoad: stats.worstPeakRoadId,
      });
    };
    expect(serialize()).toBe(serialize());
  });

  it("stays empty for a move-only sample", () => {
    const { city } = makeCrossroads({
      control: "uncontrolled",
      arms: [{ angleDeg: 0, length: 200 }],
    });
    const state = createTrafficState();
    spawnVehicle(city, state, { id: 0, type: "car", origin: 1, destination: 2, route: [0, 1] });
    const stats = createApproachStats();
    for (let tick = 0; tick < 5; tick += 1) {
      stepTraffic(city, state);
      updateApproachStats(stats, city, state);
    }
    expect(stats.current.size).toBe(0);
    expect(stats.worstPeakWaitMs).toBe(0);
    expect(DT).toBe(100);
  });
});
