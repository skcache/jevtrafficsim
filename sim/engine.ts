/**
 * Headless simulation runtime (Task 07): one deterministic fixed-timestep
 * engine that ties city, routing, traffic, signals, a controller and metrics
 * into a single loop. No DOM, no React, no timers — the caller owns time and
 * drives `stepEngine`/`runEngine` explicitly.
 *
 * ## Tick order (per 100 ms step, at simulation time T)
 *
 *   0. incidents  — expire recovered incidents, activate incidents due at T,
 *                   recompose effective runtime road conditions (base + all
 *                   active incidents), then process closure-triggered
 *                   reroutes; retry-due reroute attempts follow
 *   1. spawns     — every scheduled event with timeMs <= T that has not
 *                   spawned yet enters the network (base schedule and
 *                   incident injections share one deterministic queue), route
 *                   via A* with the live occupancy map, then spawnVehicle, so
 *                   a t=0 vehicle participates in the very first tick and a
 *                   road closing at T is already avoided by a T spawn
 *   2. controller — the engine builds the observation frame + static
 *                   partition into a read-only context and calls
 *                   controller.directives(city, traffic, context) on the
 *                   resulting current state (policy for this tick)
 *   3. traffic    — stepTraffic: clock -> signals (with directives) ->
 *                   trip -> pending -> queue -> movement -> wait
 *   4. arrivals   — vehicles that reached their destination this tick are
 *                   recorded once (trip time, wait time, route distance)
 *   5. metrics    — congestion/occupancy/signal sampling at tick end, with
 *                   the explicit step duration
 *
 * ## Runtime city isolation (Task 10)
 *
 * The engine owns `city`, a deep-enough runtime copy of the caller's city
 * (`baseCity`); incidents mutate ONLY that copy. Every subsystem — routing,
 * traffic admission, observations, controllers, metrics, invariants — reads
 * the same runtime city, so no subsystem can believe a road is open while
 * another believes it is closed. Condition recovery recomposes from the base
 * city + all still-active incidents; expiry is never a naive restore.
 *
 * ## Deterministic incidents
 *
 * `options.incidents` is optional: engines without it behave exactly as
 * before (zero incident overhead). Incident randomness comes from the
 * dedicated `fork("incidents")` root with one child stream per script entry
 * (`<sequence>:<kind>`), never from demand or city streams. The spawn queue
 * is ordered by (timeMs, sequence): base events keep their original order
 * (sequences 0..n-1), injections use a high monotonic counter, so a base
 * event always precedes its incident copies at the same time.
 *
 * ## Determinism
 *
 * Same city + controller + spawn schedule + incident config => identical
 * state, metrics and snapshots for the same tick sequence. No randomness and
 * no wall-clock reads exist anywhere in this loop.
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
 * detour. No route caching exists; rerouting happens only when an active
 * incident closure invalidates a vehicle's remaining route (Task 10), never
 * for congestion alone.
 *
 * ## Determinism
 *
 * Same city + controller + spawn schedule => identical state, metrics and
 * snapshots for the same tick sequence. No randomness and no wall-clock reads
 * exist anywhere in this loop.
 */
import { createApproachStats, updateApproachStats, type ApproachStats } from "./approach-stats";
import { findRoute } from "./astar";
import { roadSpeedFactor } from "./road-traffic";
import {
  createDriverState,
  decideReplan,
  LOCAL_REPLAN,
  remainingRouteSeconds,
  type DriverState,
  type DriverStrategy,
} from "./driver";
import { SIMULATION_TIMESTEP_MS, VEHICLE_TYPE_SPECS } from "./config";
import {
  buildObservationFrame,
  createApproachArrivalTracker,
  expireApproachArrivals,
  recordApproachArrival,
  type ApproachArrivalTracker,
} from "./observations";
import { buildCityPartition, type CityPartition } from "./regions";
import {
  applyRuntimeConditions,
  amplifyTrafficBurst,
  createIncidentRuntime,
  createRuntimeCity,
  defaultDurationMs,
  incidentStreamFor,
  INCIDENT_DEFAULTS,
  physicalSegments,
  planEventRelease,
  reachableIntersectionCount,
  selectBridgeSegment,
  selectCloseRoadSegment,
  selectCrashTarget,
  validateIncidentScript,
  type IncidentConfig,
  type IncidentRecord,
  type IncidentRuntime,
  type IncidentScriptEntry,
  type PhysicalSegment,
} from "./incidents";
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
  vehicleById,
} from "./traffic";
import type { TrafficController, TrafficControllerContext } from "@/controllers/contract";
import type {
  City,
  IntersectionId,
  RoadId,
  VehicleId,
  VehicleState,
  VehicleType,
} from "./types";

export interface ScheduledSpawn {
  readonly timeMs: number;
  readonly type: VehicleType;
  readonly origin: IntersectionId;
  readonly destination: IntersectionId;
  /**
   * Presentation identity only. `ego` marks the ONE vehicle that crosses into
   * the live frame; it has ZERO effect on movement, routing, capacity, signals
   * or queueing — the engine treats it exactly like any other spawn.
   */
  readonly role?: "ego";
}

export interface EngineOptions {
  readonly city: City;
  readonly controller: TrafficController;
  readonly spawns: readonly ScheduledSpawn[];
  /** Optional deterministic incident configuration (Task 10). */
  readonly incidents?: IncidentConfig;
  /**
   * How the EGO car plans (Issue #28). Defaults to "tourist", which is exactly
   * the behaviour every vehicle already had: plan once, reroute only when the
   * remaining path becomes invalid. Background vehicles are never affected.
   */
  readonly driver?: DriverStrategy;
}

/** One entry of the dynamic spawn queue (base events and injections). */
interface SpawnQueueEntry {
  readonly timeMs: number;
  readonly sequence: number;
  readonly type: VehicleType;
  readonly origin: IntersectionId;
  readonly destination: IntersectionId;
  readonly role?: "ego";
}

/** Reroute bookkeeping per affected vehicle (never controller-owned). */
interface RerouteBookkeeping {
  lastAttemptMs: number;
  failed: boolean;
  /** Set by an incident expiry: retry immediately, cooldown notwithstanding. */
  retryNow: boolean;
}

export interface EngineState {
  /**
   * RUNTIME city owned by this engine: a copy of the caller's city whose
   * roads carry the effective incident conditions. Never the caller's object.
   */
  readonly city: City;
  /** The caller's original city; kept immutable as incident-recovery source. */
  readonly baseCity: City;
  /** Active policy; switchable via setEngineController (no engine rebuild). */
  controller: TrafficController;
  readonly traffic: TrafficState;
  /** Base schedule, explicitly sorted by (timeMs, original order). */
  readonly spawns: readonly ScheduledSpawn[];
  /** Dynamic queue: base events + incident injections, (timeMs, sequence). */
  spawnQueue: SpawnQueueEntry[];
  readonly metrics: MetricsAccumulator;
  /** Per-approach queue + starvation statistics (Task 08 policy input). */
  readonly approaches: ApproachStats;
  /** Rolling approach-arrival history (Task 09), window = 5 simulated seconds. */
  readonly arrivals: ApproachArrivalTracker;
  /** Static region/corridor partition (Task 09), built once per engine. */
  readonly partition: CityPartition;
  /** Incident runtime state (records + injection counter), Task 10. */
  readonly incidents: IncidentRuntime;
  /**
   * Incident configuration (per-record streams + entry lookup). Always
   * present: engines without scripted incidents get an empty config with
   * seed 0, so runtime injection via `queueIncident` works everywhere.
   */
  readonly incidentConfig: IncidentConfig;
  /** Reroute bookkeeping per vehicle id (Task 10). */
  readonly reroutes: Map<number, RerouteBookkeeping>;
  /** Aggregate reroute counters (exposed in snapshots for replay checks). */
  readonly rerouteStats: { attempted: number; succeeded: number; failed: number };
  nextSpawnIndex: number;
  ticks: number;
  /**
   * The vehicle id the ego spawn actually produced, or null before it spawns
   * (and if its route never materialises). Recorded when the vehicle is
   * created, so nothing has to assume "vehicle 0 is the ego forever".
   */
  egoVehicleId: VehicleId | null;
  /** Driver strategy of the ego car; never part of controller input. */
  driver: DriverStrategy;
  driverState: DriverState;
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

/** First sequence for incident injections: always after base events. */
const INJECTION_SEQUENCE_BASE = 1_000_000;

export function createEngine(options: EngineOptions): EngineState {
  for (const spawn of options.spawns) {
    validateSpawn(options.city, spawn);
  }
  if (options.incidents) {
    const problems = validateIncidentScript(options.city, options.incidents.script);
    if (problems.length > 0) {
      throw new RangeError(`invalid incident script: ${problems[0]}`);
    }
  }
  const spawns = options.spawns
    .map((spawn, sequence) => ({ spawn, sequence }))
    .sort((a, b) => a.spawn.timeMs - b.spawn.timeMs || a.sequence - b.sequence)
    .map(({ spawn }) => spawn);
  const egoSpawns = spawns.filter((spawn) => spawn.role === "ego");
  if (egoSpawns.length > 1) {
    throw new RangeError(`at most one ego spawn is allowed, received ${egoSpawns.length}`);
  }
  const spawnQueue: SpawnQueueEntry[] = spawns.map((spawn, sequence) => ({
    timeMs: spawn.timeMs,
    sequence,
    type: spawn.type,
    origin: spawn.origin,
    destination: spawn.destination,
    role: spawn.role,
  }));
  const incidentConfig: IncidentConfig = options.incidents ?? { seed: 0, script: [] };
  return {
    city: createRuntimeCity(options.city),
    baseCity: options.city,
    controller: options.controller,
    traffic: createTrafficState(),
    spawns,
    spawnQueue,
    metrics: createMetricsAccumulator(),
    approaches: createApproachStats(),
    arrivals: createApproachArrivalTracker(),
    partition: buildCityPartition(options.city),
    incidents: {
      ...createIncidentRuntime(options.city, incidentConfig),
      injectionSequence: INJECTION_SEQUENCE_BASE,
    },
    incidentConfig,
    reroutes: new Map(),
    rerouteStats: { attempted: 0, succeeded: 0, failed: 0 },
    nextSpawnIndex: 0,
    ticks: 0,
    egoVehicleId: null,
    driver: options.driver ?? "tourist",
    driverState: createDriverState(),
  };
}

function recordArrivals(engine: EngineState): void {
  const { city, traffic, metrics } = engine;
  // Only vehicles that arrived since the last tick can be new arrivals, so the
  // sweep is over new arrivals instead of all of history. Sorted by id, which is
  // spawn order: the canonical arrival ORDER is unchanged. The id guard stays,
  // because an arrival is recorded exactly once.
  const arrivals = traffic.arrivedQueue.filter((vehicle) => !metrics.recordedArrivalIds.has(vehicle.id));
  traffic.arrivedQueue.length = 0;
  arrivals.sort((a, b) => a.id - b.id);
  for (const vehicle of arrivals) {
    if (metrics.recordedArrivalIds.has(vehicle.id)) {
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
    engine.nextSpawnIndex < engine.spawnQueue.length &&
    engine.spawnQueue[engine.nextSpawnIndex].timeMs <= traffic.timeMs
  ) {
    const spawn = engine.spawnQueue[engine.nextSpawnIndex];
    engine.nextSpawnIndex += 1;
    const route = findRoute(city, spawn.origin, spawn.destination, {
      speedFactor: (roadId) => roadSpeedFactor(traffic.roadTraffic, roadId),
    });
    if (!route.found) {
      engine.metrics.failedSpawns += 1;
      continue;
    }
    const vehicleId = traffic.vehicles.length;
    spawnVehicle(city, traffic, {
      id: vehicleId,
      type: spawn.type,
      origin: spawn.origin,
      destination: spawn.destination,
      route: route.roadIds,
    });
    if (spawn.role === "ego") {
      engine.egoVehicleId = vehicleId;
    }
  }
}

/**
 * The local driver's periodic look at alternatives (Issue #28).
 *
 * Tourist never gets here. For local: at most one look per interval, never
 * inside the cooldown that follows a switch, and only when the candidate route
 * is MATERIALLY better than what the ego is already driving — the candidate
 * comes from the same congestion-aware A* everyone else uses, so the driver
 * cannot invent a shortcut the network does not have.
 *
 * The route is replaced from the ego's CURRENT road onward, which keeps its
 * position and progress untouched: this is a plan change, not a teleport.
 */
function maybeReplanEgo(engine: EngineState): void {
  if (engine.driver !== "local" || engine.egoVehicleId === null) {
    return;
  }
  const ego = vehicleById(engine.traffic, engine.egoVehicleId);
  if (!ego || ego.state === "arrived" || ego.state === "pending" || ego.roadId === null) {
    return;
  }
  const nowMs = engine.traffic.timeMs;
  if (nowMs - engine.driverState.lastCheckMs < LOCAL_REPLAN.intervalMs) {
    return;
  }
  // The check is recorded AFTER the decision: decideReplan applies the same
  // interval gate, so stamping it first would make every look "not due".
  const road = engine.city.roads[ego.roadId];
  if (!road) {
    return;
  }
  const candidate = findRoute(engine.city, road.to, ego.destination, {
    speedFactor: (roadId) => roadSpeedFactor(engine.traffic.roadTraffic, roadId),
  });
  if (!candidate.found) {
    return;
  }
  const candidateRoute = [ego.roadId, ...candidate.roadIds];
  const currentSeconds = remainingRouteSeconds(
    engine.city,
    engine.traffic,
    ego.route,
    ego.routeIndex,
    ego.progress,
  );
  const candidateSeconds = remainingRouteSeconds(
    engine.city,
    engine.traffic,
    candidateRoute,
    0,
    ego.progress,
  );
  const decision = decideReplan(engine.driver, engine.driverState, nowMs, currentSeconds, candidateSeconds);
  engine.driverState.lastCheckMs = nowMs;
  if (!decision.replan) {
    return;
  }
  ego.route = candidateRoute;
  ego.routeIndex = 0;
  ego.rerouteCount += 1;
  engine.driverState.lastSwitchMs = nowMs;
  engine.driverState.switches += 1;
}

/**
 * Merges injected spawn events into the not-yet-processed part of the queue.
 * The processed prefix keeps its index; every entry is ordered by (timeMs,
 * sequence), with injection sequences above all base sequences, so a base
 * event always precedes incident copies at the same simulated time.
 */
/**
 * Merge extra demand into the live schedule. Deterministic: entries are
 * sequence-numbered in call order and stable-sorted into the remaining queue,
 * so the same injection at the same simulated time always produces the same
 * world. Existing spawns are never reordered or removed.
 */
/**
 * Merge extra demand into the live schedule. Deterministic: entries are
 * sequence-numbered in call order and stable-sorted into the remaining queue,
 * so the same injection at the same simulated time always produces the same
 * world. Existing spawns are never reordered or removed.
 */
export function injectSpawns(
  engine: EngineState,
  spawns: ReadonlyArray<{
    timeMs: number;
    type: VehicleType;
    origin: IntersectionId;
    destination: IntersectionId;
  }>,
): void {
  if (spawns.length === 0) {
    return;
  }
  const entries: SpawnQueueEntry[] = spawns.map((spawn) => ({
    ...spawn,
    sequence: engine.incidents.injectionSequence++,
  }));
  const remaining = engine.spawnQueue.slice(engine.nextSpawnIndex);
  const merged = [...remaining, ...entries].sort(
    (a, b) => a.timeMs - b.timeMs || a.sequence - b.sequence,
  );
  engine.spawnQueue = [...engine.spawnQueue.slice(0, engine.nextSpawnIndex), ...merged];
}

/** True while any active incident is a crash (per-tick capacity clamp needed). */
function hasActiveCrash(engine: EngineState): boolean {
  return engine.incidents.records.some(
    (record) => record.status === "active" && record.kind === "crash",
  );
}

/**
 * Recomposes effective runtime road conditions from base + all active
 * incidents. Runs on every transition and, while crashes are active, every
 * tick — a crash capacity tightens as resident traffic drains because the
 * effective value is `max(desired, occupancy)`.
 */
function recomputeRoadConditions(engine: EngineState): void {
  if (!engine.incidents.conditionsDirty && !hasActiveCrash(engine)) {
    return;
  }
  const active = engine.incidents.records.filter((record) => record.status === "active");
  applyRuntimeConditions(engine.city, engine.baseCity, active, engine.traffic.occupancy);
  engine.incidents.conditionsDirty = false;
}

/** The physical segment containing a road id (reverse resolved structurally). */
function segmentOfRoad(city: City, roadId: RoadId): PhysicalSegment | null {
  return physicalSegments(city).find((segment) => segment.roadIds.includes(roadId)) ?? null;
}

/**
 * Activates one pending record whose scheduled time has been reached.
 * Resolutions use the record's private stream; a raw `IncidentScriptEntry`
 * lookup by original sequence supplies explicit targets and durations.
 */
function activateIncident(
  engine: EngineState,
  record: IncidentRecord,
): "active" | "active-closure" | "not-applicable" {
  const config = engine.incidentConfig;
  const entry = config.script[record.id];
  const T = engine.traffic.timeMs;
  const rng = incidentStreamFor(config, record);
  const durationMs = entry.durationMs ?? defaultDurationMs(record.kind) ?? 0;
  record.activatedAtMs = T;
  record.expiresAtMs = T + durationMs;
  const city = engine.city;

  switch (record.kind) {
    case "traffic-burst": {
      const copies = amplifyTrafficBurst(engine.spawns, T, durationMs);
      injectSpawns(engine, copies);
      record.injectedSpawnCount = copies.length;
      record.status = "active";
      return "active";
    }
    case "event-release": {
      const plan = planEventRelease(city, city.size, rng, T, entry.centerIntersectionId);
      if (!plan) {
        record.status = "not-applicable";
        return "not-applicable";
      }
      injectSpawns(engine, plan.spawns);
      record.eventCenterIntersectionId = plan.centerIntersectionId;
      record.injectedSpawnCount = plan.spawns.length;
      record.status = "active";
      return "active";
    }
    case "crash": {
      const target = selectCrashTarget(city, rng, entry.targetRoadId);
      if (target === null) {
        record.status = "not-applicable";
        return "not-applicable";
      }
      (record.roadIds as RoadId[]).push(target);
      record.status = "active";
      engine.incidents.conditionsDirty = true;
      return "active";
    }
    case "close-road":
    case "bridge-closed": {
      const allowedToDisconnect = record.allowDisconnect;
      const segment =
        entry.targetRoadId !== undefined
          ? segmentOfRoad(city, entry.targetRoadId)
          : record.kind === "bridge-closed"
            ? selectBridgeSegment(city, rng, allowedToDisconnect)
            : selectCloseRoadSegment(city, rng);
      if (!segment) {
        record.status = "not-applicable";
        return "not-applicable";
      }
      if (entry.targetRoadId !== undefined && !allowedToDisconnect) {
        const baseline = reachableIntersectionCount(city);
        const after = reachableIntersectionCount(city, new Set(segment.roadIds));
        if (after !== baseline) {
          record.status = "not-applicable"; // explicit target would disconnect
          return "not-applicable";
        }
      }
      (record.roadIds as RoadId[]).push(...segment.roadIds);
      record.status = "active";
      engine.incidents.conditionsDirty = true;
      return "active-closure";
    }
  }
}

/**
 * Steps 1-4 of the incident phase: expire recovered incidents (reopening the
 * network for this tick's routing), recompose conditions, activate incidents
 * due at T, recompose again, then force immediate reroutes for vehicles whose
 * untraveled route contains a road closed by this tick's activations.
 */
function applyIncidents(engine: EngineState): void {
  const runtime = engine.incidents;
  if (runtime.records.length === 0) {
    return;
  }
  const T = engine.traffic.timeMs;

  let recovered = false;
  for (const record of runtime.records) {
    if (record.status === "active" && record.expiresAtMs !== null && record.expiresAtMs <= T) {
      record.status = "expired";
      recovered = true;
    }
  }
  if (recovered) {
    engine.incidents.conditionsDirty = true;
    for (const book of engine.reroutes.values()) {
      if (book.failed) {
        book.retryNow = true; // topology recovery: retry immediately
      }
    }
  }
  recomputeRoadConditions(engine);

  const newlyClosedByRecord: Array<{ record: IncidentRecord; roads: Set<RoadId> }> = [];
  for (const record of runtime.records) {
    if (record.scheduledAtMs > T) {
      break; // records are ordered by (atMs, sequence)
    }
    if (record.status !== "pending") {
      continue;
    }
    if (activateIncident(engine, record) === "active-closure") {
      newlyClosedByRecord.push({ record, roads: new Set(record.roadIds) });
    }
  }
  recomputeRoadConditions(engine);

  for (const { record, roads } of newlyClosedByRecord) {
    for (const vehicle of engine.traffic.activeVehicles) {
      const remaining =
        vehicle.roadId === null ? vehicle.route : vehicle.route.slice(vehicle.routeIndex + 1);
      if (!remaining.some((roadId) => roads.has(roadId))) {
        continue;
      }
      record.affectedVehicleCount += 1;
      if (attemptReroute(engine, vehicle.id, true)) {
        record.successfulReroutes += 1;
      } else {
        record.failedReroutes += 1;
      }
    }
  }
}
/** Switches the active controller in place: no engine rebuild, no state loss. */
export function setEngineController(engine: EngineState, controller: TrafficController): void {
  engine.controller = controller;
}

/**
 * Runtime incident injection seam (Task 11): schedules ONE interactive entry
 * into the existing Task-10 incident lifecycle. Validated with the same script
 * validator, assigned the next deterministic sequence id, spliced into the
 * record list preserving (scheduledAtMs, sequence) order, and resolved later
 * through the engine's existing incident stream / activation / expiry /
 * targeting / rerouting machinery — no incident logic lives outside
 * sim/incidents.ts + this phase.
 *
 * `atMs` defaults to the current simulation time, i.e. "schedule this now":
 * the entry activates on the next incident phase (start of the next tick).
 * Returns the new incident id.
 */
export function queueIncident(
  engine: EngineState,
  entry: Omit<IncidentScriptEntry, "atMs"> & { atMs?: number },
): number {
  const atMs = entry.atMs ?? engine.traffic.timeMs;
  const full: IncidentScriptEntry = { ...entry, atMs };
  const problems = validateIncidentScript(engine.city, [full]);
  if (problems.length > 0) {
    throw new RangeError(`invalid incident entry: ${problems[0]}`);
  }
  const runtime = engine.incidents;
  const id = runtime.nextIncidentId;
  runtime.nextIncidentId += 1;
  engine.incidentConfig.script.push(full); // invariant: script[id] === entry
  const record: IncidentRecord = {
    id,
    kind: full.kind,
    scheduledAtMs: atMs,
    activatedAtMs: null,
    expiresAtMs: null,
    status: "pending",
    roadIds: [],
    eventCenterIntersectionId: null,
    allowDisconnect: full.allowDisconnect ?? false,
    injectedSpawnCount: 0,
    affectedVehicleCount: 0,
    successfulReroutes: 0,
    failedReroutes: 0,
  };
  const index = runtime.records.findIndex(
    (existing) =>
      existing.scheduledAtMs > atMs ||
      (existing.scheduledAtMs === atMs && existing.id > id),
  );
  if (index === -1) {
    runtime.records.push(record);
  } else {
    runtime.records.splice(index, 0, record);
  }
  return id;
}

/**
 * Attempts one reroute for a vehicle. Origin semantics:
 * - pending (never entered): reroute from its origin, replacing the whole route;
 * - moving/queued: it stays on its current road — the traveled prefix through
 *   that road is preserved, the invalid suffix is discarded, and the new tail
 *   comes from A* over the CURRENT runtime city with live occupancy.
 * The vehicle's current road closing is not a reroute reason (Task 05: it may
 * finish that road) — callers only pass vehicles whose UNTRAVELED suffix is
 * affected. Failures never throw and never fabricate a path: the vehicle
 * keeps its physical state and is marked for a later cooldown-respecting retry.
 */
function attemptReroute(engine: EngineState, vehicleId: number, force: boolean): boolean {
  const vehicle = engine.traffic.vehicles[vehicleId];
  if (!vehicle || vehicle.state === "arrived") {
    engine.reroutes.delete(vehicleId);
    return false;
  }
  const T = engine.traffic.timeMs;
  const book: RerouteBookkeeping =
    engine.reroutes.get(vehicleId) ?? { lastAttemptMs: -Infinity, failed: false, retryNow: false };
  if (
    !force &&
    book.failed &&
    !book.retryNow &&
    T - book.lastAttemptMs < INCIDENT_DEFAULTS.REROUTE_COOLDOWN_MS
  ) {
    return false; // cooldown: no A* until it elapses
  }

  const keepPrefix = vehicle.roadId !== null;
  const from = keepPrefix ? engine.city.roads[vehicle.roadId as RoadId].to : vehicle.origin;
  book.lastAttemptMs = T;
  book.retryNow = false;
  engine.rerouteStats.attempted += 1;

  if (from === vehicle.destination) {
    // The remaining leg is empty: nothing to replace.
    book.failed = false;
    engine.reroutes.set(vehicleId, book);
    engine.rerouteStats.succeeded += 1;
    return true;
  }
  const route = findRoute(engine.city, from, vehicle.destination, {
    speedFactor: (roadId) => roadSpeedFactor(engine.traffic.roadTraffic, roadId),
  });
  if (!route.found) {
    book.failed = true;
    engine.reroutes.set(vehicleId, book);
    engine.rerouteStats.failed += 1;
    return false;
  }
  vehicle.route = keepPrefix
    ? [...vehicle.route.slice(0, vehicle.routeIndex + 1), ...route.roadIds]
    : [...route.roadIds];
  if (!keepPrefix) {
    vehicle.routeIndex = 0;
  }
  vehicle.rerouteCount += 1;
  book.failed = false;
  engine.reroutes.set(vehicleId, book);
  engine.rerouteStats.succeeded += 1;
  return true;
}

/**
 * Retries vehicles whose last attempt failed, once the cooldown has elapsed
 * (or immediately after a topology recovery). Iterates only the bookkeeping
 * map — never the whole fleet.
 */
function processRerouteRetries(engine: EngineState): void {
  if (engine.reroutes.size === 0) {
    return;
  }
  const T = engine.traffic.timeMs;
  const due: number[] = [];
  for (const [vehicleId, book] of engine.reroutes) {
    if (!book.failed) {
      continue;
    }
    if (book.retryNow || T - book.lastAttemptMs >= INCIDENT_DEFAULTS.REROUTE_COOLDOWN_MS) {
      due.push(vehicleId);
    }
  }
  due.sort((a, b) => a - b);
  for (const vehicleId of due) {
    attemptReroute(engine, vehicleId, true);
  }
}

/**
 * Advances the simulation by exactly one fixed timestep: incidents first (a
 * road closing at T is already avoided by a T spawn; an expired closure is
 * already reopened for T routing), then due spawns, then the tick runs.
 */
export function stepEngine(engine: EngineState): void {
  const { city, traffic, controller } = engine;
  applyIncidents(engine);
  processRerouteRetries(engine);
  spawnDueVehicles(engine);
  maybeReplanEgo(engine);
  // Controller context: derived from the CURRENT state (after spawns, before
  // this tick's movement) so identical inputs always yield identical policy.
  expireApproachArrivals(engine.arrivals, traffic.timeMs);
  const context: TrafficControllerContext = {
    observations: buildObservationFrame(city, traffic, engine.arrivals),
    partition: engine.partition,
  };
  const directives = controller.directives(city, traffic, context);
  stepTraffic(city, traffic, SIMULATION_TIMESTEP_MS, {
    signalDirectives: directives,
    onApproachArrival: (roadId) => recordApproachArrival(engine.arrivals, traffic.timeMs, roadId),
  });
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

/** JSON-safe incident record for snapshots (never functions or Maps). */
export interface IncidentSnapshotRecord {
  readonly id: number;
  readonly kind: string;
  readonly scheduledAtMs: number;
  readonly activatedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly status: string;
  readonly roadIds: RoadId[];
  readonly eventCenterIntersectionId: IntersectionId | null;
  readonly injectedSpawnCount: number;
  readonly affectedVehicleCount: number;
  readonly successfulReroutes: number;
  readonly failedReroutes: number;
}

/** Runtime road state that differs from the base city (compact, sorted). */
export interface RoadConditionSnapshot {
  readonly roadId: RoadId;
  readonly closed: boolean;
  readonly capacity: number;
}

/**
 * Deterministic, JSON-serializable snapshot of the world at the current tick.
 * Vehicles keep spawn order; signals, occupancy, incidents and road
 * conditions are sorted by id, so two identical runs produce byte-identical
 * JSON — including incident history and effective road state (Task 10).
 */
export interface SimulationSnapshot {
  readonly timeMs: number;
  readonly vehicles: VehicleSnapshot[];
  readonly signals: SignalSnapshot[];
  readonly occupancy: Array<[RoadId, number]>;
  readonly metrics: SimulationMetrics;
  readonly incidents: IncidentSnapshotRecord[];
  readonly roadConditions: RoadConditionSnapshot[];
  readonly rerouteStats: { attempted: number; succeeded: number; failed: number };
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
  const incidents: IncidentSnapshotRecord[] = [...engine.incidents.records]
    .sort((a, b) => a.id - b.id)
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      scheduledAtMs: record.scheduledAtMs,
      activatedAtMs: record.activatedAtMs,
      expiresAtMs: record.expiresAtMs,
      status: record.status,
      roadIds: [...record.roadIds],
      eventCenterIntersectionId: record.eventCenterIntersectionId,
      injectedSpawnCount: record.injectedSpawnCount,
      affectedVehicleCount: record.affectedVehicleCount,
      successfulReroutes: record.successfulReroutes,
      failedReroutes: record.failedReroutes,
    }));
  const roadConditions: RoadConditionSnapshot[] = [];
  for (const road of engine.city.roads) {
    const base = engine.baseCity.roads[road.id];
    if (road.closed !== base.closed || road.capacity !== base.capacity) {
      roadConditions.push({ roadId: road.id, closed: road.closed, capacity: road.capacity });
    }
  }
  roadConditions.sort((a, b) => a.roadId - b.roadId);
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
    incidents,
    roadConditions,
    rerouteStats: { ...engine.rerouteStats },
  };
}
