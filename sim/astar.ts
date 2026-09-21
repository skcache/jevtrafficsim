/**
 * Deterministic A* over the directed road graph (PRD §9).
 *
 * ## Cost model
 *
 *   free-flow travel time  = road.length / effectiveSpeed
 *   effectiveSpeed         = road.speedLimit   (Task 04: no acceleration,
 *                            signals, vehicle classes, or lane behavior)
 *   edge cost              = road.length / (road.speedLimit * speedFactor)
 *
 * The speed factor is the AUTHORITATIVE road traffic state (sim/road-traffic):
 * the same number that slows vehicles and paints the map. There is no separate
 * congestion pricing any more — occupancy was a proxy for flow, and pricing a
 * road by a proxy let the router disagree with the physics. Factors are clamped
 * into [MIN_TRAFFIC_SPEED_FACTOR, 1], so edge costs are always finite and positive.
 *
 * ## Heuristic (units matter)
 *
 *   h(n) = euclideanDistance(n, goal) / maxNetworkSpeed
 *
 * maxNetworkSpeed is the fastest legal speed in the city, so h is a lower
 * bound on remaining FREE-FLOW travel time: any path is at least as long as
 * the straight line (triangle inequality), and no road goes faster than the
 * max. Congestion only raises edge costs, so the free-flow bound stays
 * admissible with the congestion penalty applied. h(goal) === 0.
 *
 * ## Deterministic tie policy
 *
 * Open-set entries pop in this order:
 *   1. lowest f = g + h
 *   2. lowest h
 *   3. lowest intersection id
 *   4. lowest insertion sequence (FIFO for fully-tied entries)
 * Equal-g relaxations keep the first-discovered predecessor. Combined with
 * array-ordered neighbor iteration, identical city + options always yield
 * the identical route; no Map/object ordering is relied on for correctness.
 *
 * ## No-route semantics
 *
 * Unreachable destinations return { found: false } — never an exception.
 * Invalid ids are programmer errors and throw RangeError. Closed roads are
 * never traversed, and the router never mutates the city.
 */
import { MIN_TRAFFIC_SPEED_FACTOR } from "./config";
import { BinaryHeap } from "./heap";
import type { City, IntersectionId, Road, RoadId } from "./types";

/** Current vehicle count per directed road: a read-only map or a callback. */
export type SpeedFactorSource = ReadonlyMap<RoadId, number> | ((roadId: RoadId) => number);

export interface RouteOptions {
  /**
   * Authoritative road speed factor source; missing entries count as free
   * flow. Default: all free.
   */
  speedFactor?: SpeedFactorSource;
}

export interface RouteFound {
  found: true;
  /** Ordered directed road ids from start to goal (empty when start === goal). */
  roadIds: RoadId[];
  /** Ordered intersections along the route: [start, ...each road's `to`]. */
  intersectionIds: IntersectionId[];
  /** Total travel-time cost in the units of the cost model above. */
  cost: number;
}

export interface RouteNotFound {
  found: false;
}

export type RouteResult = RouteFound | RouteNotFound;

interface OpenEntry {
  node: IntersectionId;
  g: number;
  h: number;
  f: number;
  seq: number;
}

function compareEntries(a: OpenEntry, b: OpenEntry): number {
  if (a.f !== b.f) {
    return a.f - b.f;
  }
  if (a.h !== b.h) {
    return a.h - b.h;
  }
  if (a.node !== b.node) {
    return a.node - b.node;
  }
  return a.seq - b.seq;
}

function isNodeId(city: City, id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < city.intersections.length;
}

function maxNetworkSpeed(city: City): number {
  let max = 0;
  for (const road of city.roads) {
    if (road.speedLimit > max) {
      max = road.speedLimit;
    }
  }
  return max > 0 ? max : 1; // defensive; only relevant once any road exists
}

function speedFactorAt(
  source: SpeedFactorSource | undefined,
  roadId: RoadId,
): number {
  if (source === undefined) {
    return 1;
  }
  const raw = typeof source === "function" ? source(roadId) : (source.get(roadId) ?? 1);
  // Nonsense reads as free flow: a bad value must never price a road as jammed.
  if (!Number.isFinite(raw) || raw <= 0) {
    return 1;
  }
  return Math.max(MIN_TRAFFIC_SPEED_FACTOR, Math.min(1, raw));
}


/** Edge cost per the cost model; exported so callers can recompute costs. */
export function edgeTravelCost(road: Road, speedFactor: number): number {
  const factor =
    Number.isFinite(speedFactor) && speedFactor > 0
      ? Math.max(MIN_TRAFFIC_SPEED_FACTOR, Math.min(1, speedFactor))
      : 1;
  const freeFlow = road.length / road.speedLimit;
  return freeFlow / factor;
}

/** Total cost of an explicit road path under the given options. */
export function computePathCost(
  city: City,
  roadIds: readonly RoadId[],
  options: RouteOptions = {},
): number {
  let total = 0;
  for (const roadId of roadIds) {
    const road = city.roads[roadId];
    if (!road) {
      throw new RangeError(`unknown road id ${roadId}`);
    }
    total += edgeTravelCost(road, speedFactorAt(options.speedFactor, roadId));
  }
  return total;
}

function straightLineTime(
  city: City,
  from: IntersectionId,
  to: IntersectionId,
  maxSpeed: number,
): number {
  const a = city.intersections[from];
  const b = city.intersections[to];
  return Math.hypot(a.x - b.x, a.y - b.y) / maxSpeed;
}

/** Admissible free-flow lower bound: euclidean distance / max legal speed. */
export function routeHeuristic(
  city: City,
  from: IntersectionId,
  to: IntersectionId,
): number {
  if (!isNodeId(city, from) || !isNodeId(city, to)) {
    throw new RangeError(
      `routeHeuristic requires valid intersection ids, received ${from} and ${to}`,
    );
  }
  return straightLineTime(city, from, to, maxNetworkSpeed(city));
}

export function findRoute(
  city: City,
  from: IntersectionId,
  to: IntersectionId,
  options: RouteOptions = {},
): RouteResult {
  if (!isNodeId(city, from)) {
    throw new RangeError(`findRoute: invalid start intersection ${from}`);
  }
  if (!isNodeId(city, to)) {
    throw new RangeError(`findRoute: invalid goal intersection ${to}`);
  }
  if (from === to) {
    return { found: true, roadIds: [], intersectionIds: [from], cost: 0 };
  }

  const maxSpeed = maxNetworkSpeed(city);
  const bestG = new Map<IntersectionId, number>();
  const cameFrom = new Map<IntersectionId, RoadId>();
  const open = new BinaryHeap<OpenEntry>(compareEntries);
  let sequence = 0;

  const push = (node: IntersectionId, g: number): void => {
    const h = straightLineTime(city, node, to, maxSpeed);
    open.push({ node, g, h, f: g + h, seq: sequence });
    sequence += 1;
  };

  bestG.set(from, 0);
  push(from, 0);

  while (!open.isEmpty) {
    const current = open.pop() as OpenEntry;
    const known = bestG.get(current.node);
    if (known === undefined || current.g > known) {
      continue; // stale entry superseded by a cheaper path
    }
    if (current.node === to) {
      const roadIds: RoadId[] = [];
      let node: IntersectionId = to;
      while (node !== from) {
        const roadId = cameFrom.get(node);
        if (roadId === undefined) {
          // Unreachable: every node except `from` is pushed with a predecessor.
          throw new Error("findRoute: broken predecessor chain");
        }
        roadIds.push(roadId);
        node = city.roads[roadId].from;
      }
      roadIds.reverse();
      return {
        found: true,
        roadIds,
        intersectionIds: [from, ...roadIds.map((id) => city.roads[id].to)],
        cost: current.g,
      };
    }
    for (const roadId of city.intersections[current.node].outgoing) {
      const road = city.roads[roadId];
      if (!road || road.closed) {
        continue;
      }
      const cost = edgeTravelCost(road, speedFactorAt(options.speedFactor, roadId));
      const gNew = current.g + cost;
      const previous = bestG.get(road.to);
      if (previous === undefined || gNew < previous) {
        bestG.set(road.to, gNew);
        cameFrom.set(road.to, roadId);
        push(road.to, gNew);
      }
    }
  }
  return { found: false };
}
