/**
 * Minimal graph utilities over a generated City (PRD §7.1: adjacency lists,
 * no graph framework).
 *
 * The road network is directed: every traversable road segment is its own
 * Road record, and Intersection.incoming/outgoing already carry the
 * adjacency lists. Helpers here never duplicate graph state — they read the
 * city's own structures. Closed roads are treated as not traversable.
 */
import type { City, IntersectionId, Road } from "./types";

/** Distinct neighbor intersection ids of `id`, sorted ascending. */
export function neighbors(city: City, id: IntersectionId): IntersectionId[] {
  const found = new Set<IntersectionId>();
  for (const roadId of city.intersections[id]?.outgoing ?? []) {
    const road = city.roads[roadId];
    if (road) {
      found.add(road.to);
    }
  }
  return [...found].sort((a, b) => a - b);
}

/** Degree = number of distinct adjacent intersections. */
export function degree(city: City, id: IntersectionId): number {
  return neighbors(city, id).length;
}

/** The directed road from `from` to `to`, if one exists. */
export function findRoad(
  city: City,
  from: IntersectionId,
  to: IntersectionId,
): Road | undefined {
  for (const roadId of city.intersections[from]?.outgoing ?? []) {
    const road = city.roads[roadId];
    if (road && road.to === to) {
      return road;
    }
  }
  return undefined;
}

/** Intersections reachable from `start` by following open (not closed) roads. */
export function reachableFrom(city: City, start: IntersectionId): Set<IntersectionId> {
  const seen = new Set<IntersectionId>([start]);
  const queue: IntersectionId[] = [start];
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    for (const roadId of city.intersections[current]?.outgoing ?? []) {
      const road = city.roads[roadId];
      if (!road || road.closed || seen.has(road.to)) {
        continue;
      }
      seen.add(road.to);
      queue.push(road.to);
    }
  }
  return seen;
}

/** True when every intersection is reachable from intersection 0. */
export function isConnected(city: City): boolean {
  if (city.intersections.length === 0) {
    return true;
  }
  return reachableFrom(city, 0).size === city.intersections.length;
}

/** Structural validation. Returns a list of problems; empty means valid. */
export function validateCity(city: City): string[] {
  const problems: string[] = [];
  const nodeCount = city.intersections.length;

  for (const node of city.intersections) {
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      problems.push(`intersections[${node.id}]: coordinates must be finite`);
    }
    if (!Number.isInteger(node.regionId) || node.regionId < 0) {
      problems.push(`intersections[${node.id}]: regionId must be a non-negative integer`);
    }
  }

  const seenDirected = new Set<string>();
  for (const road of city.roads) {
    const label = `roads[${road.id}]`;
    const fromValid =
      Number.isInteger(road.from) && road.from >= 0 && road.from < nodeCount;
    const toValid = Number.isInteger(road.to) && road.to >= 0 && road.to < nodeCount;
    if (!fromValid || !toValid) {
      problems.push(`${label}: endpoint missing (from=${road.from}, to=${road.to})`);
      continue;
    }
    if (road.from === road.to) {
      problems.push(`${label}: self-loop`);
    }
    if (!Number.isFinite(road.length) || road.length <= 0) {
      problems.push(`${label}: length must be a finite positive number`);
    }
    const key = `${road.from}>${road.to}`;
    if (seenDirected.has(key)) {
      problems.push(`${label}: duplicate directed road ${key}`);
    }
    seenDirected.add(key);
  }

  if (problems.length === 0 && !isConnected(city)) {
    problems.push("city graph is not connected");
  }
  return problems;
}
