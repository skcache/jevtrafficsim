/**
 * Physics-migration proofs (the traffic-model realism pass).
 *
 * The migration replaced per-consumer congestion rules with ONE authoritative
 * state: a per-road speed factor in [MIN_TRAFFIC_SPEED_FACTOR, 1]
 * (sim/road-traffic.ts). Vehicle motion, the A* edge cost, the trip ETA and
 * the map's colours all read that same number. These tests prove the claims
 * from the outside, so the contract cannot silently regress:
 *
 *   1. free speed > amber speed > red speed, and severity is a pure function
 *      of the factor (one mapping from flow to colour);
 *   2. acceleration and deceleration are bounded by ACCEL_MPS2 / DECEL_MPS2;
 *   3. braking reaches the PHYSICAL stop line smoothly: a deceleration ramp
 *      that ends exactly at the road end, never a teleport stop;
 *   4. one factor drives physics + routing + presentation together;
 *   5. Local routing consumes the same factor: the remaining-time estimate,
 *      the router's cost and the driver's replan decision all price exactly
 *      the factor the physics uses.
 */
import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { findRoute, computePathCost, edgeTravelCost } from "@/sim/astar";
import {
  MIN_TRAFFIC_SPEED_FACTOR,
  SIMULATION_TIMESTEP_MS as DT,
} from "@/sim/config";
import {
  createDriverState,
  decideReplan,
  LOCAL_REPLAN,
  remainingRouteSeconds,
} from "@/sim/driver";
import { createEngine, runEngine } from "@/sim/engine";
import {
  ACCEL_MPS2,
  DECEL_MPS2,
  roadSeverity,
  roadSpeedFactor,
  severityForFactor,
} from "@/sim/road-traffic";
import {
  createTrafficState,
  spawnVehicle,
  stepTraffic,
  type TrafficState,
} from "@/sim/traffic";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import type { City } from "@/sim/types";
import { makeStreet, withClosedRoads } from "./traffic-support";

const DT_SECONDS = DT / 1000;
const MAX_ACCEL_STEP = ACCEL_MPS2 * DT_SECONDS; // 0.22 m/s per tick
const MAX_DECEL_STEP = DECEL_MPS2 * DT_SECONDS; // 0.36 m/s per tick

/** One car on a 400 m local road; returns the settled state after `ticks`. */
function settledRun(factor: number | null, ticks: number): {
  city: City;
  state: TrafficState;
  roadId: number;
} {
  const { city } = makeStreet([{ length: 400, speedLimit: 10, capacity: 8 }]);
  const state = createTrafficState();
  spawnVehicle(city, state, { id: 0, type: "car", origin: 0, destination: 1, route: [0] });
  if (factor !== null) {
    state.roadTraffic.factor.set(0, factor);
  }
  for (let tick = 0; tick < ticks; tick += 1) {
    stepTraffic(city, state);
  }
  return { city, state, roadId: 0 };
}

describe("speed order and severity are one mapping", () => {
  it("drives a free road faster than an amber road faster than a red road", () => {
    // Sustained occupancy pressure holds each factor near its target:
    //   1 car of 8  -> free;  2 of 3 -> slower;  1 of 1 -> severe (crawling).
    const runs = [
      { label: "free", capacity: 8, cars: 1 },
      { label: "amber", capacity: 3, cars: 2 },
      { label: "red", capacity: 1, cars: 1 },
    ] as const;
    const observed = runs.map((run) => {
      const { city } = makeStreet([{ length: 400, speedLimit: 10, capacity: run.capacity }]);
      const state = createTrafficState();
      for (let i = 0; i < run.cars; i += 1) {
        spawnVehicle(city, state, { id: i, type: "car", origin: 0, destination: 1, route: [0] });
      }
      for (let tick = 0; tick < 300; tick += 1) {
        stepTraffic(city, state);
      }
      return {
        label: run.label,
        speed: state.vehicles[0].speed,
        factor: roadSpeedFactor(state.roadTraffic, 0),
        severity: roadSeverity(state.roadTraffic, 0),
      };
    });
    const [free, amber, red] = observed;

    // The order the map's colours claim, verified in the physics.
    expect(free.speed).toBeGreaterThan(amber.speed);
    expect(amber.speed).toBeGreaterThan(red.speed);
    // Severity is a pure function of the same factor (the only flow->colour map).
    expect(free.severity).toBe("free");
    expect(amber.severity).toBe("slower");
    expect(red.severity).toBe("severe");
    expect(severityForFactor(free.factor)).toBe("free");
    expect(severityForFactor(amber.factor)).toBe("slower");
    expect(severityForFactor(red.factor)).toBe("severe");
    // The severe road crawls at the documented jam floor, never becomes a wall.
    expect(red.factor).toBeGreaterThanOrEqual(MIN_TRAFFIC_SPEED_FACTOR);
    expect(red.speed).toBeGreaterThan(0);
    expect(red.speed).toBeLessThan(amber.speed / 2);
  });
});

describe("bounded acceleration and braking", () => {
  it("never changes speed by more than a * dt in one tick", () => {
    // Phase 1: brake to a closed road end (deceleration).
    const { city } = makeStreet([{ length: 30, speedLimit: 10, capacity: 8 }, { length: 10 }]);
    const state = createTrafficState();
    const vehicle = spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 2,
      route: [0, 1],
    });
    const blocked = withClosedRoads(city, [1]);
    let previous = vehicle.speed;
    for (let tick = 0; tick < 40; tick += 1) {
      stepTraffic(blocked, state);
      const delta = previous - vehicle.speed;
      expect(delta).toBeLessThanOrEqual(MAX_DECEL_STEP + 1e-9);
      expect(vehicle.speed - previous).toBeLessThanOrEqual(MAX_ACCEL_STEP + 1e-9);
      previous = vehicle.speed;
    }
    expect(vehicle.state).toBe("queued");

    // Phase 2: the road reopens; the released car accelerates away.
    const reopened = withClosedRoads(city, []);
    let sawAcceleration = false;
    for (let tick = 0; tick < 60; tick += 1) {
      stepTraffic(reopened, state);
      const delta = vehicle.speed - previous;
      if (delta > 0) {
        sawAcceleration = true;
        expect(delta).toBeLessThanOrEqual(MAX_ACCEL_STEP + 1e-9);
      }
      expect(previous - vehicle.speed).toBeLessThanOrEqual(MAX_DECEL_STEP + 1e-9);
      previous = vehicle.speed;
    }
    expect(sawAcceleration).toBe(true);
  });
});

describe("braking reaches the physical stop line", () => {
  it("ramps down to the line, stops there, and holds it without jitter", () => {
    const { city } = makeStreet([{ length: 30, speedLimit: 10, capacity: 8 }, { length: 10 }]);
    const state = createTrafficState();
    const vehicle = spawnVehicle(city, state, {
      id: 0,
      type: "car",
      origin: 0,
      destination: 2,
      route: [0, 1],
    });
    const blocked = withClosedRoads(city, [1]);

    // Find the queue tick and watch the approach.
    let queueTick: number | null = null;
    const speeds: number[] = [];
    for (let tick = 1; tick <= 60 && queueTick === null; tick += 1) {
      stepTraffic(blocked, state);
      speeds.push(vehicle.speed);
      if (vehicle.state === "queued") {
        queueTick = tick;
      }
    }
    expect(queueTick).not.toBeNull();

    // It really travelled the road (no stopping short, no overshoot).
    expect(vehicle.progress).toBeCloseTo(30, 9);
    // The braking phase is a ramp, not a teleport: at least 15 ticks of
    // strictly decreasing speed before the stop, none below the line speed.
    const braking = speeds.filter((speed) => speed < 10 - 1e-9);
    expect(braking.length).toBeGreaterThanOrEqual(15);
    for (let index = 1; index < braking.length; index += 1) {
      expect(braking[index]).toBeLessThanOrEqual(braking[index - 1]);
    }
    // It arrives at the line SLOW (a fifth of free flow), not at 10 m/s.
    expect(vehicle.speed).toBeLessThanOrEqual(2.5);

    // Holding the line: no jitter, no drift while queued.
    const held = vehicle.progress;
    const speedAtLine = vehicle.speed;
    for (let tick = 0; tick < 10; tick += 1) {
      stepTraffic(blocked, state);
      expect(vehicle.state).toBe("queued");
      expect(vehicle.progress).toBe(held);
      expect(vehicle.speed).toBe(speedAtLine);
    }
  });
});

describe("one factor drives physics, routing and presentation", () => {
  it("scales vehicle speed, A* cost and the presented severity from the same number", () => {
    const injected = [MIN_TRAFFIC_SPEED_FACTOR, 0.4, 0.8];
    const speeds = injected.map((factor) => {
      const { state } = settledRun(factor, 30);
      const current = roadSpeedFactor(state.roadTraffic, 0);
      // Physics: the settled speed IS the traffic speed of the road.
      expect(state.vehicles[0].speed).toBeCloseTo(10 * current, 9);
      return state.vehicles[0].speed;
    });
    expect(speeds[0]).toBeLessThan(speeds[1]);
    expect(speeds[1]).toBeLessThan(speeds[2]);

    const { city, state, roadId } = settledRun(0.4, 30);
    const factor = roadSpeedFactor(state.roadTraffic, roadId);

    // Routing: the A* edge cost prices exactly that factor.
    const road = city.roads[roadId];
    expect(computePathCost(city, [roadId], { speedFactor: (id) => roadSpeedFactor(state.roadTraffic, id) })).toBeCloseTo(
      edgeTravelCost(road, factor),
      12,
    );
    const jammed = findRoute(city, 0, 1, { speedFactor: (id) => roadSpeedFactor(state.roadTraffic, id) });
    const freeFlow = findRoute(city, 0, 1);
    expect(jammed.found && freeFlow.found).toBe(true);
    if (jammed.found && freeFlow.found) {
      expect(jammed.cost).toBeCloseTo(road.length / road.speedLimit / factor, 12);
      expect(jammed.cost).toBeGreaterThan(freeFlow.cost);
    }

    // Presentation: the frame carries the same factor and the severity derived
    // from it — and the trip ETA prices the same factor (no second slowdown
    // model lives in the worker).
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [{ timeMs: 0, type: "car", origin: 0, destination: 1, role: "ego" }],
    });
    runEngine(engine, 100);
    engine.traffic.roadTraffic.factor.set(roadId, factor);
    const snapshot = buildPresentationSnapshot(engine, 0, "loop-circuit");
    const presented = snapshot.roadTraffic.find((entry) => entry.roadId === roadId);
    expect(presented?.speedFactor).toBeCloseTo(factor, 9);
    expect(presented?.severity).toBe(severityForFactor(factor));
    const ego = engine.traffic.vehicles[engine.egoVehicleId ?? 0];
    const eta = snapshot.trip?.estimatedRemainingMs ?? 0;
    const freeEta = Math.round((((road.length - ego.progress) / road.speedLimit) * 1_000));
    expect(eta).toBeGreaterThan(freeEta);
    expect(eta).toBeCloseTo(
      Math.round((((road.length - ego.progress) / road.speedLimit / factor) * 1_000)),
      6,
    );
  });
});

describe("Local routing consumes the same factor", () => {
  it("prices the remaining route with the authoritative factor and replans on it", () => {
    const { city, state, roadId } = settledRun(0.3, 30);
    const factor = roadSpeedFactor(state.roadTraffic, roadId);

    // The estimate IS the physics: length / (speedLimit * factor).
    const seconds = remainingRouteSeconds(city, state, [roadId], 0, 0);
    expect(seconds).toBeCloseTo(city.roads[roadId].length / city.roads[roadId].speedLimit / factor, 12);

    // A jammed current route vs a free candidate: the local driver switches —
    // because the factor says so, not because of any separate congestion rule.
    const driver = createDriverState();
    const jammed = remainingRouteSeconds(city, state, [roadId], 0, 0);
    const freeState = createTrafficState();
    const candidate = remainingRouteSeconds(city, freeState, [roadId], 0, 0);
    const decision = decideReplan("local", driver, LOCAL_REPLAN.intervalMs, jammed, candidate);
    expect(decision.replan).toBe(true);
    expect(decision.reason).toBe("switch");
    // Equal factors: no material improvement, no churn.
    const flat = decideReplan("local", driver, LOCAL_REPLAN.intervalMs, candidate, candidate);
    expect(flat.replan).toBe(false);
    expect(flat.reason).toBe("not-better");
    // A tourist never replans for congestion alone.
    const tourist = decideReplan("tourist", driver, LOCAL_REPLAN.intervalMs, jammed, candidate);
    expect(tourist.replan).toBe(false);
  });

  it("prices the remaining route exactly like the router does", () => {
    // The driver's estimate and the A* edge cost are the same arithmetic on
    // the same factor, so a candidate route can never look cheaper to the
    // driver than it does to the router.
    const { city, state, roadId } = settledRun(0.3, 30);
    const estimate = remainingRouteSeconds(city, state, [roadId], 0, 0);
    const routeCost = computePathCost(city, [roadId], {
      speedFactor: (id) => roadSpeedFactor(state.roadTraffic, id),
    });
    expect(estimate).toBeCloseTo(routeCost, 12);
  });
});
