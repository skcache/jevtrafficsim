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
 * Below that hard ceiling the spillback rule keeps a fraction of every road
 * free (SPILLBACK_ADMISSION_RATIO), and a vehicle that has been blocked at one
 * road end for SPILLBACK_RELEASE_MS of simulated time may use that reserved
 * fraction — the gridlock valve. It exists because the reservation, on its
 * own, is an absorbing state for a ring of saturated roads (`hasCapacity`).
 * It never crosses absolute capacity, so occupancy stays <= capacity and every
 * capacity invariant still holds.
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
  SPILLBACK_RELEASE_MS,
} from "./config";
import { currentQueueWaitMs } from "./approach-stats";
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
  /** Dense vehicle list: vehicles[i].id === i. Canonical, append-only history. */
  vehicles: Vehicle[];
  /**
   * The vehicles that are NOT arrived, in spawn order (Issue #40).
   *
   * `vehicles` is history: it keeps every vehicle that ever spawned, because
   * arrival records, metrics and result fields are defined over that population.
   * Hot per-step work must scale with LIVE traffic instead, so the same objects
   * are indexed here and removed on arrival. Iteration order is insertion order
   * — the order of `vehicles` — so every consumer that used to scan the history
   * and skip arrived vehicles sees exactly the same sequence as before.
   */
  activeVehicles: Set<Vehicle>;
  /**
   * Vehicles that arrived since the engine last drained this queue, in the order
   * they arrived. Exists so arrival accounting can be O(new arrivals) instead of
   * a full-history sweep; the engine sorts by id before recording, which keeps
   * the canonical arrival order (spawn order) identical.
   */
  arrivedQueue: Vehicle[];
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
    activeVehicles: new Set(),
    arrivedQueue: [],
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
 *   is never released into a full edge. This is the hard ceiling and the
 *   gridlock valve below can never cross it;
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
 * - gridlock release (SPILLBACK_RELEASE_MS): a vehicle that has stood still at
 *   this road end for long enough that no control could still be serving it
 *   (`waitedMs`) may use that reserved headroom, absolute capacity permitting.
 *   Without this the reservation is an absorbing state — a ring of roads each
 *   on the threshold refuses every entrant and no member's occupancy can ever
 *   fall, so the jam, and any vehicle queued behind it, is stuck forever. The
 *   valve does not weaken the reservation while a road is draining: it needs
 *   the vehicle to have stood at the same road end for 90 simulated seconds,
 *   longer than any legal signal cycle can hold it. Still a pure function of
 *   (state, wait) — measured scope in sim/config.ts.
 */
function hasCapacity(
  state: TrafficState,
  road: Road,
  footprint: number,
  waitedMs = 0,
): boolean {
  const current = roadOccupancy(state, road.id);
  const projected = current + footprint;
  if (projected > road.capacity + SIMULATION_EPSILON) {
    return false;
  }
  if (current <= SIMULATION_EPSILON) {
    return true;
  }
  if (projected <= road.capacity * SPILLBACK_ADMISSION_RATIO + SIMULATION_EPSILON) {
    return true;
  }
  return waitedMs >= SPILLBACK_RELEASE_MS;
}

/**
 * Continuous time (ms) a vehicle has been blocked at its CURRENT road end —
 * the gridlock valve's clock, and the same quantity the starvation watch calls
 * "approach wait" (see sim/approach-stats.ts: one definition, every consumer).
 * A queued vehicle reads its `queuedSinceMs`; a pending vehicle has never been
 * anywhere else, so its whole wait has accrued at this first road.
 */
export function continuousBlockedWaitMs(state: TrafficState, vehicle: Vehicle): number {
  if (vehicle.state === "queued") {
    return currentQueueWaitMs(state.timeMs, vehicle.queuedSinceMs);
  }
  if (vehicle.state === "pending") {
    return vehicle.waitTimeMs;
  }
  return 0;
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
  if (!hasCapacity(state, road, vehicleFootprint(vehicle.type), continuousBlockedWaitMs(state, vehicle))) {
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
  if (
    !hasCapacity(
      state,
      next,
      vehicleFootprint(vehicle.type),
      continuousBlockedWaitMs(state, vehicle),
    )
  ) {
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
  // Out of the live index, into the arrival queue: the vehicle keeps its place
  // in `vehicles` (history) but stops costing every step that follows.
  state.activeVehicles.delete(vehicle);
  state.arrivedQueue.push(vehicle);
}

/**
 * By-id lookup in O(1). Vehicle ids are allocated as `vehicles.length`, so the
 * canonical array is its own index — no search needed anywhere in the codebase.
 */
export function vehicleById(state: TrafficState, id: VehicleId | null): Vehicle | null {
  if (id === null) {
    return null;
  }
  const vehicle = state.vehicles[id];
  return vehicle !== undefined && vehicle.id === id ? vehicle : null;
}

/** Number of vehicles that have not arrived. O(1). */
export function activeVehicleCount(state: TrafficState): number {
  return state.activeVehicles.size;
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
      // This look-ahead decides BRAKING, so it deliberately never uses the
      // gridlock valve: a vehicle still rolling has not proven the receiver is
      // stuck, and it should brake to the road end the way it always has. The
      // valve belongs to vehicles that are actually standing still (the queue
      // and pending phases), which is where a long continuous wait exists.
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
  // A route-less vehicle is born arrived: it belongs to history and the arrival
  // queue, never to the live index.
  if (vehicle.state === "arrived") {
    state.arrivedQueue.push(vehicle);
  } else {
    state.activeVehicles.add(vehicle);
  }
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

  // The live index must be exactly the non-arrived population, in spawn order.
  const expectedActive = state.vehicles.filter((vehicle) => vehicle.state !== "arrived");
  const activeList = [...state.activeVehicles];
  if (activeList.length !== expectedActive.length) {
    problems.push(
      `activeVehicles has ${activeList.length} entries, expected ${expectedActive.length}`,
    );
  } else {
    for (let index = 0; index < activeList.length; index += 1) {
      if (activeList[index] !== expectedActive[index]) {
        problems.push(
          `activeVehicles[${index}] is vehicle ${activeList[index].id}, ` +
            `expected ${expectedActive[index].id}`,
        );
        break;
      }
    }
  }

  return problems;
}
