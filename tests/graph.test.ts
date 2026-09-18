import { describe, expect, it } from "vitest";
import {
  degree,
  findRoad,
  isConnected,
  neighbors,
  reachableFrom,
  validateCity,
} from "@/sim/graph";
import type { City, Intersection, Road } from "@/sim/types";

function makeIntersection(id: number, over: Partial<Intersection> = {}): Intersection {
  return {
    id,
    x: id * 10,
    y: 0,
    incoming: [],
    outgoing: [],
    control: "uncontrolled",
    regionId: 0,
    ...over,
  };
}

function makeRoad(id: number, from: number, to: number, over: Partial<Road> = {}): Road {
  return {
    id,
    from,
    to,
    length: 10,
    lanes: 1,
    speedLimit: 8,
    capacity: 8,
    kind: "local",
    closed: false,
    ...over,
  };
}

/** Triangle 0-1-2, every segment traversable both ways. */
function makeTriangleCity(): City {
  const intersections = [
    makeIntersection(0, { incoming: [1, 4], outgoing: [0, 5] }),
    makeIntersection(1, { incoming: [0, 3], outgoing: [1, 2] }),
    makeIntersection(2, { incoming: [2, 5], outgoing: [3, 4] }),
  ];
  const roads = [
    makeRoad(0, 0, 1),
    makeRoad(1, 1, 0),
    makeRoad(2, 1, 2),
    makeRoad(3, 2, 1),
    makeRoad(4, 2, 0),
    makeRoad(5, 0, 2),
  ];
  return {
    size: "small",
    seed: 0,
    gridWidth: 3,
    gridHeight: 1,
    intersections,
    roads,
    corridors: [],
  };
}

describe("graph helpers", () => {
  it("lists distinct neighbors in sorted order and reports degree", () => {
    const city = makeTriangleCity();
    expect(neighbors(city, 0)).toEqual([1, 2]);
    expect(neighbors(city, 1)).toEqual([0, 2]);
    expect(degree(city, 0)).toBe(2);
    expect(degree(city, 1)).toBe(2);
  });

  it("finds a directed road between two intersections", () => {
    const city = makeTriangleCity();
    expect(findRoad(city, 0, 1)?.id).toBe(0);
    expect(findRoad(city, 2, 0)?.id).toBe(4);
    expect(findRoad(city, 0, 0)).toBeUndefined();
  });

  it("BFS reaches every node of a connected city and reports subsets honestly", () => {
    const city = makeTriangleCity();
    expect(reachableFrom(city, 0)).toEqual(new Set([0, 1, 2]));
    expect(isConnected(city)).toBe(true);

    const islands: City = {
      ...city,
      intersections: [...city.intersections, makeIntersection(3)],
    };
    expect(reachableFrom(islands, 0)).toEqual(new Set([0, 1, 2]));
    expect(isConnected(islands)).toBe(false);
  });

  it("BFS does not traverse closed roads", () => {
    const city = makeTriangleCity();
    const closed = {
      ...city,
      roads: city.roads.map((road) =>
        road.from === 2 || road.to === 2 ? { ...road, closed: true } : road,
      ),
    };
    expect(reachableFrom(closed, 0)).toEqual(new Set([0, 1]));
    expect(isConnected(closed)).toBe(false);
  });

  it("validates a clean city", () => {
    expect(validateCity(makeTriangleCity())).toEqual([]);
  });

  it("reports zero-length roads", () => {
    const city = makeTriangleCity();
    city.roads[0].length = 0;
    expect(validateCity(city).some((v) => v.includes("length"))).toBe(true);
  });

  it("reports self-loops", () => {
    const city = makeTriangleCity();
    city.roads[0].to = city.roads[0].from;
    expect(validateCity(city).some((v) => v.includes("self-loop"))).toBe(true);
  });

  it("reports missing endpoints", () => {
    const city = makeTriangleCity();
    city.roads[0].to = 99;
    expect(validateCity(city).some((v) => v.includes("endpoint"))).toBe(true);
  });

  it("reports duplicate directed roads", () => {
    const city = makeTriangleCity();
    city.roads.push(makeRoad(6, 0, 1));
    expect(validateCity(city).some((v) => v.includes("duplicate"))).toBe(true);
  });

  it("reports non-finite coordinates", () => {
    const city = makeTriangleCity();
    city.intersections[1].x = Number.NaN;
    expect(validateCity(city).some((v) => v.includes("coordinate"))).toBe(true);
  });

  it("reports disconnected cities", () => {
    const city = makeTriangleCity();
    city.roads = city.roads.slice(0, 2);
    city.intersections = city.intersections.map((node) => ({ ...node }));
    expect(validateCity(city).some((v) => v.includes("connected"))).toBe(true);
  });
});
