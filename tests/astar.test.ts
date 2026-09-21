import { MIN_TRAFFIC_SPEED_FACTOR } from "@/sim/config";
import { describe, expect, it } from "vitest";
import { computePathCost, findRoute, routeHeuristic } from "@/sim/astar";
import type { City, Intersection, Road } from "@/sim/types";

function node(id: number, x: number, y: number): Intersection {
  return {
    id,
    x,
    y,
    incoming: [],
    outgoing: [],
    control: "uncontrolled",
    regionId: 0,
  };
}

function link(
  partial: { intersections: Intersection[]; roads: Road[] },
  a: number,
  b: number,
  length: number,
  speedLimit = 10,
): void {
  for (const [from, to] of [
    [a, b],
    [b, a],
  ] as const) {
    const id = partial.roads.length;
    partial.roads.push({
      id,
      from,
      to,
      length,
      lanes: 1,
      speedLimit,
      capacity: 4,
      kind: "local",
      closed: false,
    });
    partial.intersections[from].outgoing.push(id);
    partial.intersections[to].incoming.push(id);
  }
}

/**
 * Diamond fixture (positions match geometry so the heuristic is sane):
 *   0 -> 1 -> 3: cost 2 (10+10 length at speed 10)  <- free-flow best
 *   0 -> 2 -> 3: cost 3 (15+15)
 *   0 -> 3     : cost 4 (direct, 40)
 * Node 4 is isolated. Road ids: link order 0-1, 1-3, 0-2, 2-3, 0-3.
 */
function makeDiamondCity(): City {
  const partial = {
    intersections: [
      node(0, 0, 0),
      node(1, 10, 0),
      node(2, 0, 10),
      node(3, 10, 10),
      node(4, 100, 100),
    ],
    roads: [] as Road[],
  };
  link(partial, 0, 1, 10);
  link(partial, 1, 3, 10);
  link(partial, 0, 2, 15);
  link(partial, 2, 3, 15);
  link(partial, 0, 3, 40);
  return {
    size: "small",
    seed: 0,
    gridWidth: 2,
    gridHeight: 2,
    intersections: partial.intersections,
    roads: partial.roads,
    corridors: [],
  };
}

// Road ids of the two "fast" edges: 0 = 0->1, 2 = 1->3.
const FAST_EDGES = [0, 2] as const;
// Road ids of the medium path: 4 = 0->2, 6 = 2->3.
const MEDIUM_PATH = [4, 6] as const;

describe("route model edge cases", () => {
  it("returns an empty zero-cost route when start equals goal", () => {
    const city = makeDiamondCity();
    const route = findRoute(city, 3, 3);
    expect(route).toEqual({
      found: true,
      roadIds: [],
      intersectionIds: [3],
      cost: 0,
    });
  });

  it("returns an explicit no-route result for unreachable destinations", () => {
    const city = makeDiamondCity();
    expect(findRoute(city, 0, 4)).toEqual({ found: false });
  });

  it("returns no-route when closures disconnect the destination", () => {
    const city = makeDiamondCity();
    const closed: City = {
      ...city,
      roads: city.roads.map((road) =>
        road.id <= 8 && road.from === 0 ? { ...road, closed: true } : road,
      ),
    };
    expect(findRoute(closed, 0, 3)).toEqual({ found: false });
  });

  it("rejects invalid intersection ids with RangeError", () => {
    const city = makeDiamondCity();
    expect(() => findRoute(city, -1, 3)).toThrow(RangeError);
    expect(() => findRoute(city, 0, 99)).toThrow(RangeError);
    expect(() => findRoute(city, 0.5, 3)).toThrow(RangeError);
    expect(() => routeHeuristic(city, 0, 99)).toThrow(RangeError);
    expect(() => computePathCost(city, [999])).toThrow(RangeError);
  });
});

describe("A* correctness and optimality", () => {
  it("finds the obvious free-flow optimum on the diamond", () => {
    const city = makeDiamondCity();
    const route = findRoute(city, 0, 3);
    expect(route.found).toBe(true);
    if (!route.found) return;
    expect(route.roadIds).toEqual([0, 2]);
    expect(route.intersectionIds).toEqual([0, 1, 3]);
    expect(route.cost).toBeCloseTo(2, 10);
  });

  it("reports a total cost matching the edge-cost calculation", () => {
    const city = makeDiamondCity();
    const route = findRoute(city, 0, 3);
    expect(route.found).toBe(true);
    if (!route.found) return;
    expect(route.cost).toBe(computePathCost(city, route.roadIds));
  });

  it("produces a continuous directed path", () => {
    const city = makeDiamondCity();
    const route = findRoute(city, 0, 3);
    expect(route.found).toBe(true);
    if (!route.found) return;
    expect(city.roads[route.roadIds[0]].from).toBe(0);
    for (let i = 1; i < route.roadIds.length; i += 1) {
      expect(city.roads[route.roadIds[i]].from).toBe(
        city.roads[route.roadIds[i - 1]].to,
      );
    }
    const last = city.roads[route.roadIds[route.roadIds.length - 1]];
    expect(last.to).toBe(3);
  });
});

describe("heuristic sanity", () => {
  it("is zero at the goal", () => {
    expect(routeHeuristic(makeDiamondCity(), 3, 3)).toBe(0);
  });

  it("never exceeds the known free-flow shortest cost (compatible units)", () => {
    const city = makeDiamondCity();
    for (const from of [0, 1, 2]) {
      const route = findRoute(city, from, 3);
      expect(route.found).toBe(true);
      if (!route.found) continue;
      expect(routeHeuristic(city, from, 3)).toBeLessThanOrEqual(route.cost);
    }
    // Exact unit check: node 1 -> 3 is a straight 10/10 -> exactly 1.
    expect(routeHeuristic(city, 1, 3)).toBeCloseTo(1, 10);
  });
});

describe("closures", () => {
  it("never traverses a closed edge and reroutes when an alternative exists", () => {
    const city = makeDiamondCity();
    const closed: City = {
      ...city,
      roads: city.roads.map((road) =>
        road.id === FAST_EDGES[0] ? { ...road, closed: true } : road,
      ),
    };
    const route = findRoute(closed, 0, 3);
    expect(route.found).toBe(true);
    if (!route.found) return;
    expect(route.roadIds).not.toContain(FAST_EDGES[0]);
    expect(route.roadIds).toEqual([...MEDIUM_PATH]);
    for (const roadId of route.roadIds) {
      expect(closed.roads[roadId].closed).toBe(false);
    }
  });
});

describe("traffic-aware routing", () => {
  // Cost is travel time at the AUTHORITATIVE traffic speed — the same factor
  // that slows vehicles and paints the map. There is no separate occupancy
  // pricing any more: pricing a road by a proxy let the router disagree with
  // the physics it was supposed to reflect.
  it("reproduces free-flow routing when every factor is free", () => {
    const city = makeDiamondCity();
    const base = findRoute(city, 0, 3);
    const allFree = findRoute(city, 0, 3, { speedFactor: new Map() });
    expect(base.found && allFree.found).toBe(true);
    if (!base.found || !allFree.found) return;
    expect(allFree.roadIds).toEqual(base.roadIds);
    expect(allFree.cost).toBeCloseTo(base.cost, 9);
  });

  it("switches routes when the fast path is actually slow", () => {
    const city = makeDiamondCity();
    // The fast path is jammed: 0.2 of free-flow speed.
    const speedFactor = new Map(FAST_EDGES.map((id) => [id, 0.2]));
    const route = findRoute(city, 0, 3, { speedFactor });
    expect(route.found).toBe(true);
    if (!route.found) return;
    expect(route.roadIds).toEqual([...MEDIUM_PATH]);
    expect(route.cost).toBe(computePathCost(city, route.roadIds, { speedFactor }));
  });

  it("accepts a speed-factor callback exactly like a read-only map", () => {
    const city = makeDiamondCity();
    const map = new Map(FAST_EDGES.map((id) => [id, 0.3]));
    const asMap = findRoute(city, 0, 3, { speedFactor: map });
    const asCallback = findRoute(city, 0, 3, {
      speedFactor: (roadId) => (FAST_EDGES.includes(roadId as 0 | 2) ? 0.3 : 1),
    });
    expect(asMap).toEqual(asCallback);
  });

  it("clamps factors, and never prices a road below what it can physically be", () => {
    const city = makeDiamondCity();
    const free = findRoute(city, 0, 3);
    const missing = findRoute(city, 0, 3, { speedFactor: new Map() });
    expect(missing).toEqual(free);

    // A nonsense factor reads as free, never as a jam.
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      const route = findRoute(city, 0, 3, {
        speedFactor: new Map(FAST_EDGES.map((id) => [id, bad])),
      });
      expect(route).toEqual(free);
    }

    // Below the floor saturates at the floor rather than going slower.
    const floor = findRoute(city, 0, 3, {
      speedFactor: new Map(FAST_EDGES.map((id) => [id, MIN_TRAFFIC_SPEED_FACTOR])),
    });
    const absurd = findRoute(city, 0, 3, {
      speedFactor: new Map(FAST_EDGES.map((id) => [id, 0.000001])),
    });
    expect(absurd).toEqual(floor);
  });
});

describe("determinism", () => {
  it("returns identical directed road ids across repeated calls", () => {
    const city = makeDiamondCity();
    const speedFactor = new Map(FAST_EDGES.map((id) => [id, 0.25]));
    const first = findRoute(city, 0, 3, { speedFactor });
    for (let i = 0; i < 25; i += 1) {
      expect(findRoute(city, 0, 3, { speedFactor })).toEqual(first);
    }
  });
});
