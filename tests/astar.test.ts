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

describe("congestion-aware routing", () => {
  it("reproduces free-flow routing at zero occupancy for any weight", () => {
    const city = makeDiamondCity();
    const base = findRoute(city, 0, 3);
    const weighted = findRoute(city, 0, 3, {
      congestionWeight: 10,
      occupancy: new Map(),
    });
    expect(base.found && weighted.found).toBe(true);
    if (!base.found || !weighted.found) return;
    expect(weighted.roadIds).toEqual(base.roadIds);
  });

  it("switches routes when the fast path is congested enough", () => {
    const city = makeDiamondCity();
    const occupancy = new Map(FAST_EDGES.map((id) => [id, 4])); // ratio 1.0
    const route = findRoute(city, 0, 3, { congestionWeight: 10, occupancy });
    expect(route.found).toBe(true);
    if (!route.found) return;
    expect(route.roadIds).toEqual([...MEDIUM_PATH]);
    expect(route.cost).toBe(computePathCost(city, route.roadIds, { congestionWeight: 10, occupancy }));
  });

  it("accepts an occupancy callback exactly like a read-only map", () => {
    const city = makeDiamondCity();
    const asMap = findRoute(city, 0, 3, {
      congestionWeight: 10,
      occupancy: new Map(FAST_EDGES.map((id) => [id, 4])),
    });
    const asCallback = findRoute(city, 0, 3, {
      congestionWeight: 10,
      occupancy: (roadId) => (FAST_EDGES.includes(roadId as 0 | 2) ? 4 : 0),
    });
    expect(asMap).toEqual(asCallback);
  });

  it("clamps occupancy: negatives count as zero, huge counts saturate", () => {
    const city = makeDiamondCity();
    const free = findRoute(city, 0, 3, { congestionWeight: 10 });
    const negative = findRoute(city, 0, 3, {
      congestionWeight: 10,
      occupancy: new Map(FAST_EDGES.map((id) => [id, -5])),
    });
    expect(negative).toEqual(free);

    const huge = findRoute(city, 0, 3, {
      congestionWeight: 10,
      occupancy: new Map(FAST_EDGES.map((id) => [id, 1_000_000])),
    });
    const atCapacity = findRoute(city, 0, 3, {
      congestionWeight: 10,
      occupancy: new Map(FAST_EDGES.map((id) => [id, 4])),
    });
    expect(huge).toEqual(atCapacity);

    const nan = findRoute(city, 0, 3, {
      congestionWeight: 10,
      occupancy: new Map(FAST_EDGES.map((id) => [id, Number.NaN])),
    });
    expect(nan).toEqual(free);
  });

  it("rejects negative or non-finite congestion weights", () => {
    const city = makeDiamondCity();
    expect(() => findRoute(city, 0, 3, { congestionWeight: -1 })).toThrow(RangeError);
    expect(() =>
      findRoute(city, 0, 3, { congestionWeight: Number.NaN }),
    ).toThrow(RangeError);
    expect(() =>
      findRoute(city, 0, 3, { congestionWeight: Number.POSITIVE_INFINITY }),
    ).toThrow(RangeError);
  });
});

describe("determinism", () => {
  it("returns identical directed road ids across repeated calls", () => {
    const city = makeDiamondCity();
    const occupancy = new Map(FAST_EDGES.map((id) => [id, 4]));
    const first = findRoute(city, 0, 3, { congestionWeight: 10, occupancy });
    for (let i = 0; i < 25; i += 1) {
      expect(findRoute(city, 0, 3, { congestionWeight: 10, occupancy })).toEqual(
        first,
      );
    }
  });
});
