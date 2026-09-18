/**
 * Headless simulation runtime (Task 07): one deterministic fixed-timestep
 * engine that ties city, routing, traffic, signals, a controller and metrics
 * into a single loop. No DOM, no React, no timers — the caller owns time and
 * drives `stepEngine`/`runEngine` explicitly.
 *
 * ## Tick order (per 100 ms step, at simulation time T)
 *
 *   1. spawns      — every scheduled event with timeMs <= T that has not
 *                    spawned yet enters the network FIRST (route via A* with
 *                    the live occupancy map, then spawnVehicle), so a t=0
 *                    vehicle participates in the very first tick
 *   2. controller  — controller.directives(city, traffic) is computed from
 *                    the resulting current state (policy for this tick)
 *   3. traffic     — stepTraffic: clock -> signals (with directives) ->
 *                    trip -> pending -> queue -> movement -> wait
 *   4. arrivals    — vehicles that reached their destination this tick are
 *                    recorded once (trip time, wait time, route distance)
 *   5. metrics     — congestion/occupancy/signal sampling at tick end, with
 *                    the explicit step duration
 *
 * ## Spawn timing semantics
 *
 * A vehicle scheduled at T enters at the START of the tick whose clock reads
 * T: it exists before that tick's movement phase, so it participates in the
 * T -> T+dt step, and spawnTimeMs === T is its ACTUAL simulated entry time
 * (never a fabricated scheduled time). Schedule times that do not fall on
 * tick boundaries snap FORWARD to the first tick whose time is >= the
 * scheduled time. Spawning is NOT gated by intersection control (origins are
 * abstract), but it IS gated by the first road's capacity/closure: a blocked
 * entrant parks as `pending` and retries each tick. A scheduled vehicle whose
 * route cannot be found (e.g. the only path is closed) counts as a failed
 * spawn instead of throwing.
 *
 * ## Routing at spawn
 *
 * Initial routes use the congestion-aware A* cost model with the LIVE
 * occupancy map of the current state ({ occupancy: traffic.occupancy }): a
 * vehicle entering a busy street can choose a slightly longer free-flow
 * detour. No route caching and no rerouting exist here.
 *
 * ## Determinism
 *
 * Same city + controller + spawn schedule => identical state, metrics and
 * snapshots for the same tick sequence. No randomness and no wall-clock reads
 * exist anywhere in this loop.
 */
import { createApproachStats, updateApproachStats, type ApproachStats } from "./approach-stats";
import { findRoute } from "./astar";
import { SIMULATION_TIMESTEP_MS, VEHICLE_TYPE_SPECS } from "./config";
import {
  computeMetrics,
  createMetricsAccumulator,
  recordArrival,
  recordTick,
  type MetricsAccumulator,
  type SimulationMetrics,
} from "./metrics";
import type { SignalStage } from "./signals";
import {
  createTrafficState,
  spawnVehicle,
  stepTraffic,
  type TrafficState,
} from "./traffic";
import type { TrafficController } from "@/controllers/contract";
import type {
  City,
  IntersectionId,
  RoadId,
  VehicleState,
  VehicleType,
} from "./types";

export interface ScheduledSpawn {
  readonly timeMs: number;
  readonly type: VehicleType;
  readonly origin: IntersectionId;
  readonly destination: IntersectionId;
}

export interface EngineOptions {
  readonly city: City;
  readonly controller: TrafficController;
  readonly spawns: readonly ScheduledSpawn[];
}

export interface EngineState {
  readonly city: City;
  readonly controller: TrafficController;
  readonly traffic: TrafficState;
  /** Stable-sorted copy of the schedule (by timeMs, original order preserved). */
  readonly spawns: readonly ScheduledSpawn[];
  readonly metrics: MetricsAccumulator;
  /** Per-approach queue + starvation statistics (Task 08 policy input). */
  readonly approaches: ApproachStats;
  nextSpawnIndex: number;
  ticks: number;
}

function validateSpawn(city: City, spawn: ScheduledSpawn): void {
  if (!Number.isFinite(spawn.timeMs) || spawn.timeMs < 0) {
    throw new RangeError(`spawn timeMs must be finite and >= 0, received ${spawn.timeMs}`);
  }
  if (!Object.prototype.hasOwnProperty.call(VEHICLE_TYPE_SPECS, spawn.type)) {
    throw new RangeError(`unknown vehicle type ${String(spawn.type)}`);
  }
  for (const id of [spawn.origin, spawn.destination]) {
    if (!Number.isInteger(id) || id < 0 || id >= city.intersections.length) {
      throw new RangeError(`spawn endpoint ${id} is not an intersection of this city`);
    }
  }
}

export function createEngine(options: EngineOptions): EngineState {
  for (const spawn of options.spawns) {
    validateSpawn(options.city, spawn);
  }
  return {
    city: options.city,
    controller: options.controller,
    traffic: createTrafficState(),
    spawns: [...options.spawns].sort((a, b) => a.timeMs - b.timeMs),
    metrics: createMetricsAccumulator(),
    approaches: createApproachStats(),
    nextSpawnIndex: 0,
    ticks: 0,
  };
}

function recordArrivals(engine: EngineState): void {
  const { city, traffic, metrics } = engine;
  for (const vehicle of traffic.vehicles) {
    if (vehicle.state !== "arrived" || metrics.recordedArrivalIds.has(vehicle.id)) {
      continue;
    }
    let routeDistance = 0;
    for (const roadId of vehicle.route) {
      routeDistance += city.roads[roadId].length;
    }
    recordArrival(metrics, {
      vehicleId: vehicle.id,
      tripTimeMs: vehicle.tripTimeMs,
      waitTimeMs: vehicle.waitTimeMs,
      routeDistance,
    });
  }
}

function spawnDueVehicles(engine: EngineState): void {
  const { city, traffic } = engine;
  while (
    engine.nextSpawnIndex < engine.spawns.length &&
    engine.spawns[engine.nextSpawnIndex].timeMs <= traffic.timeMs
  ) {
    const spawn = engine.spawns[engine.nextSpawnIndex];
    engine.nextSpawnIndex += 1;
    const route = findRoute(city, spawn.origin, spawn.destination, {
      occupancy: traffic.occupancy,
    });
    if (!route.found) {
      engine.metrics.failedSpawns += 1;
      continue;
    }
    spawnVehicle(city, traffic, {
      id: traffic.vehicles.length,
      type: spawn.type,
      origin: spawn.origin,
      destination: spawn.destination,
      route: route.roadIds,
    });
  }
}

/**
 * Advances the simulation by exactly one fixed timestep: scheduled events due
 * at the current simulation time enter first, then the tick runs.
 */
export function stepEngine(engine: EngineState): void {
  const { city, traffic, controller } = engine;
  spawnDueVehicles(engine);
  const directives = controller.directives(city, traffic);
  stepTraffic(city, traffic, SIMULATION_TIMESTEP_MS, { signalDirectives: directives });
  engine.ticks += 1;
  recordArrivals(engine);
  recordTick(engine.metrics, city, traffic, SIMULATION_TIMESTEP_MS);
  updateApproachStats(engine.approaches, city, traffic);
}

/** Steps until simulated time reaches or passes `untilMs`. */
export function runEngine(engine: EngineState, untilMs: number): void {
  if (!Number.isFinite(untilMs) || untilMs < 0) {
    throw new RangeError(`untilMs must be finite and >= 0, received ${untilMs}`);
  }
  while (engine.traffic.timeMs < untilMs) {
    stepEngine(engine);
  }
}

export interface VehicleSnapshot {
  readonly id: number;
  readonly type: VehicleType;
  readonly state: VehicleState;
  readonly roadId: RoadId | null;
  readonly routeIndex: number;
  readonly progress: number;
  readonly waitTimeMs: number;
  readonly tripTimeMs: number;
}

export interface SignalSnapshot {
  readonly intersectionId: IntersectionId;
  readonly phaseIndex: number;
  readonly stage: SignalStage;
  readonly stageElapsedMs: number;
}

/**
 * Deterministic, JSON-serializable snapshot of the world at the current tick.
 * Vehicles keep spawn order; signals and occupancy are sorted by id, so two
 * identical runs produce byte-identical JSON.
 */
export interface SimulationSnapshot {
  readonly timeMs: number;
  readonly vehicles: VehicleSnapshot[];
  readonly signals: SignalSnapshot[];
  readonly occupancy: Array<[RoadId, number]>;
  readonly metrics: SimulationMetrics;
}

export function takeSnapshot(engine: EngineState): SimulationSnapshot {
  const { traffic } = engine;
  const signals: SignalSnapshot[] = [...traffic.signals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([intersectionId, signal]) => ({
      intersectionId,
      phaseIndex: signal.phaseIndex,
      stage: signal.stage,
      stageElapsedMs: signal.stageElapsedMs,
    }));
  const occupancy: Array<[RoadId, number]> = [...traffic.occupancy.entries()]
    .filter(([, units]) => units > 0)
    .sort((a, b) => a[0] - b[0]);
  return {
    timeMs: traffic.timeMs,
    vehicles: traffic.vehicles.map((vehicle) => ({
      id: vehicle.id,
      type: vehicle.type,
      state: vehicle.state,
      roadId: vehicle.roadId,
      routeIndex: vehicle.routeIndex,
      progress: vehicle.progress,
      waitTimeMs: vehicle.waitTimeMs,
      tripTimeMs: vehicle.tripTimeMs,
    })),
    signals,
    occupancy,
    metrics: computeMetrics(engine.metrics, traffic),
  };
}
