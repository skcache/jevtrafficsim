import { describe, expect, it } from "vitest";
import { createApproachStats, updateApproachStats } from "@/sim/approach-stats";
import { SIMULATION_TIMESTEP_MS as DT, type SignalTiming } from "@/sim/config";
import { createSignalState } from "@/sim/signals";
import { createTrafficState, spawnVehicle, stepTraffic } from "@/sim/traffic";
import { makeCrossroads } from "./traffic-support";

const FAST_TIMING: SignalTiming = {
  minGreenMs: 300,
  maxGreenMs: 1000,
  yellowMs: 200,
  allRedMs: 100,
};

function queuedFixture() {
  const { city, centerId, approachRoadIds, exitRoadIds } = makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 2 },
      { angleDeg: 90, length: 2 },
      { angleDeg: 180, length: 2 },
      { angleDeg: 270, length: 2 },
    ],
  });
  const state = createTrafficState();
  state.signals.set(centerId, createSignalState(city, centerId, FAST_TIMING));
  // group 1 (90deg + 270deg arms) is red until tick 13
  spawnVehicle(city, state, { id: 0, type: "car", origin: 3, destination: 4, route: [approachRoadIds[1], exitRoadIds[1]] });
  spawnVehicle(city, state, { id: 1, type: "car", origin: 3, destination: 4, route: [approachRoadIds[1], exitRoadIds[1]] });
  spawnVehicle(city, state, { id: 2, type: "car", origin: 7, destination: 8, route: [approachRoadIds[3], exitRoadIds[3]] });
  return { city, state, approachRoadIds, exitRoadIds };
}

describe("approach queue statistics", () => {
  it("tracks per-approach queue length, max wait, occupancy ratio and peaks", () => {
    const { city, state, approachRoadIds } = queuedFixture();
    const stats = createApproachStats();
    for (let tick = 0; tick < 12; tick += 1) {
      stepTraffic(city, state);
      updateApproachStats(stats, city, state);
    }
    const road90 = approachRoadIds[1];
    const road270 = approachRoadIds[3];
    const first = stats.current.get(road90);
    expect(first).toBeDefined();
    expect(first?.queued).toBe(2);
    expect(first?.maxWaitMs).toBe(1100); // queued at the end of ticks 2..12
    expect(first?.occupancyRatio).toBeCloseTo(0.5, 9); // 2 cars on a capacity-4 road
    const other = stats.current.get(road270);
    expect(other?.queued).toBe(1);
    expect(other?.maxWaitMs).toBe(1100);
    expect(stats.peakWaitMs.get(road90)).toBe(1100);
    expect(stats.worstPeakWaitMs).toBe(1100);
    expect(stats.worstPeakRoadId).toBe(road90); // epoch ties keep the first road
  });

  it("keeps historical peaks after the queue drains", () => {
    const { city, state, approachRoadIds } = queuedFixture();
    const stats = createApproachStats();
    for (let tick = 0; tick < 15; tick += 1) {
      stepTraffic(city, state);
      updateApproachStats(stats, city, state);
    }
    expect(stats.current.size).toBe(0); // everyone released (tick 13) and arrived
    const road90 = approachRoadIds[1];
    expect(stats.peakWaitMs.get(road90)).toBe(1100);
    expect(stats.worstPeakWaitMs).toBe(1100);
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
