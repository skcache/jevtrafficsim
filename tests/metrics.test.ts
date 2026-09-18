import { describe, expect, it } from "vitest";
import { type SignalTiming } from "@/sim/config";
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
      recordTick(metrics, blockedCity, state);
    }
    const vehicle = state.vehicles[0];
    expect(vehicle.state).toBe("queued");
    const result = computeMetrics(metrics, state);
    // Active 1 vehicle every tick; blocked (queued) from tick 10 on: 11/20.
    expect(result.gridlockRatio).toBeCloseTo(11 / 20, 12);
    expect(result.averageRoadOccupancy).toBeCloseTo(20 / 20 / 2, 12); // 1 unit on road 0, 2 roads
    expect(result.maxRoadOccupancy).toBe(1);
    expect(result.completedTrips).toBe(0);
    expect(result.averageTripTimeMs).toBe(0);
    expect(result.p95WaitTimeMs).toBe(0);
    expect(result.throughputPerMinute).toBe(0);
  });

  it("derives arrival metrics from recorded arrivals", () => {
    const state = createTrafficState();
    const metrics = createMetricsAccumulator();
    state.timeMs = 60_000;
    recordArrival(metrics, { vehicleId: 0, tripTimeMs: 1000, waitTimeMs: 800, routeDistance: 50 });
    recordArrival(metrics, { vehicleId: 1, tripTimeMs: 2000, waitTimeMs: 400, routeDistance: 60 });
    recordArrival(metrics, { vehicleId: 2, tripTimeMs: 1500, waitTimeMs: 0, routeDistance: 70 });
    recordArrival(metrics, { vehicleId: 2, tripTimeMs: 1500, waitTimeMs: 0, routeDistance: 70 }); // dedupe
    const result = computeMetrics(metrics, state);
    expect(result.completedTrips).toBe(3);
    expect(result.averageTripTimeMs).toBeCloseTo(1500, 12);
    expect(result.averageWaitTimeMs).toBeCloseTo(400, 12);
    expect(result.p95WaitTimeMs).toBe(800); // [0, 400, 800] -> ceil(2.85)-1 = 2
    expect(result.maxWaitTimeMs).toBe(800);
    expect(result.throughputPerMinute).toBe(3);
    expect(result.averageRouteDistance).toBeCloseTo(60, 12);
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
      recordTick(metrics, city, state);
    }
    // tick 10 green->yellow, tick 12 yellow->all-red, tick 13 all-red->green
    const result = computeMetrics(metrics, state);
    expect(result.signalPhaseChanges).toBe(3);
  });
});
