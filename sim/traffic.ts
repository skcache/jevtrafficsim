/**
 * Deterministic vehicle movement layer (PRD §8, §10, §11.3).
 *
 * The caller owns time: `stepTraffic(city, state, dtMs)` advances exactly one
 * discrete step. There are no timers and no wall-clock reads in this module.
 *
 * ## Tick order (documented policy)
 *
 *   1. clock     — state.timeMs += dtMs
 *   2. signals   — every signal advances dtMs (legal mechanics only; axis
 *                  groups served in a ring; single-group holds green; the
 *                  engine passes controller hold/advance directives via
 *                  options.signalDirectives)
 *   3. trip time — every non-arrived vehicle += dtMs
 *   4. pending   — capacity-blocked spawns retry their first road (id order)
 *   5. queue     — road-end waiters retry transfers in (queuedSinceMs asc,
 *                  id asc) order, so the longest-waiting vehicle is served
 *                  first and late arrivals cannot jump the queue; transfers
 *                  require open + capacity + intersection permission
 *   6. movement  — moving vehicles advance; road ends transfer with leftover
 *                  distance in a route-length-bounded loop; blocked transfers
 *                  park the vehicle at the road end (state queued)
 *   7. wait time — vehicles still pending/queued at tick end += dtMs
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
 * (first road unavailable) or queued (road end; next road full, closed, or
 * its intersection control — red signal, unsatisfied stop minimum — not yet
 * passed).
 * Normal movement — even slowly, even in a truck — never accrues wait time.
 * tripTimeMs accrues every tick for every spawned, non-arrived vehicle.
 */
import {
  SIMULATION_EPSILON,
  SIMULATION_TIMESTEP_MS,
  SPILLBACK_ADMISSION_RATIO,
} from "./config";
import {
  createIntersectionStepContext,
  evaluateIntersectionControl,
  recordControlGrant,
  type IntersectionStepContext,
} from "./intersection";
import {
  createSignalState,
  stepSignal,
  validateSignalPlanForCity,
  validateSignalState,
  type SignalDirective,
  type SignalState,
} from "./signals";
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
  /** Signal mechanics per signal-controlled intersection (Task 06). */
  signals: Map<IntersectionId, SignalState>;
}

export function createTrafficState(): TrafficState {
  return { timeMs: 0, vehicles: [], occupancy: new Map(), signals: new Map() };
}

/** Creates signal states for signal-controlled intersections that lack one. */
function ensureSignals(city: City, state: TrafficState): void {
  for (const intersection of city.intersections) {
    if (intersection.control === "signal" && !state.signals.has(intersection.id)) {
      state.signals.set(intersection.id, createSignalState(city, intersection.id));
    }
  }
}

/**
 * Advances every signal by dtMs, applying any controller directives for this
 * tick. Without a directive a multi-group signal still advances through its
 * legal safety bound (maxGreen forces a switch); single-group signals hold
 * green regardless.
 */
function advanceSignals(
  city: City,
  state: TrafficState,
  dtMs: number,
  directives?: ReadonlyMap<IntersectionId, SignalDirective>,
): void {
  ensureSignals(city, state);
  for (const intersection of city.intersections) {
    if (intersection.control === "signal") {
      const signal = state.signals.get(intersection.id);
      if (signal) {
        stepSignal(signal, dtMs, directives?.get(intersection.id));
      }
    }
  }
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

/**
 * Entry check for every admission path (spawns, pending retries, transfers):
 * - absolute capacity (Task 05): occupancy + footprint must fit, so a vehicle
 *   is never released into a full edge;
 * - spillback headroom (Task 08, PRD §11.3): the admission decision uses the
 *   PROJECTED occupancy (current + this vehicle's footprint). Once occupancy
 *   has reached SPILLBACK_ADMISSION_RATIO of capacity nothing new is admitted,
 *   and no admitted vehicle may push the road past that threshold — so the
 *   final stretch of every road stays clear for the vehicles already on it.
 */
function hasCapacity(state: TrafficState, road: Road, footprint: number): boolean {
  const projected = roadOccupancy(state, road.id) + footprint;
  if (projected > road.capacity + SIMULATION_EPSILON) {
    return false;
  }
  return projected <= road.capacity * SPILLBACK_ADMISSION_RATIO + SIMULATION_EPSILON;
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
  context: IntersectionStepContext,
): void {
  const nextRoadId = vehicle.route[vehicle.routeIndex + 1];
  const currentRoadId = vehicle.roadId;
  if (nextRoadId === undefined || currentRoadId === null) {
    // A queued vehicle always has a current and a next road; defensive only.
    return;
  }
  const next = city.roads[nextRoadId];
  if (!next || next.closed) {
    return;
  }
  if (!hasCapacity(state, next, vehicleFootprint(vehicle.type))) {
    return;
  }
  if (
    evaluateIntersectionControl(
      city,
      state,
      currentRoadId,
      nextRoadId,
      vehicle.queuedSinceMs,
      context,
    ) !== "granted"
  ) {
    return;
  }
  leaveRoad(state, vehicle);
  vehicle.routeIndex += 1;
  enterRoad(state, vehicle, next);
  recordControlGrant(city, nextRoadId, context);
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
  context: IntersectionStepContext,
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
      !hasCapacity(state, next, vehicleFootprint(vehicle.type)) ||
      evaluateIntersectionControl(
        city,
        state,
        roadId,
        nextRoadId,
        vehicle.queuedSinceMs,
        context,
      ) !== "granted"
    ) {
      vehicle.state = "queued";
      vehicle.queuedSinceMs = state.timeMs;
      return;
    }
    leaveRoad(state, vehicle);
    vehicle.routeIndex += 1;
    enterRoad(state, vehicle, next);
    recordControlGrant(city, nextRoadId, context);
  }
}

/**
 * Registers a vehicle at the caller's current simulation time
 * (spawnTimeMs = state.timeMs) and enters it onto the first road — or parks
 * it as `pending` when that road is closed or full, retrying each tick in id
 * order. Spawning is deliberately not gated by intersection control: origins
 * are abstract (Task 05 contract). The caller is responsible for invoking
 * this at the intended spawn time; demand scheduling is caller policy
 * (Task 07), not simulation machinery — no hidden timers exist here.
 */
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

/**
 * Optional per-tick inputs from the engine (Task 07). `signalDirectives`
 * carries the controller's hold/advance decisions for this tick; a missing
 * entry means "no opinion".
 */
export interface TrafficStepOptions {
  readonly signalDirectives?: ReadonlyMap<IntersectionId, SignalDirective>;
}

export function stepTraffic(
  city: City,
  state: TrafficState,
  dtMs: number = SIMULATION_TIMESTEP_MS,
  options: TrafficStepOptions = {},
): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    throw new RangeError(`dtMs must be a finite positive number, received ${dtMs}`);
  }
  state.timeMs += dtMs;
  const dtSeconds = dtMs / 1000;

  advanceSignals(city, state, dtMs, options.signalDirectives);

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

  const context = createIntersectionStepContext();
  const queued = state.vehicles
    .filter((vehicle) => vehicle.state === "queued")
    .sort(
      (a, b) =>
        (a.queuedSinceMs ?? 0) - (b.queuedSinceMs ?? 0) || a.id - b.id,
    );
  for (const vehicle of queued) {
    attemptTransfer(city, state, vehicle, context);
  }

  for (const vehicle of state.vehicles) {
    if (vehicle.state === "moving") {
      advance(city, state, vehicle, dtSeconds, context);
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

  for (const [intersectionId, signal] of state.signals) {
    for (const problem of validateSignalState(signal)) {
      problems.push(`signal[${intersectionId}]: ${problem}`);
    }
    for (const problem of validateSignalPlanForCity(city, intersectionId, signal.groups)) {
      problems.push(`signal[${intersectionId}]: ${problem}`);
    }
    if (city.intersections[intersectionId]?.control !== "signal") {
      problems.push(`signal state for non-signal intersection ${intersectionId}`);
    }
  }

  return problems;
}
