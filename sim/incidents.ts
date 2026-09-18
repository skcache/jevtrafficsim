/**
 * Deterministic traffic incidents (Task 10, PRD §4.3) — the five chaos
 * controls and their replayable seeded scripts.
 *
 *   traffic-burst  — +5x offered demand for a window (base events amplified
 *                    with four injected copies each; the base schedule is
 *                    never mutated and injections never re-amplify)
 *   crash          — temporary CAPACITY loss on one directed road
 *   close-road     — both directions of one PHYSICAL segment closed, with
 *                    closure-triggered rerouting of affected vehicles
 *   bridge-closed  — the same, but restricted to bridge segments chosen by a
 *                    deterministic centrality proxy
 *   event-release  — a bounded burst of spatially concentrated origins
 *                    (event neighborhood) with city-wide destinations
 *
 * ## Isolation (critical architecture rule)
 *
 * Incidents temporarily mutate road state, so the engine NEVER touches the
 * caller's City: `createRuntimeCity` makes an engine-owned deep-enough copy
 * (roads + intersections + corridors), and every subsystem — A*, spawn
 * routing, traffic admission/spillback, observations, controllers, metrics
 * and invariant checks — reads that runtime city. Static topology metadata
 * (regions, corridors, positions) is identical in both, so the Task-09
 * partition stays valid; only road `closed`/`capacity` differ, and only in
 * the runtime copy.
 *
 * ## Randomness
 *
 * Incident randomness is isolated from every other stream. Each script entry
 * derives its own child stream:
 *
 *   createRng(seed).fork("incidents").fork(`<sequence>:<kind>`)
 *
 * where `sequence` is the entry's original script index. Resolutions never
 * share a cursor, so resolving one incident cannot shift another's draws
 * (inserting an entry renumbers following entries — the one documented
 * coupling, inherent to sequence-derived labels).
 *
 * ## Effective road conditions
 *
 * `applyRuntimeConditions` recomposes every road from BASE state plus ALL
 * currently active incidents: any active closure ⇒ closed; crashes compose as
 * the most restrictive desired capacity (`base * CRASH_CAPACITY_MULTIPLIER`),
 * and the effective capacity never drops below occupancy already resident on
 * the road (`max(desired, residentOccupancy)`), tightening as traffic drains.
 * Expiry is therefore never a naive restore: the next recomposition simply
 * excludes the expired incident.
 */
import { createRng, type Rng } from "./rng";
import type {
  City,
  CitySize,
  Corridor,
  Intersection,
  IntersectionId,
  Road,
  RoadId,
  RoadKind,
  VehicleType,
} from "./types";


export type IncidentKind =
  | "traffic-burst"
  | "crash"
  | "close-road"
  | "bridge-closed"
  | "event-release";

export const INCIDENT_KINDS: readonly IncidentKind[] = [
  "traffic-burst",
  "crash",
  "close-road",
  "bridge-closed",
  "event-release",
];

/** One scripted incident. `atMs` is simulated time, never wall clock. */
export interface IncidentScriptEntry {
  readonly atMs: number;
  readonly kind: IncidentKind;
  /** Temporary incidents use their default when omitted (see INCIDENT_DEFAULTS). */
  readonly durationMs?: number;
  /** crash / close-road: directed road id; bridge-closed: a bridge road id. */
  readonly targetRoadId?: RoadId;
  /** event-release: explicit event center; default is deterministic. */
  readonly centerIntersectionId?: IntersectionId;
  /** close-road / bridge-closed: allow a disconnect (default false). */
  readonly allowDisconnect?: boolean;
}

export interface IncidentConfig {
  readonly seed: number;
  /**
   * Scripted entries, indexed by their original sequence. Mutable so the
   * engine seam (`queueIncident`) can append interactive incidents at a
   * deterministic next sequence id; entries are never removed or reordered.
   */
  script: IncidentScriptEntry[];
}

/** Centralized incident constants (no magic numbers anywhere else). */
export const INCIDENT_DEFAULTS = {
  TRAFFIC_BURST_DURATION_MS: 30_000,
  CRASH_DURATION_MS: 30_000,
  CLOSE_ROAD_DURATION_MS: 45_000,
  BRIDGE_CLOSED_DURATION_MS: 60_000,
  /** Event releases spread their spawns across this window. */
  EVENT_RELEASE_WINDOW_MS: 15_000,
  /** PRD §4.3 "reduces capacity": V1 halves it. */
  CRASH_CAPACITY_MULTIPLIER: 0.5,
  /** PRD §9 reroute cooldown: at most one attempt per this window. */
  REROUTE_COOLDOWN_MS: 5_000,
} as const;

/** Bounded event-release burst size per city size (V1 table). */
export const EVENT_RELEASE_COUNTS: Record<CitySize, number> = {
  small: 10,
  "small-medium": 18,
  medium: 30,
  "medium-large": 48,
  large: 72,
};

/** Crowd leaving an event: mostly cars, few trucks, some bicycles. */
export const EVENT_RELEASE_TYPE_MIX = { car: 0.85, truck: 0.07, bicycle: 0.08 } as const;

/** Lifecycle of one scripted incident (JSON-safe; exposed in snapshots). */
export interface IncidentRecord {
  /** Stable id = original script sequence. */
  readonly id: number;
  readonly kind: IncidentKind;
  readonly scheduledAtMs: number;
  activatedAtMs: number | null;
  expiresAtMs: number | null;
  status: "pending" | "active" | "expired" | "not-applicable";
  /** Resolved physical segment (or crash target) road ids, sorted. */
  readonly roadIds: RoadId[];
  eventCenterIntersectionId: IntersectionId | null;
  readonly allowDisconnect: boolean;
  injectedSpawnCount: number;
  affectedVehicleCount: number;
  successfulReroutes: number;
  failedReroutes: number;
}

export interface IncidentRuntime {
  /** Records in (atMs, sequence) order; interactive entries splice in place. */
  records: IncidentRecord[];
  /** Next incident id: base script length, then one per interactive entry. */
  nextIncidentId: number;
  /** Monotonic counter for injected spawn tie-break sequences. */
  injectionSequence: number;
  /** Set while any road-affecting incident is active (per-tick recompute gate). */
  conditionsDirty: boolean;
}

export interface RuntimeInjectedSpawn {
  readonly timeMs: number;
  readonly sequence: number;
  readonly type: VehicleType;
  readonly origin: IntersectionId;
  readonly destination: IntersectionId;
}

/* ------------------------------------------------------------------ */
/* Runtime city                                                        */
/* ------------------------------------------------------------------ */

/**
 * Engine-owned deep-enough copy: roads and intersections are new objects and
 * the City itself is new, so incident mutations can never leak into the
 * caller's city. Lengths/topology are identical by construction.
 */
export function createRuntimeCity(city: City): City {
  const intersections: Intersection[] = city.intersections.map((intersection) => ({
    ...intersection,
    incoming: [...intersection.incoming],
    outgoing: [...intersection.outgoing],
  }));
  const roads: Road[] = city.roads.map((road) => ({ ...road }));
  const corridors: Corridor[] = city.corridors.map((corridor) => ({
    ...corridor,
    roadIds: [...corridor.roadIds],
  }));
  return { ...city, intersections, roads, corridors };
}

/**
 * Recomposes effective road conditions in the runtime city from BASE state
 * plus every ACTIVE incident. Closures force `closed`; crash capacities
 * compose to the most restrictive desired value and never fall below the
 * occupancy already resident on the road; everything else returns to base.
 * Called only while incidents are active (or on transitions).
 */
export function applyRuntimeConditions(
  runtimeCity: City,
  baseCity: City,
  activeRecords: readonly IncidentRecord[],
  occupancy: ReadonlyMap<RoadId, number>,
): void {
  const desiredCrashCapacity = new Map<RoadId, number>();
  const closedByIncident = new Set<RoadId>();
  for (const record of activeRecords) {
    if (record.kind === "close-road" || record.kind === "bridge-closed") {
      for (const roadId of record.roadIds) {
        closedByIncident.add(roadId);
      }
    } else if (record.kind === "crash") {
      for (const roadId of record.roadIds) {
        const base = baseCity.roads[roadId];
        const desired = base.capacity * INCIDENT_DEFAULTS.CRASH_CAPACITY_MULTIPLIER;
        const previous = desiredCrashCapacity.get(roadId);
        desiredCrashCapacity.set(roadId, previous === undefined ? desired : Math.min(previous, desired));
      }
    }
  }
  for (const road of runtimeCity.roads) {
    const base = baseCity.roads[road.id];
    road.closed = base.closed || closedByIncident.has(road.id);
    const crashDesired = desiredCrashCapacity.get(road.id);
    if (crashDesired === undefined) {
      road.capacity = base.capacity;
    } else {
      // A crash never shrinks capacity below the traffic already resident.
      road.capacity = Math.max(crashDesired, occupancy.get(road.id) ?? 0);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Physical segments, connectivity, centrality                          */
/* ------------------------------------------------------------------ */

/**
 * One PHYSICAL road segment: the forward road and (when present) its reverse,
 * resolved STRUCTURALLY by (from, to) — never by id arithmetic, because
 * fixtures and future imported cities need not pair ids.
 */
export interface PhysicalSegment {
  readonly key: string;
  readonly roadIds: readonly RoadId[];
  readonly kind: RoadKind;
  /**
   * Representative endpoints: `from`/`to` of the LOWEST-id road of the pair
   * (the segment is undirected; orientation is irrelevant to all consumers).
   */
  readonly from: IntersectionId;
  readonly to: IntersectionId;
  /** First (lowest) road id; the canonical sort key. */
  readonly roadId: RoadId;
}

/** All physical segments of a city, sorted by lowest road id. */
export function physicalSegments(city: City): PhysicalSegment[] {
  const byEndpoints = new Map<string, RoadId[]>();
  for (const road of city.roads) {
    const key = `${road.from}:${road.to}`;
    const list = byEndpoints.get(key) ?? [];
    list.push(road.id);
    byEndpoints.set(key, list);
  }
  const consumed = new Set<RoadId>();
  const segments: PhysicalSegment[] = [];
  for (const road of [...city.roads].sort((a, b) => a.id - b.id)) {
    if (consumed.has(road.id)) {
      continue;
    }
    const reverseKey = `${road.to}:${road.from}`;
    const candidates = (byEndpoints.get(reverseKey) ?? []).filter((id) => !consumed.has(id) && id !== road.id);
    const reverse = candidates.length > 0 ? Math.min(...candidates) : null;
    const roadIds = reverse === null ? [road.id] : [road.id, reverse].sort((a, b) => a - b);
    for (const id of roadIds) {
      consumed.add(id);
    }
    segments.push({
      key: roadIds.join(":"),
      roadIds,
      kind: road.kind,
      from: road.from,
      to: road.to,
      roadId: roadIds[0],
    });
  }
  return segments.sort((a, b) => a.roadId - b.roadId);
}

/**
 * Number of intersections reachable undirectedly from intersection 0 using
 * traversable (not closed, not additionally excluded) roads. Default
 * selections require closing a segment to leave this count unchanged.
 */
export function reachableIntersectionCount(
  city: City,
  excluded: ReadonlySet<RoadId> = new Set(),
): number {
  const adjacency = new Map<IntersectionId, IntersectionId[]>();
  for (const road of city.roads) {
    if (road.closed || excluded.has(road.id)) {
      continue;
    }
    const a = adjacency.get(road.from) ?? [];
    a.push(road.to);
    adjacency.set(road.from, a);
    const b = adjacency.get(road.to) ?? [];
    b.push(road.from);
    adjacency.set(road.to, b);
  }
  if (city.intersections.length === 0) {
    return 0;
  }
  const seen = new Set<IntersectionId>([0]);
  const stack: IntersectionId[] = [0];
  while (stack.length > 0) {
    const node = stack.pop() as IntersectionId;
    for (const next of adjacency.get(node) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen.size;
}

/**
 * Deterministic centrality proxy for bridge selection: the count of a bounded
 * evenly-spaced OD sample (up to 8x8 pairs) whose undirected shortest-hop
 * path uses the segment. Higher score = more central; computed only at
 * incident resolution time. Sanctioned "sampled betweenness over a bounded
 * deterministic OD set".
 */
export function bridgeCentralityScores(
  city: City,
  excluded: ReadonlySet<RoadId> = new Set(),
): Array<{ segment: PhysicalSegment; score: number }> {
  const segments = physicalSegments(city).filter((segment) => segment.kind === "bridge");
  if (segments.length === 0) {
    return [];
  }
  const count = city.intersections.length;
  const step = Math.max(1, Math.floor(count / 8));
  const sample: IntersectionId[] = [];
  for (let id = 0; id < count; id += step) {
    sample.push(id);
    if (sample.length >= 8) {
      break;
    }
  }
  const scores = new Map<string, number>(segments.map((segment) => [segment.key, 0]));

  const hopDistances = (from: IntersectionId): Map<IntersectionId, number> => {
    const distances = new Map<IntersectionId, number>([[from, 0]]);
    let frontier: IntersectionId[] = [from];
    let depth = 0;
    while (frontier.length > 0) {
      depth += 1;
      const next: IntersectionId[] = [];
      for (const node of frontier) {
        const intersection = city.intersections[node];
        for (const roadId of intersection.outgoing) {
          const road = city.roads[roadId];
          if (road.closed || excluded.has(roadId)) {
            continue;
          }
          if (!distances.has(road.to)) {
            distances.set(road.to, depth);
            next.push(road.to);
          }
        }
        for (const roadId of intersection.incoming) {
          const road = city.roads[roadId];
          if (road.closed || excluded.has(roadId)) {
            continue;
          }
          if (!distances.has(road.from)) {
            distances.set(road.from, depth);
            next.push(road.from);
          }
        }
      }
      frontier = next;
    }
    return distances;
  };

  for (const from of sample) {
    const distFrom = hopDistances(from);
    for (const to of sample) {
      if (from === to) {
        continue;
      }
      const total = distFrom.get(to);
      if (total === undefined) {
        continue;
      }
      const distTo = hopDistances(to);
      for (const segment of segments) {
        const a = segment.from;
        const b = segment.to;
        const onPath =
          (distFrom.get(a) ?? Infinity) + 1 + (distTo.get(b) ?? Infinity) === total ||
          (distFrom.get(b) ?? Infinity) + 1 + (distTo.get(a) ?? Infinity) === total;
        if (onPath) {
          scores.set(segment.key, (scores.get(segment.key) ?? 0) + 1);
        }
      }
    }
  }
  return segments.map((segment) => ({ segment, score: scores.get(segment.key) ?? 0 }));
}

/* ------------------------------------------------------------------ */
/* Target resolution (pure, per-incident streams)                       */
/* ------------------------------------------------------------------ */

/** True when every road of the segment is currently open. */
function segmentOpen(segment: PhysicalSegment, city: City): boolean {
  return segment.roadIds.every((roadId) => !city.roads[roadId].closed);
}

/**
 * Default close-road selection: a currently open physical segment whose
 * closure keeps the CURRENT effective network's reachable count unchanged.
 * Deterministic: candidates sorted by segment road id, drawn from the
 * incident stream. Returns null when no safe candidate exists.
 */
export function selectCloseRoadSegment(
  city: City,
  rng: Rng,
): PhysicalSegment | null {
  const baseline = reachableIntersectionCount(city);
  const candidates = physicalSegments(city).filter((segment) => {
    if (!segmentOpen(segment, city)) {
      return false;
    }
    return reachableIntersectionCount(city, new Set(segment.roadIds)) === baseline;
  });
  if (candidates.length === 0) {
    return null;
  }
  return candidates[rng.nextInt(0, candidates.length - 1)];
}

/**
 * Bridge selection: highest centrality score; ties (all equally central)
 * resolved deterministically from the incident stream by lowest segment id
 * order. Returns null when there are no open bridge segments at all.
 */
export function selectBridgeSegment(
  city: City,
  rng: Rng,
  allowDisconnect: boolean,
): PhysicalSegment | null {
  const segments = physicalSegments(city).filter(
    (segment) => segment.kind === "bridge" && segmentOpen(segment, city),
  );
  if (segments.length === 0) {
    return null;
  }
  const baseline = reachableIntersectionCount(city);
  const scored = bridgeCentralityScores(city).filter((entry) =>
    segments.some((segment) => segment.key === entry.segment.key),
  );
  const topScore = Math.max(...scored.map((entry) => entry.score));
  const top = scored
    .filter((entry) => entry.score === topScore)
    .map((entry) => entry.segment)
    .sort((a, b) => a.roadId - b.roadId);
  if (allowDisconnect) {
    return top[rng.nextInt(0, top.length - 1)];
  }
  const safe = top.filter(
    (segment) => reachableIntersectionCount(city, new Set(segment.roadIds)) === baseline,
  );
  if (safe.length === 0) {
    // Keep the guarantee: no safe central bridge ⇒ not applicable rather
    // than a silent disconnect.
    return null;
  }
  return safe[rng.nextInt(0, safe.length - 1)];
}

/** Crash target: explicit directed road, or a deterministic open-road draw. */
export function selectCrashTarget(
  city: City,
  rng: Rng,
  explicitTarget?: RoadId,
): RoadId | null {
  if (explicitTarget !== undefined) {
    return explicitTarget;
  }
  const candidates = city.roads
    .filter((road) => !road.closed)
    .map((road) => road.id)
    .sort((a, b) => a - b);
  if (candidates.length === 0) {
    return null;
  }
  return candidates[rng.nextInt(0, candidates.length - 1)];
}

export interface EventReleasePlan {
  readonly centerIntersectionId: IntersectionId;
  readonly neighborhood: IntersectionId[];
  readonly spawns: Array<{
    readonly timeMs: number;
    readonly type: VehicleType;
    readonly origin: IntersectionId;
    readonly destination: IntersectionId;
  }>;
}

/**
 * Event release: the center is drawn (incident stream) from the highest-degree
 * quartile of intersections (ties by id); origins concentrate in the center's
 * 1-hop neighborhood; destinations disperse over intersections OUTSIDE that
 * neighborhood; count is size-scaled (EVENT_RELEASE_COUNTS); spawn times are
 * exact multiples spreading the burst over EVENT_RELEASE_WINDOW_MS.
 */
export function planEventRelease(
  city: City,
  size: CitySize,
  rng: Rng,
  atMs: number,
  explicitCenter?: IntersectionId,
): EventReleasePlan | null {
  if (city.intersections.length < 2) {
    return null;
  }
  let center: IntersectionId;
  if (explicitCenter !== undefined) {
    center = explicitCenter;
  } else {
    const degree = (id: IntersectionId): number =>
      city.intersections[id].incoming.length + city.intersections[id].outgoing.length;
    const ranked = [...city.intersections]
      .sort((a, b) => degree(b.id) - degree(a.id) || a.id - b.id)
      .map((intersection) => intersection.id);
    const topCount = Math.max(1, Math.ceil(ranked.length / 4));
    const top = ranked.slice(0, topCount).sort((a, b) => a - b);
    center = top[rng.nextInt(0, top.length - 1)];
  }
  const neighborhood = new Set<IntersectionId>([center]);
  for (const roadId of city.intersections[center].outgoing) {
    neighborhood.add(city.roads[roadId].to);
  }
  for (const roadId of city.intersections[center].incoming) {
    neighborhood.add(city.roads[roadId].from);
  }
  const originPool = [...neighborhood].sort((a, b) => a - b);
  let destinationPool = city.intersections
    .map((intersection) => intersection.id)
    .filter((id) => !neighborhood.has(id));
  if (destinationPool.length === 0) {
    destinationPool = city.intersections
      .map((intersection) => intersection.id)
      .filter((id) => id !== center);
  }
  destinationPool.sort((a, b) => a - b);
  const count = EVENT_RELEASE_COUNTS[size];
  const mix = EVENT_RELEASE_TYPE_MIX;
  const spawns: EventReleasePlan["spawns"] = [];
  for (let i = 0; i < count; i += 1) {
    const roll = rng.nextFloat();
    const type: VehicleType =
      roll < mix.car ? "car" : roll < mix.car + mix.truck ? "truck" : "bicycle";
    const origin = originPool[rng.nextInt(0, originPool.length - 1)];
    let destination = destinationPool[rng.nextInt(0, destinationPool.length - 1)];
    if (destination === origin) {
      const alternative = destinationPool.find((id) => id !== origin);
      if (alternative === undefined) {
        continue; // degenerate tiny city: skip this spawn
      }
      destination = alternative;
    }
    spawns.push({
      timeMs: atMs + Math.round((i * INCIDENT_DEFAULTS.EVENT_RELEASE_WINDOW_MS) / count),
      type,
      origin,
      destination,
    });
  }
  return { centerIntersectionId: center, neighborhood: originPool, spawns };
}

/**
 * +5x traffic burst: for every BASE schedule event in [atMs, atMs + durationMs)
 * inject four deterministic copies (same time, type, origin, destination).
 * Operates on the base schedule only — injections never re-amplify.
 */
export function amplifyTrafficBurst(
  baseSpawns: readonly { timeMs: number; type: VehicleType; origin: IntersectionId; destination: IntersectionId }[],
  atMs: number,
  durationMs: number,
): Array<{ timeMs: number; type: VehicleType; origin: IntersectionId; destination: IntersectionId }> {
  const copies: Array<{
    timeMs: number;
    type: VehicleType;
    origin: IntersectionId;
    destination: IntersectionId;
  }> = [];
  for (const event of baseSpawns) {
    if (event.timeMs < atMs || event.timeMs >= atMs + durationMs) {
      continue;
    }
    for (let copy = 0; copy < 4; copy += 1) {
      copies.push({ ...event });
    }
  }
  return copies;
}

/* ------------------------------------------------------------------ */
/* Script validation / record construction                              */
/* ------------------------------------------------------------------ */

/** Structural problems with a script; empty list means acceptable. */
export function validateIncidentScript(
  city: City,
  script: readonly IncidentScriptEntry[],
): string[] {
  const problems: string[] = [];
  script.forEach((entry, sequence) => {
    const where = `script[${sequence}]`;
    if (!Number.isFinite(entry.atMs) || entry.atMs < 0) {
      problems.push(`${where}: atMs must be finite and >= 0`);
    }
    if (!INCIDENT_KINDS.includes(entry.kind)) {
      problems.push(`${where}: unknown kind ${String(entry.kind)}`);
      return;
    }
    if (entry.durationMs !== undefined) {
      if (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0) {
        problems.push(`${where}: durationMs must be finite and positive`);
      }
    }
    if (entry.targetRoadId !== undefined) {
      if (entry.kind === "traffic-burst" || entry.kind === "event-release") {
        problems.push(`${where}: kind ${entry.kind} does not accept targetRoadId`);
      } else if (!Number.isInteger(entry.targetRoadId) || !city.roads[entry.targetRoadId]) {
        problems.push(`${where}: targetRoadId ${entry.targetRoadId} is not a road of this city`);
      } else if (entry.kind === "bridge-closed" && city.roads[entry.targetRoadId].kind !== "bridge") {
        problems.push(`${where}: targetRoadId ${entry.targetRoadId} is not a bridge`);
      }
    }
    if (entry.centerIntersectionId !== undefined) {
      if (entry.kind !== "event-release") {
        problems.push(`${where}: only event-release accepts centerIntersectionId`);
      } else if (
        !Number.isInteger(entry.centerIntersectionId) ||
        !city.intersections[entry.centerIntersectionId]
      ) {
        problems.push(
          `${where}: centerIntersectionId ${entry.centerIntersectionId} is not an intersection of this city`,
        );
      }
    }
    if (entry.allowDisconnect !== undefined && typeof entry.allowDisconnect !== "boolean") {
      problems.push(`${where}: allowDisconnect must be a boolean`);
    }
    if (
      entry.allowDisconnect === true &&
      entry.kind !== "close-road" &&
      entry.kind !== "bridge-closed"
    ) {
      problems.push(`${where}: allowDisconnect only applies to close-road / bridge-closed`);
    }
  });
  return problems;
}

/**
 * Builds the runtime records: entries sorted explicitly by (atMs, original
 * sequence) — no reliance on Array.sort stability — with per-record streams
 * derived from the incident root.
 */
export function createIncidentRuntime(
  city: City,
  config: IncidentConfig | undefined,
): IncidentRuntime {
  if (!config) {
    return { records: [], nextIncidentId: 0, injectionSequence: 0, conditionsDirty: false };
  }
  const ordered = config.script
    .map((entry, sequence) => ({ entry, sequence }))
    .sort((a, b) => a.entry.atMs - b.entry.atMs || a.sequence - b.sequence);
  const records: IncidentRecord[] = ordered.map(({ entry, sequence }) => ({
    id: sequence,
    kind: entry.kind,
    scheduledAtMs: entry.atMs,
    activatedAtMs: null,
    expiresAtMs: null,
    status: "pending",
    roadIds: [],
    eventCenterIntersectionId: null,
    allowDisconnect: entry.allowDisconnect ?? false,
    injectedSpawnCount: 0,
    affectedVehicleCount: 0,
    successfulReroutes: 0,
    failedReroutes: 0,
  }));
  return {
    records,
    nextIncidentId: config.script.length,
    injectionSequence: 0,
    conditionsDirty: false,
  };
}

/** The private stream of one record: `fork("incidents").fork(seq:kind)`. */
export function incidentStreamFor(config: IncidentConfig, record: IncidentRecord): Rng {
  return createRng(config.seed).fork("incidents").fork(`${record.id}:${record.kind}`);
}

/** Default duration of a temporary incident kind. */
export function defaultDurationMs(kind: IncidentKind): number | null {
  switch (kind) {
    case "traffic-burst":
      return INCIDENT_DEFAULTS.TRAFFIC_BURST_DURATION_MS;
    case "crash":
      return INCIDENT_DEFAULTS.CRASH_DURATION_MS;
    case "close-road":
      return INCIDENT_DEFAULTS.CLOSE_ROAD_DURATION_MS;
    case "bridge-closed":
      return INCIDENT_DEFAULTS.BRIDGE_CLOSED_DURATION_MS;
    case "event-release":
      return INCIDENT_DEFAULTS.EVENT_RELEASE_WINDOW_MS;
  }
}
