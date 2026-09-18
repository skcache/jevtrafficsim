import { describe, expect, it } from "vitest";
import { SIMULATION_TIMESTEP_MS as DT, type SignalTiming } from "@/sim/config";
import {
  computeMetrics,
  createMetricsAccumulator,
  mean,
  percentile,
  recordArrival,
  recordTick,
  throughputPerMinute,
} from "@/sim/metrics";
import { createSignalState } from "@/sim/signals";
import { createTrafficState, spawnVehicle, stepTraffic } from "@/sim/traffic";
import { makeCrossroads, makeStreet, withClosedRoads } from "./traffic-support";

describe("metric math", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 0.95)).toBe(0);
    expect(percentile([500], 0.95)).toBe(500);
    expect(percentile([3, 1, 2], 0.5)).toBe(2); // sorts a copy first
    const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
    expect(percentile(ten, 0.95)).toBe(1000); // ceil(9.5)-1 = 9
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(twenty, 0.95)).toBe(1900); // ceil(19)-1 = 18
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 0.95)).toBe(95); // exact index
  });

  it("computes means and throughput", () => {
    expect(mean([])).toBe(0);
    expect(mean([100, 300])).toBe(200);
    expect(mean([100, 200, 300])).toBe(200);
    expect(throughputPerMinute(0, 60_000)).toBe(0);
    expect(throughputPerMinute(30, 60_000)).toBe(30);
    expect(throughputPerMinute(30, 120_000)).toBe(15);
    expect(throughputPerMinute(15, 30_000)).toBe(30);
  });
});

describe("metrics accumulation", () => {
  it("samples congestion, occupancy and arrivals over ticks", () => {
    // One car driving into a closed next road: moving for 9 ticks, then queued.
    const { city } = makeStreet([{ length: 10 }, { length: 10 }]);
    const blockedCity = withClosedRoads(city, [1]);
    const state = createTrafficState();
    const metrics = createMetricsAccumulator();
    spawnVehicle(blockedCity, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 2,
      route: [0, 1],
    });
    for (let tick = 0; tick < 20; tick += 1) {
      stepTraffic(blockedCity, state);
      recordTick(metrics, blockedCity, state, DT);
    }
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("queued");
    const result = computeMetrics(metrics, state);
    // Vehicle-time weighting: active 20 ticks * 1 = 2000ms; blocked 11 ticks
    // * 1 = 1100ms -> 1100/2000 (same value as the old mean here because the
    // active count is constant; the weighting test below shows the difference).
    expect(result.gridlockRatio).toBeCloseTo(11 / 20, 12);
    expect(result.averageRoadOccupancy).toBeCloseTo(20 / 20 / 2, 12); // 1 unit on road 0, 2 roads
    expect(result.maxRoadOccupancy).toBe(1);
    expect(result.completedTrips).toBe(0);
    expect(result.averageTripTimeMs).toBe(0);
    // Wait pressure covers the active queued car, so these are NOT zero.
    expect(result.averageWaitTimeMs).toBe(vehicle.waitTimeMs);
    expect(result.p95WaitTimeMs).toBe(vehicle.waitTimeMs);
    expect(result.maxWaitTimeMs).toBe(vehicle.waitTimeMs);
    expect(result.throughputPerMinute).toBe(0);
  });

  it("keeps trip stats on completed vehicles and wait stats on ALL spawned vehicles", () => {
    // Real ugly case: two cars that arrive quickly, plus one car stuck at a
    // closed road end accruing a huge wait. Wait stats must expose it.
    const { city } = makeStreet([{ length: 10 }, { length: 10 }]);
    const blocked = withClosedRoads(city, [1]);
    const state = createTrafficState();
    const metrics = createMetricsAccumulator();
    spawnVehicle(blocked, state, { id: 0, type: "car", origin: 0, destination: 1, route: [0] });
    spawnVehicle(blocked, state, { id: 1, type: "car", origin: 0, destination: 1, route: [0] });
    spawnVehicle(blocked, state, { id: 2, type: "car", origin: 0, destination: 2, route: [0, 1] });
    for (let tick = 0; tick < 500; tick += 1) {
      stepTraffic(blocked, state);
      for (const vehicle of state.vehicles) {
        if (vehicle.state === "arrived") {
          recordArrival(metrics, {
            vehicleId: vehicle.id,
            tripTimeMs: vehicle.tripTimeMs,
            waitTimeMs: vehicle.waitTimeMs,
          routeDistance: 10,
          });
        }
      }
    }
    const [done0, done1, stuck] = state.vehicles;
    expect(done0.state).toBe("arrived");
    expect(done1.state).toBe("arrived");
    expect(stuck.state).toBe("queued");
    const result = computeMetrics(metrics, state);
    // Trip performance: completed population only.
    expect(result.completedTrips).toBe(2);
    expect(result.averageTripTimeMs).toBeCloseTo((done0.tripTimeMs + done1.tripTimeMs) / 2, 9);
    // Wait pressure: the entire spawned population, including the stuck car.
    expect(result.averageWaitTimeMs).toBeCloseTo(
      (done0.waitTimeMs + done1.waitTimeMs + stuck.waitTimeMs) / 3,
      9,
    );
    expect(result.maxWaitTimeMs).toBe(stuck.waitTimeMs);
    expect(result.p95WaitTimeMs).toBe(stuck.waitTimeMs);
    // And it is clearly not the completed-only value.
    expect(result.averageWaitTimeMs).toBeGreaterThan(10_000);
  });

  it("weights gridlock by vehicle time, not by averaging per-tick ratios", () => {
    // Phase 1 (ticks 1..10): only the stuck car exists -> 1 active, blocked
    // from tick 6. Phase 2 (ticks 11..20): 100 movers join -> 101 active,
    // still 1 blocked. Vehicle-time ratio = blockedMs / activeMs.
    const { city, approachRoadIds, exitRoadIds } = makeCrossroads({
      control: "uncontrolled",
      arms: [
        { angleDeg: 0, length: 6, capacity: 500 },
        { angleDeg: 180, length: 10_000, capacity: 500 },
      ],
    });
    const blocked = withClosedRoads(city, [exitRoadIds[0]]);
    const state = createTrafficState();
    const metrics = createMetricsAccumulator();
    // Stuck car: enters via arm 0 and queues at the closed arm-0 exit.
    spawnVehicle(blocked, state, { id: 0, type: "car", origin: 1, destination: 2, route: [approachRoadIds[0], exitRoadIds[0]] });
    for (let tick = 0; tick < 10; tick += 1) {
      stepTraffic(blocked, state);
      recordTick(metrics, blocked, state, DT);
    }
    expect(state.vehicles[0].state).toBe("queued");
    // 100 movers cross to the long open exit and keep moving.
    for (let extra = 1; extra <= 100; extra += 1) {
      spawnVehicle(blocked, state, { id: extra, type: "car", origin: 1, destination: 4, route: [approachRoadIds[0], exitRoadIds[1]] });
    }
    for (let tick = 0; tick < 10; tick += 1) {
      stepTraffic(blocked, state);
      recordTick(metrics, blocked, state, DT);
    }
    const result = computeMetrics(metrics, state);
    // activeMs = 10*1*100 + 10*101*100 = 102000; blockedMs = 15*1*100 = 1500.
    expect(result.gridlockRatio).toBeCloseTo(1500 / 102_000, 12);
    // Mean-of-per-tick-ratios would give ~0.255 — the vehicle-time definition
    // must NOT produce that.
    expect(result.gridlockRatio).toBeLessThan(0.05);
  });

  it("counts signal phase changes", () => {
    const timing: SignalTiming = { minGreenMs: 300, maxGreenMs: 1000, yellowMs: 200, allRedMs: 100 };
    const { city, centerId } = makeCrossroads({
      control: "signal",
      arms: [
        { angleDeg: 0, length: 2 },
        { angleDeg: 90, length: 2 },
      ],
    });
    const state = createTrafficState();
    state.signals.set(centerId, createSignalState(city, centerId, timing));
    const metrics = createMetricsAccumulator();
    for (let tick = 0; tick < 13; tick += 1) {
      stepTraffic(city, state);
      recordTick(metrics, city, state, DT);
    }
    // tick 10 green->yellow, tick 12 yellow->all-red, tick 13 all-red->green
    const result = computeMetrics(metrics, state);
    expect(result.signalPhaseChanges).toBe(3);
  });
});
