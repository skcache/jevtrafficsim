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
import { INCIDENT_KINDS } from "@/sim/incidents";
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

/**
 * Whether an instrument can do anything in the world this run is playing
 * (Issue #39). Derived by ASKING the same resolver a click would use, so the
 * answer cannot drift from the behaviour: no duplicated targeting logic, no
 * heuristic "probably fine". `reason` is the resolver's own words when the
 * answer is no, and must be shown, not swallowed.
 *
 * It is a probe, not a promise: a world that offers a closure now can lose it
 * once one has been used, which is why the worker re-probes after each incident.
 */
export interface IncidentCapability {
  readonly kind: IncidentKind;
  readonly applicable: boolean;
  readonly reason: string | null;
}

/** One capability per kind, in the dock's own order. */
export function incidentCapabilities(
  input: Omit<ManualChallengeIncidentInput, "kind">,
): readonly IncidentCapability[] {
  return INCIDENT_KINDS.map((kind) => {
    const resolution = resolveManualChallengeIncident({ ...input, kind });
    return {
      kind,
      applicable: resolution.entry !== null,
      reason: resolution.entry === null ? resolution.label : null,
    };
  });
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

/**
 * Static target window for automatic adversity.
 *
 * Timing and targeting use the same canonical route, but targeting is biased
 * AHEAD of where a free-flow ego would be when the event fires. This keeps an
 * automatic crash/closure relevant without ever consulting controller-specific
 * live state. First event targets the middle-late trip; second targets the
 * final third. A broader central-route fallback keeps short/odd routes valid.
 */
export function automaticTargetRoads(
  city: City,
  routeRoadIds: readonly RoadId[],
  eventIndex: number,
): RoadId[] {
  if (routeRoadIds.length <= 4) return [...routeRoadIds];

  // Route position is measured by free-flow travel time, not array index.
  // Chicago routes mix tiny downtown links with long expressway pieces; an
  // index fraction can put a "late trip" incident physically near the start.
  const durations = routeRoadIds.map((roadId) => {
    const road = city.roads[roadId];
    return road && road.speedLimit > 0 ? road.length / road.speedLimit : 0;
  });
  const total = durations.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return [...routeRoadIds];

  const window =
    eventIndex === 0
      ? { lo: 0.42, hi: 0.68 }
      : { lo: 0.70, hi: 0.94 };
  const center = (window.lo + window.hi) / 2;
  let elapsed = 0;
  const scored = routeRoadIds.map((roadId, index) => {
    const duration = durations[index];
    const midpoint = (elapsed + duration / 2) / total;
    elapsed += duration;
    return { roadId, midpoint };
  });
  const targeted = scored
    .filter((entry) => entry.midpoint >= window.lo && entry.midpoint <= window.hi)
    .map((entry) => entry.roadId);
  if (targeted.length > 0) return targeted;

  // Degenerate route geometry can leave no road midpoint inside a narrow band.
  // Pick the three nearest roads to the intended progress point, preserving
  // driving order in the returned set.
  return scored
    .map((entry, index) => ({ ...entry, index, distance: Math.abs(entry.midpoint - center) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .slice(0, 3)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.roadId);
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
  candidateRoadIds: readonly RoadId[],
): PhysicalSegment[] {
  const { byRoad } = segmentMaps(city);
  const seen = new Set<string>();
  const candidates: PhysicalSegment[] = [];
  for (const roadId of candidateRoadIds) {
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
  candidateRoadIds: readonly RoadId[],
): PhysicalSegment[] {
  const route = new Set(candidateRoadIds);
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

const MAX_ROUTE_VENUE_DISTANCE_M = 1_200;

function roadLabel(model: MapModel, roadId: RoadId): string {
  const piece = model.streets.find((street) => street.roadIds.includes(roadId));
  return piece?.bridge?.name ?? piece?.name ?? piece?.ref ?? `road ${roadId}`;
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
    .filter((entry) => entry.distance <= MAX_ROUTE_VENUE_DISTANCE_M)
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
  const targetRoads = automaticTargetRoads(model.city, trip.route.roadIds, eventIndex);
  switch (kind) {
    case "traffic-burst":
      return { atMs, kind };
    case "crash": {
      const roadId = deterministicPick(
        targetRoads.filter((id) => !model.city.roads[id]?.closed),
        seed,
        `${label}:road`,
      );
      return roadId === null ? null : { atMs, kind, targetRoadId: roadId };
    }
    case "close-road": {
      const candidates = safeRouteClosureSegments(model.city, trip, targetRoads);
      const segment = deterministicPick(candidates, seed, `${label}:segment`);
      return segment === null
        ? null
        : { atMs, kind, targetRoadId: segment.roadId, allowDisconnect: false };
    }
    case "bridge-closed": {
      const candidates = routeBridgeSegments(model, trip, targetRoads);
      const segment = deterministicPick(candidates, seed, `${label}:bridge`);
      return segment === null
        ? null
        : { atMs, kind, targetRoadId: segment.roadId, allowDisconnect: false };
    }
    case "event-release": {
      const centers = nearestVenueCenters(model, targetRoads);
      const centerIntersectionId = deterministicPick(
        centers,
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
  let usedClosure = false;
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
        if (usedClosure && (kind === "close-road" || kind === "bridge-closed")) continue;
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
      if (chosen.kind === "close-road" || chosen.kind === "bridge-closed") {
        usedClosure = true;
      }
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
            label: `Crash queued on ${roadLabel(input.model, targetRoadId)}`,
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
            label: `${roadLabel(input.model, segment.roadId)} closed; rerouting`,
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
            label: `${roadLabel(input.model, segment.roadId)} closed`,
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
