/**
 * Bounded presentation snapshots: the live-render frame sent to the main thread.
 *
 * Issue #24 changed what this frame IS. It used to carry every active vehicle,
 * which made the render payload scale with the fleet: a rush-hour city shipped
 * hundreds of vehicle objects across the worker boundary every 200 ms so the map
 * could draw them. The product now has ONE protagonist — the curated trip's ego
 * car — and background traffic stays in the engine where it belongs.
 *
 * The frame therefore contains:
 *
 * - the ego vehicle, or null before it spawns (and if its route never forms);
 * - SPARSE per-road traffic aggregates, so roads can be coloured by state in
 *   Issue #25 without shipping a single background vehicle object;
 * - control state for the ego's remaining route only — the city still runs
 *   every signal, presentation just stops transmitting the ones that do not
 *   matter to the challenge;
 * - the ego's trip progress, from facts the simulation actually has;
 * - runtime road conditions and incident markers the UI already needs.
 *
 * Deterministic for identical engine state.
 */
import type { EngineState } from "@/sim/engine";
import { currentQueueWaitMs } from "@/sim/approach-stats";
import { computeMetrics, type SimulationMetrics } from "@/sim/metrics";
import type { SignalStage } from "@/sim/signals";
import type { IncidentKind, IncidentRecord } from "@/sim/incidents";
import type { IntersectionId, RoadId, VehicleId, VehicleState, VehicleType } from "@/sim/types";

/** One directed road carrying visible state. Absent road = free baseline. */
export interface PresentationRoadTraffic {
  readonly roadId: RoadId;
  /** Footprint units currently on the road (the simulation's own measure). */
  readonly occupancy: number;
  /** Effective capacity, so a consumer can ratio the two without city data. */
  readonly capacity: number;
  /** Active vehicles on this road (any state except arrived). */
  readonly vehicleCount: number;
  /** Vehicles queued at this road's stop line. */
  readonly queuedCount: number;
  /**
   * Longest current blocked wait on this road, in ms. Kept here because road
   * congestion reads it, and one scalar per OCCUPIED road is still sparse —
   * versus a wait field on every vehicle object.
   */
  readonly maxBlockedWaitMs: number;
}

/**
 * The one vehicle the map draws. Everything here is a straight read of the
 * simulation's own vehicle: no re-derivation, no presentation-only physics.
 */
export interface PresentationEgoVehicle {
  readonly id: VehicleId;
  readonly type: VehicleType;
  readonly state: VehicleState;
  readonly roadId: RoadId | null;
  readonly progress: number;
  readonly routeIndex: number;
  readonly queueRank: number | null;
  readonly blockedWaitMs: number;
  /** Current effective speed (world units per second). */
  readonly speed: number;
}

export interface PresentationTripProgress {
  readonly tripId: string;
  readonly originIntersectionId: IntersectionId;
  readonly destinationIntersectionId: IntersectionId;
  /** The ego's CURRENT route — updates if an incident reroutes it. */
  readonly routeRoadIds: readonly RoadId[];
  readonly routeIndex: number;
  readonly tripTimeMs: number;
  readonly waitTimeMs: number;
  readonly distanceRemainingM: number;
  readonly distanceTravelledM: number;
  readonly intersectionsCleared: number;
  readonly completed: boolean;
  /**
   * Deterministic estimate of the time left, derived ONLY from the remaining
   * route's free-flow times and the current occupancy of those roads
   * (factor = 1 - 0.8 * occupancy/capacity, floored so a jam never reads as
   * infinite; a closed road is near-blocked). It ignores signal waits, so it is
   * an estimate, not a promise — which is why the HUD labels it "Est.".
   */
  readonly estimatedRemainingMs: number | null;
}

export interface PresentationSignal {
  readonly intersectionId: IntersectionId;
  readonly phaseIndex: number;
  readonly stage: SignalStage;
}

export interface PresentationRoadCondition {
  readonly roadId: RoadId;
  readonly closed: boolean;
  readonly capacity: number;
}

export interface PresentationIncidentMarker {
  readonly id: number;
  readonly kind: IncidentKind;
  readonly status: IncidentRecord["status"];
  readonly roadIds: readonly RoadId[];
  readonly eventCenterIntersectionId: IntersectionId | null;
  readonly expiresAtMs: number | null;
}

export interface PresentationSnapshot {
  /** Monotonic frame counter from the worker. */
  readonly sequence: number;
  readonly timeMs: number;
  readonly controller: string;
  /** The challenge's protagonist, or null before it exists. At most one. */
  readonly ego: PresentationEgoVehicle | null;
  /** Sparse road state for later traffic colouring. No vehicle objects. */
  readonly roadTraffic: readonly PresentationRoadTraffic[];
  /** Control state on the ego's remaining route only. */
  readonly routeControls: readonly PresentationSignal[];
  readonly trip: PresentationTripProgress | null;
  readonly roadConditions: readonly PresentationRoadCondition[];
  readonly incidents: readonly PresentationIncidentMarker[];
}

export type PresentationMetrics = SimulationMetrics & {
  readonly activeVehicles: number;
};

/**
 * Queue rank per vehicle: 0 is the front of its directed road's queue.
 *
 * The rule is copied from `sim/traffic.ts` deliberately — queuedSinceMs
 * ascending, then id — because presentation must never disagree with the
 * simulation about who is in front. Exported so the exact semantics are
 * testable without standing up an engine.
 */
export function assignQueueRanks(
  vehicles: readonly {
    readonly id: VehicleId;
    readonly state: string;
    readonly roadId: RoadId | null;
    readonly queuedSinceMs: number | null;
  }[],
): Map<VehicleId, number> {
  const ranks = new Map<VehicleId, number>();
  const queues = new Map<RoadId, { id: VehicleId; since: number }[]>();
  for (const vehicle of vehicles) {
    if (vehicle.state !== "queued" || vehicle.roadId === null) {
      continue;
    }
    const list = queues.get(vehicle.roadId) ?? [];
    list.push({ id: vehicle.id, since: vehicle.queuedSinceMs ?? 0 });
    queues.set(vehicle.roadId, list);
  }
  for (const queue of queues.values()) {
    queue.sort((a, b) => a.since - b.since || a.id - b.id);
    queue.forEach((entry, rank) => ranks.set(entry.id, rank));
  }
  return ranks;
}

/** Blocked wait by state: continuous while queued, pending wait, else zero. */
function blockedWaitOf(engine: EngineState, vehicle: EngineState["traffic"]["vehicles"][number]): number {
  if (vehicle.state === "queued") {
    return currentQueueWaitMs(engine.traffic.timeMs, vehicle.queuedSinceMs);
  }
  if (vehicle.state === "pending") {
    return vehicle.waitTimeMs;
  }
  return 0;
}

/**
 * Sparse road aggregates: only roads with vehicles or queues appear. An absent
 * road is a free road, so the payload scales with NETWORK STATE rather than
 * with the number of vehicle objects.
 */
export function aggregateRoadTraffic(engine: EngineState): PresentationRoadTraffic[] {
  const vehicleCounts = new Map<RoadId, number>();
  const queuedCounts = new Map<RoadId, number>();
  const maxWaits = new Map<RoadId, number>();
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.roadId === null || vehicle.state === "arrived") {
      continue;
    }
    vehicleCounts.set(vehicle.roadId, (vehicleCounts.get(vehicle.roadId) ?? 0) + 1);
    if (vehicle.state === "queued") {
      queuedCounts.set(vehicle.roadId, (queuedCounts.get(vehicle.roadId) ?? 0) + 1);
    }
    const wait = blockedWaitOf(engine, vehicle);
    if (wait > 0) {
      maxWaits.set(vehicle.roadId, Math.max(maxWaits.get(vehicle.roadId) ?? 0, wait));
    }
  }
  const roadIds = new Set<RoadId>(engine.traffic.occupancy.keys());
  for (const roadId of queuedCounts.keys()) {
    roadIds.add(roadId);
  }
  return [...roadIds]
    .sort((a, b) => a - b)
    .map((roadId) => ({
      roadId,
      occupancy: engine.traffic.occupancy.get(roadId) ?? 0,
      capacity: engine.city.roads[roadId]?.capacity ?? 0,
      vehicleCount: vehicleCounts.get(roadId) ?? 0,
      queuedCount: queuedCounts.get(roadId) ?? 0,
      maxBlockedWaitMs: maxWaits.get(roadId) ?? 0,
    }));
}

/** Intersections the ego still has to pass: the remaining route's endpoints. */
function remainingRouteIntersections(
  engine: EngineState,
  route: readonly RoadId[],
  routeIndex: number,
): Set<IntersectionId> {
  const nodes = new Set<IntersectionId>();
  for (let index = Math.max(0, routeIndex - 1); index < route.length; index += 1) {
    const road = engine.city.roads[route[index]];
    if (!road) {
      continue;
    }
    nodes.add(road.from);
    nodes.add(road.to);
  }
  return nodes;
}

function tripProgressOf(
  engine: EngineState,
  tripId: string | null,
  ego: EngineState["traffic"]["vehicles"][number],
): PresentationTripProgress | null {
  if (tripId === null) {
    return null;
  }
  let travelled = 0;
  let remaining = 0;
  for (let index = 0; index < ego.route.length; index += 1) {
    const length = engine.city.roads[ego.route[index]]?.length ?? 0;
    if (index < ego.routeIndex) {
      travelled += length;
    } else if (index === ego.routeIndex) {
      travelled += Math.max(0, Math.min(length, ego.progress));
      remaining += Math.max(0, length - ego.progress);
    } else {
      remaining += length;
    }
  }
  let etaSeconds = 0;
  for (let index = ego.routeIndex; index < ego.route.length; index += 1) {
    const road = engine.city.roads[ego.route[index]];
    if (!road || road.speedLimit <= 0) {
      continue;
    }
    const length = index === ego.routeIndex ? Math.max(0, road.length - ego.progress) : road.length;
    const ratio =
      road.capacity > 0
        ? Math.min(1, (engine.traffic.occupancy.get(road.id) ?? 0) / road.capacity)
        : 0;
    const factor = road.closed ? 0.08 : Math.max(0.2, 1 - 0.8 * ratio);
    etaSeconds += length / road.speedLimit / factor;
  }
  const completed = ego.state === "arrived";
  return {
    tripId,
    originIntersectionId: ego.origin,
    destinationIntersectionId: ego.destination,
    routeRoadIds: [...ego.route],
    routeIndex: ego.routeIndex,
    tripTimeMs: ego.tripTimeMs,
    waitTimeMs: ego.waitTimeMs,
    distanceRemainingM: remaining,
    distanceTravelledM: travelled,
    intersectionsCleared: ego.routeIndex,
    completed,
    estimatedRemainingMs: completed ? 0 : Math.round(etaSeconds * 1_000),
  };
}

export function buildPresentationSnapshot(
  engine: EngineState,
  sequence: number,
  tripId: string | null = null,
): PresentationSnapshot {
  const vehicles = engine.traffic.vehicles;
  const queueRanks = assignQueueRanks(vehicles);

  // Exactly one ego, identified by the id the engine recorded when the ego
  // spawn created its vehicle — never by position in the vehicle list.
  const egoVehicle =
    engine.egoVehicleId === null ? undefined : vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId);
  const ego: PresentationEgoVehicle | null = egoVehicle
    ? {
        id: egoVehicle.id,
        type: egoVehicle.type,
        state: egoVehicle.state,
        roadId: egoVehicle.roadId,
        progress: egoVehicle.progress,
        routeIndex: egoVehicle.routeIndex,
        queueRank: queueRanks.get(egoVehicle.id) ?? null,
        blockedWaitMs: blockedWaitOf(engine, egoVehicle),
        // An arrived car is parked: report 0 rather than the speed it was
        // carrying when it crossed the destination.
        speed: egoVehicle.state === "arrived" ? 0 : egoVehicle.speed,
      }
    : null;

  // Control state is filtered to the ego's remaining route: the data exists for
  // the challenge, not for a citywide signal field. No visual behaviour here —
  // Issue #26 decides how controls appear.
  const routeNodes = egoVehicle
    ? remainingRouteIntersections(engine, egoVehicle.route, egoVehicle.routeIndex)
    : new Set<IntersectionId>();
  const routeControls: PresentationSignal[] = [...engine.traffic.signals.entries()]
    .filter(([intersectionId]) => routeNodes.has(intersectionId))
    .sort((a, b) => a[0] - b[0])
    .map(([intersectionId, signal]) => ({
      intersectionId,
      phaseIndex: signal.phaseIndex,
      stage: signal.stage,
    }));

  const roadConditions: PresentationRoadCondition[] = [];
  for (const road of engine.city.roads) {
    const base = engine.baseCity.roads[road.id];
    if (road.closed !== base.closed || road.capacity !== base.capacity) {
      roadConditions.push({ roadId: road.id, closed: road.closed, capacity: road.capacity });
    }
  }
  roadConditions.sort((a, b) => a.roadId - b.roadId);

  const incidents: PresentationIncidentMarker[] = [...engine.incidents.records]
    .sort((a, b) => a.id - b.id)
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      roadIds: [...record.roadIds],
      eventCenterIntersectionId: record.eventCenterIntersectionId,
      expiresAtMs: record.expiresAtMs,
    }));

  return {
    sequence,
    timeMs: engine.traffic.timeMs,
    controller: engine.controller.id,
    ego,
    roadTraffic: aggregateRoadTraffic(engine),
    routeControls,
    trip: egoVehicle ? tripProgressOf(engine, tripId, egoVehicle) : null,
    roadConditions,
    incidents,
  };
}

export function buildPresentationMetrics(engine: EngineState): PresentationMetrics {
  let activeVehicles = 0;
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state !== "arrived") {
      activeVehicles += 1;
    }
  }
  return {
    ...computeMetrics(engine.metrics, engine.traffic),
    activeVehicles,
  };
}
