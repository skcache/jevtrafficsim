/**
 * Deterministic region / corridor partition (Task 09, PRD §12.4–§12.5).
 *
 * Derived purely from metadata the city already carries: `intersection.regionId`
 * (Task 03's grid-of-regions assignment) and `city.corridors` (arterial /
 * highway / diagonal named corridors). Nothing is regenerated, no randomness
 * is introduced, and the City is never mutated — the partition is a set of
 * stable, sorted, JSON-serializable structures that hierarchical policy
 * (the Adaptive controller today, Jev later) reads as a read-only map of the
 * world.
 *
 * ## Region semantics
 *
 * - `internalRoadIds`     — directed roads with BOTH endpoints in the region;
 * - `outgoingBoundaryRoadIds` — roads leaving the region (from inside, to outside);
 * - `incomingBoundaryRoadIds` — roads entering the region (from outside, to inside);
 * - `corridorIds`         — every corridor that touches the region (at least
 *   one of its roads has an endpoint inside the region).
 *
 * ## Corridor semantics
 *
 * A corridor preserves its original id, kind and road ids; `regionIds` lists
 * every region touched by any endpoint of any of its roads.
 *
 * ## Determinism
 *
 * Every array is sorted ascending, every map is inserted in ascending key
 * order, and repeated construction from the same city is byte-identical.
 * The partition is static: build it once per engine, never per tick.
 */
import type {
  City,
  CorridorKind,
  IntersectionId,
  RoadId,
} from "./types";

export interface RegionPartition {
  readonly regionId: number;
  readonly intersectionIds: IntersectionId[];
  readonly internalRoadIds: RoadId[];
  readonly outgoingBoundaryRoadIds: RoadId[];
  readonly incomingBoundaryRoadIds: RoadId[];
  readonly corridorIds: number[];
}

export interface CorridorPartition {
  readonly corridorId: number;
  readonly kind: CorridorKind;
  readonly roadIds: RoadId[];
  readonly regionIds: number[];
}

export interface CityPartition {
  readonly regions: RegionPartition[];
  readonly corridors: CorridorPartition[];
  /** Intersection -> region lookup. */
  readonly intersectionRegion: ReadonlyMap<IntersectionId, number>;
  /** Road -> corridor ids containing it, ascending. */
  readonly roadCorridors: ReadonlyMap<RoadId, number[]>;
}

function sortedUnique(values: Iterable<number>): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function pushTo<T>(map: Map<number, T[]>, key: number, value: T): void {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

/**
 * Builds the partition. Pure and deterministic: identical cities produce
 * byte-identical partitions (see tests for the serialization check).
 */
export function buildCityPartition(city: City): CityPartition {
  // Intersection -> region, and region -> intersections (both ascending).
  const intersectionRegion = new Map<IntersectionId, number>();
  const regionIntersections = new Map<number, IntersectionId[]>();
  for (const intersection of [...city.intersections].sort((a, b) => a.id - b.id)) {
    intersectionRegion.set(intersection.id, intersection.regionId);
    const list = regionIntersections.get(intersection.regionId) ?? [];
    list.push(intersection.id);
    regionIntersections.set(intersection.regionId, list);
  }

  // Road classification by endpoint regions (roads ascending).
  const internal = new Map<number, RoadId[]>();
  const outgoing = new Map<number, RoadId[]>();
  const incoming = new Map<number, RoadId[]>();
  for (const road of [...city.roads].sort((a, b) => a.id - b.id)) {
    const fromRegion = intersectionRegion.get(road.from);
    const toRegion = intersectionRegion.get(road.to);
    if (fromRegion === undefined || toRegion === undefined) {
      continue; // validatePartition reports dangling endpoints
    }
    if (fromRegion === toRegion) {
      pushTo(internal, fromRegion, road.id);
    } else {
      pushTo(outgoing, fromRegion, road.id);
      pushTo(incoming, toRegion, road.id);
    }
  }

  // Corridors: preserve id/kind/roads; derive touched regions from endpoints.
  const roadCorridors = new Map<RoadId, number[]>();
  const corridorRegionIds = new Map<number, number[]>();
  for (const corridor of [...city.corridors].sort((a, b) => a.id - b.id)) {
    const regions: number[] = [];
    for (const roadId of corridor.roadIds) {
      const road = city.roads[roadId];
      if (!road) {
        continue; // validatePartition reports unknown road ids
      }
      const list = roadCorridors.get(roadId) ?? [];
      list.push(corridor.id);
      roadCorridors.set(roadId, list);
      const fromRegion = intersectionRegion.get(road.from);
      const toRegion = intersectionRegion.get(road.to);
      if (fromRegion !== undefined) {
        regions.push(fromRegion);
      }
      if (toRegion !== undefined) {
        regions.push(toRegion);
      }
    }
    corridorRegionIds.set(corridor.id, sortedUnique(regions));
  }

  // Region -> corridors touching it (from corridor endpoint membership).
  const regionCorridors = new Map<number, number[]>();
  for (const [corridorId, regionIds] of [...corridorRegionIds.entries()].sort((a, b) => a[0] - b[0])) {
    for (const regionId of regionIds) {
      const list = regionCorridors.get(regionId) ?? [];
      list.push(corridorId);
      regionCorridors.set(regionId, list);
    }
  }

  const regions: RegionPartition[] = [...regionIntersections.keys()]
    .sort((a, b) => a - b)
    .map((regionId) => ({
      regionId,
      intersectionIds: [...(regionIntersections.get(regionId) ?? [])],
      internalRoadIds: [...(internal.get(regionId) ?? [])],
      outgoingBoundaryRoadIds: [...(outgoing.get(regionId) ?? [])],
      incomingBoundaryRoadIds: [...(incoming.get(regionId) ?? [])],
      corridorIds: [...(regionCorridors.get(regionId) ?? [])].sort((a, b) => a - b),
    }));

  const corridors: CorridorPartition[] = [...city.corridors]
    .sort((a, b) => a.id - b.id)
    .map((corridor) => ({
      corridorId: corridor.id,
      kind: corridor.kind,
      roadIds: [...corridor.roadIds].sort((a, b) => a - b),
      regionIds: [...(corridorRegionIds.get(corridor.id) ?? [])],
    }));

  // Road -> corridors with sorted, de-duplicated values.
  const sortedCorridorMap = new Map<RoadId, number[]>();
  for (const [roadId, corridorIds] of [...roadCorridors.entries()].sort((a, b) => a[0] - b[0])) {
    sortedCorridorMap.set(roadId, sortedUnique(corridorIds));
  }

  return { regions, corridors, intersectionRegion, roadCorridors: sortedCorridorMap };
}

/**
 * Consistency checks on a partition built from `city`; empty list means valid.
 * Every intersection belongs to exactly one region; every road is classified
 * exactly once (internal, outgoing or incoming) or reported; corridor ids and
 * road ids are valid; every map value agrees with the region/corridor lists.
 */
export function validatePartition(city: City, partition: CityPartition): string[] {
  const problems: string[] = [];
  const seenIntersections = new Map<IntersectionId, number>();
  // Every (region, kind) entry a road carries: internal roads carry exactly
  // one, boundary roads one per side (outgoing of A, incoming of B).
  const roadEntries = new Map<RoadId, string[]>();
  for (const region of partition.regions) {
    for (const intersectionId of region.intersectionIds) {
      const intersection = city.intersections[intersectionId];
      if (!intersection) {
        problems.push(`region ${region.regionId} lists unknown intersection ${intersectionId}`);
        continue;
      }
      if (intersection.regionId !== region.regionId) {
        problems.push(
          `intersection ${intersectionId} is in region ${intersection.regionId} but listed under ${region.regionId}`,
        );
      }
      if (seenIntersections.has(intersectionId)) {
        problems.push(`intersection ${intersectionId} appears in multiple regions`);
      }
      seenIntersections.set(intersectionId, region.regionId);
    }
    const checkRoad = (
      roadId: RoadId,
      kind: string,
      rule: (fromRegion: number, toRegion: number) => boolean,
    ): void => {
      const road = city.roads[roadId];
      if (!road) {
        problems.push(`region ${region.regionId} ${kind} lists unknown road ${roadId}`);
        return;
      }
      const entryKey = `${region.regionId}:${kind}`;
      const entries = roadEntries.get(roadId) ?? [];
      if (entries.includes(entryKey)) {
        problems.push(`road ${roadId} listed twice as ${kind} of region ${region.regionId}`);
      }
      entries.push(entryKey);
      roadEntries.set(roadId, entries);
      const fromRegion = city.intersections[road.from].regionId;
      const toRegion = city.intersections[road.to].regionId;
      if (!rule(fromRegion, toRegion)) {
        problems.push(
          `road ${roadId} is ${kind} of region ${region.regionId} but runs ${fromRegion} -> ${toRegion}`,
        );
      }
    };
    for (const roadId of region.internalRoadIds) {
      checkRoad(roadId, "internal", (from, to) => from === region.regionId && to === region.regionId);
    }
    for (const roadId of region.outgoingBoundaryRoadIds) {
      checkRoad(roadId, "outgoing boundary", (from, to) => from === region.regionId && to !== region.regionId);
    }
    for (const roadId of region.incomingBoundaryRoadIds) {
      checkRoad(roadId, "incoming boundary", (from, to) => to === region.regionId && from !== region.regionId);
    }
  }
  for (const intersection of city.intersections) {
    if (!partition.intersectionRegion.has(intersection.id)) {
      problems.push(`intersection ${intersection.id} missing from intersectionRegion`);
    } else if (partition.intersectionRegion.get(intersection.id) !== intersection.regionId) {
      problems.push(`intersectionRegion[${intersection.id}] disagrees with city metadata`);
    }
    if (!seenIntersections.has(intersection.id)) {
      problems.push(`intersection ${intersection.id} belongs to no region`);
    }
  }
  for (const road of city.roads) {
    if (!roadEntries.has(road.id)) {
      problems.push(`road ${road.id} is classified in no region`);
    }
    const corridors = partition.roadCorridors.get(road.id);
    if (corridors) {
      for (let i = 1; i < corridors.length; i += 1) {
        if (corridors[i] <= corridors[i - 1]) {
          problems.push(`roadCorridors[${road.id}] is not strictly ascending`);
          break;
        }
      }
    }
  }
  for (const corridor of partition.corridors) {
    if (!city.corridors.some((candidate) => candidate.id === corridor.corridorId)) {
      problems.push(`unknown corridor ${corridor.corridorId}`);
      continue;
    }
    for (const roadId of corridor.roadIds) {
      if (!city.roads[roadId]) {
        problems.push(`corridor ${corridor.corridorId} lists unknown road ${roadId}`);
      }
    }
    const corridors = partition.roadCorridors;
    for (const roadId of corridor.roadIds) {
      const list = corridors.get(roadId) ?? [];
      if (!list.includes(corridor.corridorId)) {
        problems.push(`roadCorridors[${roadId}] is missing corridor ${corridor.corridorId}`);
      }
    }
  }
  return problems;
}
