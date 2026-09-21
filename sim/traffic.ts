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
import {
  approachSpeed,
  brakingLimitSpeed,
  createRoadTraffic,
  roadSpeedFactor,
  stepRoadTraffic,
  type RoadTraffic,
} from "./road-traffic";

export interface TrafficState {
  /** Simulation clock in milliseconds; advanced by stepTraffic. */
  timeMs: number;
  /** Dense vehicle list: vehicles[i].id === i. */
  vehicles: Vehicle[];
  /** Footprint units currently occupying each directed road. */
  occupancy: Map<RoadId, number>;
  /** Signal mechanics per signal-controlled intersection (Task 06). */
  signals: Map<IntersectionId, SignalState>;
  /**
   * Authoritative per-road flow state (speed factor / severity). Vehicle
   * speed, congestion colours, route colours and traffic-aware routing all
   * read THIS, so physics and pixels cannot disagree.
   */
  roadTraffic: RoadTraffic;
}

export function createTrafficState(): TrafficState {
  return {
    timeMs: 0,
    vehicles: [],
    occupancy: new Map(),
    signals: new Map(),
    roadTraffic: createRoadTraffic(),
  };
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
 *   final stretch of every road stays clear for the vehicles already on it;
 * - empty-road exception: the ratio must never make a road with finite
 *   capacity unusable (a car footprint exceeds the 0.9 headroom of a
 *   capacity-1 road). An EMPTY road may accept its first vehicle whenever
 *   absolute capacity permits; once occupied, projected spillback applies
 *   normally. Pure function of state — no hysteresis, no separate queue.
 */
function hasCapacity(state: TrafficState, road: Road, footprint: number): boolean {
  const current = roadOccupancy(state, road.id);
  const projected = current + footprint;
  if (projected > road.capacity + SIMULATION_EPSILON) {
    return false;
  }
  if (current <= SIMULATION_EPSILON) {
    return true;
  }
  return projected <= road.capacity * SPILLBACK_ADMISSION_RATIO + SIMULATION_EPSILON;
}

function enterRoad(state: TrafficState, vehicle: Vehicle, road: Road): void {
  // Read BEFORE the road is assigned: after that there is no way to tell a
  // first entry (an abstract origin) from a junction transfer.
  const enteringFromOrigin = vehicle.roadId === null;
  addOccupancy(state, road.id, vehicleFootprint(vehicle.type));
  vehicle.roadId = road.id;
  vehicle.progress = 0;
  // An abstract ORIGIN injects a vehicle already travelling at the road's
  // speed (Task 05: origins are not junctions). A vehicle TRANSFERRING into
  // this road keeps its momentum, capped by the new road's limit — it never
  // gains speed by crossing a junction. From here the per-tick longitudinal
  // model owns the speed: congestion slows it, a blocked control brakes it.
  const freeFlow = effectiveSpeed(road, vehicle.type);
  vehicle.speed = enteringFromOrigin ? freeFlow : Math.min(vehicle.speed, freeFlow);
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
  onApproachArrival?: (roadId: RoadId) => void,
): void {
  // ---- Longitudinal model ------------------------------------------------
  // Target speed for THIS tick, approached with bounded acceleration:
  //
  //   target = road free-flow speed x vehicle multiplier x road speedFactor
  //
  // and, when the next control or road will not admit this vehicle, capped by
  // what the brakes can achieve over the distance that is left — so a vehicle
  // brakes to ~0 AT the physical stop line and holds there, instead of running
  // to the end at full speed and stopping dead. Release is the same model in
  // reverse: target returns to the traffic speed and the vehicle accelerates.
  const startRoadId = vehicle.roadId;
  const startRoad = startRoadId === null ? undefined : city.roads[startRoadId];
  if (startRoad && startRoadId !== null) {
    const trafficSpeed =
      effectiveSpeed(startRoad, vehicle.type) * roadSpeedFactor(state.roadTraffic, startRoadId);
    const nextRoadId = vehicle.route[vehicle.routeIndex + 1];
    let blockedAhead = false;
    if (nextRoadId !== undefined) {
      const next = city.roads[nextRoadId];
      blockedAhead =
        !next ||
        next.closed ||
        !hasCapacity(state, next, vehicleFootprint(vehicle.type)) ||
        evaluateIntersectionControl(
          city,
          state,
          startRoadId,
          nextRoadId,
          vehicle.queuedSinceMs,
          context,
        ) !== "granted";
    }
    const target = blockedAhead
      ? Math.min(trafficSpeed, brakingLimitSpeed(Math.max(0, startRoad.length - vehicle.progress)))
      : trafficSpeed;
    vehicle.speed = approachSpeed(vehicle.speed, target, dtSeconds);
  }

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
    // Reaching a road end with a continuing route is ONE approach arrival —
    // recorded whether the vehicle proceeds now or has to queue. (Leftover
    // distance may legitimately cross several road ends in one timestep; each
    // reach reports.) Queued retries go through attemptTransfer and never
    // report again.
    onApproachArrival?.(roadId);
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
    rerouteCount: 0,
  };
  state.vehicles.push(vehicle);
  if (vehicle.state === "pending") {
    attemptFirstEntry(city, state, vehicle);
  }
  return vehicle;
}

/**
 * Optional per-tick inputs from the engine. `signalDirectives` carries the
 * controller's hold/advance decisions for this tick; a missing entry means
 * "no opinion". `onApproachArrival` is the Task-09 arrival-event collector:
 * called once with the current road id each time a MOVING vehicle reaches
 * the end of that road while its route continues — whether it proceeds
 * immediately or has to queue. Queued retries and final trip arrivals never
 * call it (see sim/observations.ts for the full event contract).
 */
export interface TrafficStepOptions {
  readonly signalDirectives?: ReadonlyMap<IntersectionId, SignalDirective>;
  readonly onApproachArrival?: (roadId: RoadId) => void;
}

export function stepTraffic(
  city: City,
  state: TrafficState,
  dtMs: number = SIMULATION_TIMESTEP_MS,
  options: TrafficStepOptions = {},
): void {
  // Road flow state first: this tick's movement, and the snapshot that
  // follows it, both read the state produced here.
  stepRoadTraffic(state, city, dtMs);
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
      advance(city, state, vehicle, dtSeconds, context, options.onApproachArrival);
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
