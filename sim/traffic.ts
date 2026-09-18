/**
 * Deterministic vehicle movement layer (PRD §8, §10, §11.3).
 *
 * The caller owns time: `stepTraffic(city, state, dtMs)` advances exactly one
 * discrete step. There are no timers and no wall-clock reads in this module.
 *
 * ## Tick order (documented policy)
 *
 *   1. clock     — state.timeMs += dtMs
 *   2. trip time — every non-arrived vehicle += dtMs
 *   3. pending   — capacity-blocked spawns retry their first road (id order)
 *   4. queue     — road-end waiters retry transfers in (queuedSinceMs asc,
 *                  id asc) order, so the longest-waiting vehicle is served
 *                  first and late arrivals cannot jump the queue
 *   5. movement  — moving vehicles advance; road ends transfer with leftover
 *                  distance in a route-length-bounded loop; blocked transfers
 *                  park the vehicle at the road end (state queued)
 *   6. wait time — vehicles still pending/queued at tick end += dtMs
 *
 * Queues are served before movement, so capacity freed by this tick's
 * arrivals becomes visible to waiters on the NEXT tick; a vehicle released
 * from a queue moves in the same tick it departs. Both are deliberate.
 *
 * ## Capacity
 *
 * Occupancy is normalized footprint units per directed road (car 1, truck 2,
 * bicycle 0.3) tracked in `state.occupancy`; entering requires
 * `occupancy + footprint <= capacity + SIMULATION_EPSILON`. The same map can
 * be handed to A* as its occupancy source (ratio = units / capacity).
 *
 * ## Waiting rules
 *
 * waitTimeMs accrues only while the vehicle is blocked at tick end: pending
 * (first road unavailable) or queued (road end; next road full or closed).
 * Normal movement — even slowly, even in a truck — never accrues wait time.
 * tripTimeMs accrues every tick for every spawned, non-arrived vehicle.
 */
import { SIMULATION_EPSILON, SIMULATION_TIMESTEP_MS } from "./config";
import type {
  City,
  IntersectionId,
  Road,
  RoadId,
  Vehicle,
  VehicleId,
  VehicleType,
} from "./types";
import {
  effectiveSpeed,
  validateVehicleRoute,
  vehicleFootprint,
} from "./vehicle";

export interface TrafficState {
  /** Simulation clock in milliseconds; advanced by stepTraffic. */
  timeMs: number;
  /** Dense vehicle list: vehicles[i].id === i. */
  vehicles: Vehicle[];
  /** Footprint units currently occupying each directed road. */
  occupancy: Map<RoadId, number>;
}

export function createTrafficState(): TrafficState {
  return { timeMs: 0, vehicles: [], occupancy: new Map() };
}

export interface VehicleSpawnSpec {
  /** Must equal state.vehicles.length (ids are allocated sequentially). */
  id: VehicleId;
  type: VehicleType;
  origin: IntersectionId;
  destination: IntersectionId;
  route: RoadId[];
  /** Defaults to the state's current simulation time. */
  spawnTimeMs?: number;
}

/** Current occupancy (footprint units) of a directed road. */
export function roadOccupancy(state: TrafficState, roadId: RoadId): number {
  return state.occupancy.get(roadId) ?? 0;
}

function addOccupancy(state: TrafficState, roadId: RoadId, units: number): void {
  state.occupancy.set(roadId, (state.occupancy.get(roadId) ?? 0) + units);
}

function removeOccupancy(
  state: TrafficState,
  roadId: RoadId,
  units: number,
): void {
  const remaining = (state.occupancy.get(roadId) ?? 0) - units;
  if (remaining <= SIMULATION_EPSILON) {
    state.occupancy.delete(roadId);
  } else {
    state.occupancy.set(roadId, remaining);
  }
}

function hasCapacity(state: TrafficState, road: Road, footprint: number): boolean {
  return (
    roadOccupancy(state, road.id) + footprint <= road.capacity + SIMULATION_EPSILON
  );
}

function enterRoad(state: TrafficState, vehicle: Vehicle, road: Road): void {
  addOccupancy(state, road.id, vehicleFootprint(vehicle.type));
  vehicle.roadId = road.id;
  vehicle.progress = 0;
  vehicle.speed = effectiveSpeed(road, vehicle.type);
  vehicle.state = "moving";
  vehicle.queuedSinceMs = null;
}

function leaveRoad(state: TrafficState, vehicle: Vehicle): void {
  if (vehicle.roadId !== null) {
    removeOccupancy(state, vehicle.roadId, vehicleFootprint(vehicle.type));
  }
}

function attemptFirstEntry(
  city: City,
  state: TrafficState,
  vehicle: Vehicle,
): void {
  const road = city.roads[vehicle.route[0]];
  if (!road || road.closed) {
    return;
  }
  if (!hasCapacity(state, road, vehicleFootprint(vehicle.type))) {
    return;
  }
  enterRoad(state, vehicle, road);
}

function attemptTransfer(
  city: City,
  state: TrafficState,
  vehicle: Vehicle,
): void {
  const nextRoadId = vehicle.route[vehicle.routeIndex + 1];
  if (nextRoadId === undefined) {
    // A queued vehicle always has a next road; defensive only.
    return;
  }
  const next = city.roads[nextRoadId];
  if (!next || next.closed) {
    return;
  }
  if (!hasCapacity(state, next, vehicleFootprint(vehicle.type))) {
    return;
  }
  leaveRoad(state, vehicle);
  vehicle.routeIndex += 1;
  enterRoad(state, vehicle, next);
}

function arrive(state: TrafficState, vehicle: Vehicle): void {
  leaveRoad(state, vehicle);
  vehicle.state = "arrived";
  vehicle.queuedSinceMs = null;
}

/** Advances one moving vehicle, carrying leftover distance across road ends. */
function advance(
  city: City,
  state: TrafficState,
  vehicle: Vehicle,
  dtSeconds: number,
): void {
  let remaining = vehicle.speed * dtSeconds;
  let guard = 0;
  while (remaining > 0 && guard <= vehicle.route.length) {
    guard += 1;
    const roadId = vehicle.roadId;
    if (roadId === null) {
      return;
    }
    const road = city.roads[roadId];
    const toEnd = road.length - vehicle.progress;
    if (remaining < toEnd) {
      vehicle.progress += remaining;
      return;
    }
    remaining -= toEnd;
    vehicle.progress = road.length;

    const nextRoadId = vehicle.route[vehicle.routeIndex + 1];
    if (nextRoadId === undefined) {
      arrive(state, vehicle);
      return;
    }
    const next = city.roads[nextRoadId];
    if (
      !next ||
      next.closed ||
      !hasCapacity(state, next, vehicleFootprint(vehicle.type))
    ) {
      vehicle.state = "queued";
      vehicle.queuedSinceMs = state.timeMs;
      return;
    }
    leaveRoad(state, vehicle);
    vehicle.routeIndex += 1;
    enterRoad(state, vehicle, next);
  }
}

export function spawnVehicle(
  city: City,
  state: TrafficState,
  spec: VehicleSpawnSpec,
): Vehicle {
  if (spec.id !== state.vehicles.length) {
    throw new RangeError(
      `vehicle ids must be allocated sequentially: expected ${state.vehicles.length}, received ${spec.id}`,
    );
  }
  if (spec.type !== "car" && spec.type !== "truck" && spec.type !== "bicycle") {
    throw new RangeError(`unknown vehicle type ${spec.type}`);
  }
  validateVehicleRoute(city, spec.route, spec.origin, spec.destination);
  const spawnTimeMs = spec.spawnTimeMs ?? state.timeMs;
  if (!Number.isFinite(spawnTimeMs) || spawnTimeMs < 0) {
    throw new RangeError(`spawnTimeMs must be finite and >= 0, received ${spawnTimeMs}`);
  }

  const vehicle: Vehicle = {
    id: spec.id,
    type: spec.type,
    origin: spec.origin,
    destination: spec.destination,
    route: [...spec.route],
    routeIndex: 0,
    roadId: null,
    progress: 0,
    speed: 0,
    waitTimeMs: 0,
    tripTimeMs: 0,
    state: spec.route.length === 0 ? "arrived" : "pending",
    spawnTimeMs,
    queuedSinceMs: null,
  };
  state.vehicles.push(vehicle);
  if (vehicle.state === "pending") {
    attemptFirstEntry(city, state, vehicle);
  }
  return vehicle;
}

export function stepTraffic(
  city: City,
  state: TrafficState,
  dtMs: number = SIMULATION_TIMESTEP_MS,
): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    throw new RangeError(`dtMs must be a finite positive number, received ${dtMs}`);
  }
  state.timeMs += dtMs;
  const dtSeconds = dtMs / 1000;

  for (const vehicle of state.vehicles) {
    if (vehicle.state !== "arrived") {
      vehicle.tripTimeMs += dtMs;
    }
  }

  for (const vehicle of state.vehicles) {
    if (vehicle.state === "pending") {
      attemptFirstEntry(city, state, vehicle);
    }
  }

  const queued = state.vehicles
    .filter((vehicle) => vehicle.state === "queued")
    .sort(
      (a, b) =>
        (a.queuedSinceMs ?? 0) - (b.queuedSinceMs ?? 0) || a.id - b.id,
    );
  for (const vehicle of queued) {
    attemptTransfer(city, state, vehicle);
  }

  for (const vehicle of state.vehicles) {
    if (vehicle.state === "moving") {
      advance(city, state, vehicle, dtSeconds);
    }
  }

  for (const vehicle of state.vehicles) {
    if (vehicle.state === "pending" || vehicle.state === "queued") {
      vehicle.waitTimeMs += dtMs;
    }
  }
}

/**
 * Lightweight consistency checks for tests and debug builds. Returns a list
 * of problems; empty means consistent.
 */
export function checkTrafficInvariants(
  city: City,
  state: TrafficState,
): string[] {
  const problems: string[] = [];
  const expected = new Map<RoadId, number>();

  state.vehicles.forEach((vehicle, index) => {
    if (vehicle.id !== index) {
      problems.push(`vehicles[${index}]: id mismatch (${vehicle.id})`);
    }
    if (vehicle.waitTimeMs < 0 || vehicle.tripTimeMs < 0) {
      problems.push(`vehicles[${vehicle.id}]: negative time accounting`);
    }
    if (vehicle.state === "pending") {
      if (vehicle.roadId !== null) {
        problems.push(`vehicles[${vehicle.id}]: pending but occupies a road`);
      }
      if (vehicle.progress !== 0) {
        problems.push(`vehicles[${vehicle.id}]: pending but has progress`);
      }
    }
    if (vehicle.state !== "pending" && vehicle.state !== "arrived") {
      const roadId = vehicle.roadId;
      const road = roadId === null ? undefined : city.roads[roadId];
      if (!road || roadId === null) {
        problems.push(`vehicles[${vehicle.id}]: active but not on a valid road`);
      } else {
        if (
          vehicle.progress < -SIMULATION_EPSILON ||
          vehicle.progress > road.length + SIMULATION_EPSILON
        ) {
          problems.push(
            `vehicles[${vehicle.id}]: progress ${vehicle.progress} outside [0, ${road.length}]`,
          );
        }
        if (vehicle.routeIndex < 0 || vehicle.routeIndex >= vehicle.route.length) {
          problems.push(
            `vehicles[${vehicle.id}]: routeIndex ${vehicle.routeIndex} out of bounds`,
          );
        }
        expected.set(roadId, (expected.get(roadId) ?? 0) + vehicleFootprint(vehicle.type));
      }
    }
    if (
      vehicle.state === "arrived" &&
      vehicle.route.length > 0 &&
      vehicle.routeIndex !== vehicle.route.length - 1
    ) {
      problems.push(
        `vehicles[${vehicle.id}]: arrived with routeIndex ${vehicle.routeIndex}`,
      );
    }
  });

  for (const [roadId, units] of state.occupancy) {
    const road = city.roads[roadId];
    if (!road) {
      problems.push(`occupancy references unknown road ${roadId}`);
      continue;
    }
    if (units > road.capacity + 1e-6) {
      problems.push(
        `occupancy[${roadId}] = ${units} exceeds capacity ${road.capacity}`,
      );
    }
    const want = expected.get(roadId) ?? 0;
    if (Math.abs(units - want) > 1e-6) {
      problems.push(`occupancy[${roadId}] = ${units}, expected ${want}`);
    }
  }
  for (const [roadId, units] of expected) {
    if (!state.occupancy.has(roadId) && units > 1e-6) {
      problems.push(`occupancy missing road ${roadId} (${units} units)`);
    }
  }

  return problems;
}
