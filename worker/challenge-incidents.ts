/**
 * Controller-neutral challenge incidents (Issue #27).
 *
 * The challenge promise is "same city + same trip + same traffic + same
 * incidents, different controller". Automatic incidents are therefore fully
 * resolved before any controller executes. Manual incidents may target the
 * ego's live remaining route, but the concrete resolved entry is recorded so a
 * later comparison run can replay the exact same adversity.
 */
import { availableChicagoEventVenues } from "@/cities/chicago";
import type { MapModel } from "@/cities/map-model";
import type { CuratedTripId, MaterializedCuratedTrip } from "@/cities/chicago-trips";
import type {
  IncidentKind,
  IncidentScriptEntry,
  PhysicalSegment,
} from "@/sim/incidents";
import { physicalSegments, reachableIntersectionCount } from "@/sim/incidents";
import { createRng } from "@/sim/rng";
import type {
  City,
  IntersectionId,
  RoadId,
  TrafficLevel,
} from "@/sim/types";

export const CHALLENGE_INCIDENT_COUNTS: Record<TrafficLevel, number> = {
  light: 0,
  everyday: 1,
  "rush-hour": 2,
} as const;

export const CHALLENGE_INCIDENT_TIMING = {
  minimumAtMs: 12_000,
  fractions: [0.34, 0.66] as const,
  jitterFraction: 0.055,
  minimumGapMs: 12_000,
  tickMs: 100,
} as const;

export interface ChallengeIncidentPlan {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly seed: number;
  /** Dedicated incident RNG root. Controller is deliberately absent. */
  readonly incidentSeed: number;
  /** Fully resolved, concrete Task-10 script entries. */
  readonly entries: readonly IncidentScriptEntry[];
}

export interface ResolvedChallengeIncident {
  readonly id: number;
  readonly source: "automatic" | "manual";
  readonly entry: IncidentScriptEntry;
}

export interface ManualChallengeIncidentInput {
  readonly model: MapModel;
  /** Runtime city is allowed here: a human clicked during this exact live run. */
  readonly city: City;
  readonly kind: IncidentKind;
  readonly atMs: number;
  readonly seed: number;
  readonly sequence: number;
  readonly routeRoadIds: readonly RoadId[];
  readonly routeIndex: number;
  readonly egoRoadId: RoadId | null;
  readonly destinationIntersectionId: IntersectionId;
}

export interface ManualChallengeIncidentResolution {
  readonly entry: IncidentScriptEntry | null;
  readonly label: string;
}

function roundToTick(ms: number): number {
  return Math.round(ms / CHALLENGE_INCIDENT_TIMING.tickMs) * CHALLENGE_INCIDENT_TIMING.tickMs;
}

function freeFlowRouteMs(city: City, routeRoadIds: readonly RoadId[]): number {
  let seconds = 0;
  for (const roadId of routeRoadIds) {
    const road = city.roads[roadId];
    if (road && road.speedLimit > 0) {
      seconds += road.length / road.speedLimit;
    }
  }
  return Math.max(1_000, Math.round(seconds * 1_000));
}

function routeNodes(city: City, roadIds: readonly RoadId[]): IntersectionId[] {
  if (roadIds.length === 0) {
    return [];
  }
  const first = city.roads[roadIds[0]];
  const nodes: IntersectionId[] = first ? [first.from] : [];
  for (const roadId of roadIds) {
    const road = city.roads[roadId];
    if (road) nodes.push(road.to);
  }
  return nodes;
}

/** Directed OD reachability without mutating the city. */
export function tripReachableExcluding(
  city: City,
  origin: IntersectionId,
  destination: IntersectionId,
  excludedRoadIds: ReadonlySet<RoadId>,
): boolean {
  if (origin === destination) return true;
  const seen = new Set<IntersectionId>([origin]);
  const queue: IntersectionId[] = [origin];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const node = queue[cursor];
    const intersection = city.intersections[node];
    if (!intersection) continue;
    for (const roadId of intersection.outgoing) {
      if (excludedRoadIds.has(roadId)) continue;
      const road = city.roads[roadId];
      if (!road || road.closed) continue;
      if (road.to === destination) return true;
      if (!seen.has(road.to)) {
        seen.add(road.to);
        queue.push(road.to);
      }
    }
  }
  return false;
}

function segmentMaps(city: City): {
  byRoad: Map<RoadId, PhysicalSegment>;
  segments: readonly PhysicalSegment[];
} {
  const segments = physicalSegments(city);
  const byRoad = new Map<RoadId, PhysicalSegment>();
  for (const segment of segments) {
    for (const roadId of segment.roadIds) byRoad.set(roadId, segment);
  }
  return { byRoad, segments };
}

function centralRouteRoads(routeRoadIds: readonly RoadId[]): RoadId[] {
  if (routeRoadIds.length <= 4) return [...routeRoadIds];
  const lo = Math.max(1, Math.floor(routeRoadIds.length * 0.14));
  const hi = Math.max(lo + 1, Math.ceil(routeRoadIds.length * 0.86));
  return routeRoadIds.slice(lo, hi);
}

function deterministicPick<T>(
  values: readonly T[],
  seed: number,
  label: string,
): T | null {
  if (values.length === 0) return null;
  return createRng(seed).fork(label).pick(values);
}

function safeRouteClosureSegments(
  city: City,
  trip: MaterializedCuratedTrip,
): PhysicalSegment[] {
  const { byRoad } = segmentMaps(city);
  const seen = new Set<string>();
  const candidates: PhysicalSegment[] = [];
  for (const roadId of centralRouteRoads(trip.route.roadIds)) {
    const segment = byRoad.get(roadId);
    if (!segment || seen.has(segment.key)) continue;
    seen.add(segment.key);
    const excluded = new Set(segment.roadIds);
    if (
      reachableIntersectionCount(city, excluded) === reachableIntersectionCount(city) &&
      tripReachableExcluding(
        city,
        trip.originIntersectionId,
        trip.destinationIntersectionId,
        excluded,
      )
    ) {
      candidates.push(segment);
    }
  }
  return candidates.sort((a, b) => a.roadId - b.roadId);
}

function routeBridgeSegments(
  model: MapModel,
  trip: MaterializedCuratedTrip,
): PhysicalSegment[] {
  const route = new Set(trip.route.roadIds);
  const { byRoad } = segmentMaps(model.city);
  const seen = new Set<string>();
  const candidates: PhysicalSegment[] = [];
  for (const bridge of model.waterCrossingBridges) {
    const segment = byRoad.get(bridge.roadId);
    if (!segment || seen.has(segment.key)) continue;
    if (!segment.roadIds.some((roadId) => route.has(roadId))) continue;
    const excluded = new Set(segment.roadIds);
    if (
      reachableIntersectionCount(model.city, excluded) !==
        reachableIntersectionCount(model.city) ||
      !tripReachableExcluding(
        model.city,
        trip.originIntersectionId,
        trip.destinationIntersectionId,
        excluded,
      )
    ) {
      continue;
    }
    seen.add(segment.key);
    candidates.push(segment);
  }
  return candidates.sort((a, b) => a.roadId - b.roadId);
}

function nearestVenueCenters(
  model: MapModel,
  roadIds: readonly RoadId[],
): IntersectionId[] {
  const nodes = routeNodes(model.city, roadIds);
  if (nodes.length === 0) return [];
  return availableChicagoEventVenues(model)
    .map((venue) => {
      const point = model.city.intersections[venue.intersectionId];
      let distance = Infinity;
      for (const nodeId of nodes) {
        const node = model.city.intersections[nodeId];
        distance = Math.min(distance, Math.hypot(node.x - point.x, node.y - point.y));
      }
      return { id: venue.intersectionId, distance };
    })
    .sort((a, b) => a.distance - b.distance || a.id - b.id)
    .slice(0, 3)
    .map((entry) => entry.id);
}

function automaticEntryForKind(
  model: MapModel,
  trip: MaterializedCuratedTrip,
  kind: IncidentKind,
  atMs: number,
  seed: number,
  eventIndex: number,
): IncidentScriptEntry | null {
  const label = `automatic:${eventIndex}:${kind}`;
  switch (kind) {
    case "traffic-burst":
      return { atMs, kind };
    case "crash": {
      const roadId = deterministicPick(
        centralRouteRoads(trip.route.roadIds).filter((id) => !model.city.roads[id]?.closed),
        seed,
        `${label}:road`,
      );
      return roadId === null ? null : { atMs, kind, targetRoadId: roadId };
    }
    case "close-road": {
      const segment = deterministicPick(
        safeRouteClosureSegments(model.city, trip),
        seed,
        `${label}:segment`,
      );
      return segment === null
        ? null
        : { atMs, kind, targetRoadId: segment.roadId, allowDisconnect: false };
    }
    case "bridge-closed": {
      const segment = deterministicPick(
        routeBridgeSegments(model, trip),
        seed,
        `${label}:bridge`,
      );
      return segment === null
        ? null
        : { atMs, kind, targetRoadId: segment.roadId, allowDisconnect: false };
    }
    case "event-release": {
      const centerIntersectionId = deterministicPick(
        nearestVenueCenters(model, trip.route.roadIds),
        seed,
        `${label}:venue`,
      );
      return centerIntersectionId === null
        ? null
        : { atMs, kind, centerIntersectionId };
    }
  }
}

function plannedAtMs(
  city: City,
  routeRoadIds: readonly RoadId[],
  seed: number,
  eventIndex: number,
  previousAtMs: number,
): number {
  const baseMs = freeFlowRouteMs(city, routeRoadIds);
  const fraction =
    CHALLENGE_INCIDENT_TIMING.fractions[
      Math.min(eventIndex, CHALLENGE_INCIDENT_TIMING.fractions.length - 1)
    ];
  const jitter =
    (createRng(seed).fork(`challenge-time:${eventIndex}`).nextFloat() * 2 - 1) *
    CHALLENGE_INCIDENT_TIMING.jitterFraction;
  const raw = Math.max(
    CHALLENGE_INCIDENT_TIMING.minimumAtMs,
    baseMs * Math.max(0.1, fraction + jitter),
  );
  return roundToTick(
    Math.max(raw, previousAtMs + (eventIndex === 0 ? 0 : CHALLENGE_INCIDENT_TIMING.minimumGapMs)),
  );
}

const AUTOMATIC_KIND_ORDER: readonly IncidentKind[] = [
  "crash",
  "close-road",
  "event-release",
  "traffic-burst",
  "bridge-closed",
];

export function buildChallengeIncidentPlan(
  model: MapModel,
  trip: MaterializedCuratedTrip,
  trafficLevel: TrafficLevel,
  seed: number,
): ChallengeIncidentPlan {
  const normalizedSeed = seed >>> 0;
  const incidentSeed = createRng(normalizedSeed).fork("challenge-incidents").seed;
  const count = CHALLENGE_INCIDENT_COUNTS[trafficLevel];
  const entries: IncidentScriptEntry[] = [];
  const usedKinds = new Set<IncidentKind>();
  let previousAtMs = 0;

  for (let index = 0; index < count; index += 1) {
    const atMs = plannedAtMs(model.city, trip.route.roadIds, incidentSeed, index, previousAtMs);
    const rng = createRng(incidentSeed).fork(`challenge-kind:${index}`);
    const start = rng.nextInt(0, AUTOMATIC_KIND_ORDER.length - 1);
    let chosen: IncidentScriptEntry | null = null;

    // First pass prefers a different kind for the second Rush event.
    for (const requireFresh of [true, false]) {
      for (let offset = 0; offset < AUTOMATIC_KIND_ORDER.length; offset += 1) {
        const kind = AUTOMATIC_KIND_ORDER[(start + offset) % AUTOMATIC_KIND_ORDER.length];
        if (requireFresh && usedKinds.has(kind)) continue;
        const candidate = automaticEntryForKind(model, trip, kind, atMs, incidentSeed, index);
        if (candidate) {
          chosen = candidate;
          break;
        }
      }
      if (chosen) break;
    }

    if (chosen) {
      entries.push(chosen);
      usedKinds.add(chosen.kind);
      previousAtMs = chosen.atMs;
    }
  }

  return {
    tripId: trip.trip.id,
    trafficLevel,
    seed: normalizedSeed,
    incidentSeed,
    entries,
  };
}

function remainingRoads(input: ManualChallengeIncidentInput): RoadId[] {
  const start = Math.max(0, Math.min(input.routeIndex, input.routeRoadIds.length));
  return input.routeRoadIds.slice(start);
}

function manualSafeClosureCandidates(input: ManualChallengeIncidentInput): PhysicalSegment[] {
  const remaining = remainingRoads(input);
  // A closure must hit an UNTRAVELLED suffix to trigger the engine's reroute
  // semantics. Skip the current road: vehicles are allowed to finish it.
  const future = input.egoRoadId === null ? remaining : remaining.slice(1);
  const { byRoad } = segmentMaps(input.city);
  const seen = new Set<string>();
  const candidates: PhysicalSegment[] = [];
  const rerouteOrigin =
    input.egoRoadId === null
      ? input.city.roads[future[0] ?? remaining[0]]?.from
      : input.city.roads[input.egoRoadId]?.to;
  if (rerouteOrigin === undefined) return [];

  for (const roadId of future) {
    const segment = byRoad.get(roadId);
    if (!segment || seen.has(segment.key)) continue;
    seen.add(segment.key);
    const excluded = new Set(segment.roadIds);
    if (
      reachableIntersectionCount(input.city, excluded) ===
        reachableIntersectionCount(input.city) &&
      tripReachableExcluding(
        input.city,
        rerouteOrigin,
        input.destinationIntersectionId,
        excluded,
      )
    ) {
      candidates.push(segment);
    }
  }
  return candidates.sort((a, b) => a.roadId - b.roadId);
}

function manualRelevantBridges(input: ManualChallengeIncidentInput): PhysicalSegment[] {
  const remaining = new Set(remainingRoads(input).slice(input.egoRoadId === null ? 0 : 1));
  const { byRoad } = segmentMaps(input.city);
  const safe = new Set(manualSafeClosureCandidates(input).map((segment) => segment.key));
  const seen = new Set<string>();
  const out: PhysicalSegment[] = [];
  for (const bridge of input.model.waterCrossingBridges) {
    const segment = byRoad.get(bridge.roadId);
    if (!segment || seen.has(segment.key) || !safe.has(segment.key)) continue;
    if (!segment.roadIds.some((roadId) => remaining.has(roadId))) continue;
    seen.add(segment.key);
    out.push(segment);
  }
  return out.sort((a, b) => a.roadId - b.roadId);
}

export function resolveManualChallengeIncident(
  input: ManualChallengeIncidentInput,
): ManualChallengeIncidentResolution {
  const atMs = roundToTick(Math.max(0, input.atMs));
  const rng = createRng(input.seed).fork(`manual:${input.sequence}:${input.kind}`);
  const remaining = remainingRoads(input);

  switch (input.kind) {
    case "traffic-burst":
      return { entry: { atMs, kind: input.kind }, label: "+5× traffic queued citywide" };

    case "crash": {
      const candidates = remaining.filter((roadId) => {
        const road = input.city.roads[roadId];
        return road && !road.closed;
      });
      const pool = candidates.slice(0, Math.min(10, candidates.length));
      const targetRoadId = pool.length > 0 ? rng.pick(pool) : null;
      return targetRoadId === null
        ? { entry: null, label: "No valid route road for a crash" }
        : {
            entry: { atMs, kind: input.kind, targetRoadId },
            label: "Crash queued on the trip corridor",
          };
    }

    case "close-road": {
      const candidates = manualSafeClosureCandidates(input);
      const pool = candidates.slice(0, Math.min(8, candidates.length));
      const segment = pool.length > 0 ? rng.pick(pool) : null;
      return segment === null
        ? { entry: null, label: "No safe route closure is available" }
        : {
            entry: {
              atMs,
              kind: input.kind,
              targetRoadId: segment.roadId,
              allowDisconnect: false,
            },
            label: "Route road closure queued",
          };
    }

    case "bridge-closed": {
      const candidates = manualRelevantBridges(input);
      const segment = candidates.length > 0 ? rng.pick(candidates) : null;
      return segment === null
        ? { entry: null, label: "No relevant river crossing can be closed safely" }
        : {
            entry: {
              atMs,
              kind: input.kind,
              targetRoadId: segment.roadId,
              allowDisconnect: false,
            },
            label: "Route-relevant bridge closure queued",
          };
    }

    case "event-release": {
      const centers = nearestVenueCenters(input.model, remaining);
      const centerIntersectionId = centers.length > 0 ? rng.pick(centers) : null;
      return centerIntersectionId === null
        ? { entry: null, label: "No relevant event venue is available" }
        : {
            entry: { atMs, kind: input.kind, centerIntersectionId },
            label: "Event release queued near the trip corridor",
          };
    }
  }
}

export function challengeIncidentFingerprintInput(
  plan: ChallengeIncidentPlan,
  history: readonly ResolvedChallengeIncident[] = [],
): string {
  const manual = history
    .filter((incident) => incident.source === "manual")
    .map((incident) => incident.entry);
  return JSON.stringify({
    tripId: plan.tripId,
    trafficLevel: plan.trafficLevel,
    seed: plan.seed,
    automatic: plan.entries,
    manual,
  });
}
