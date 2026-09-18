import { describe, expect, it } from "vitest";
import { computePathCost, findRoute } from "@/sim/astar";
import { generateCity } from "@/sim/city-generator";
import type { City, CitySize, RoadId } from "@/sim/types";

const ALL_SIZES: CitySize[] = [
  "small",
  "small-medium",
  "medium",
  "medium-large",
  "large",
];

function assertValidRoute(
  city: City,
  start: number,
  goal: number,
  roadIds: RoadId[],
): void {
  if (roadIds.length === 0) {
    expect(start).toBe(goal);
    return;
  }
  expect(city.roads[roadIds[0]].from).toBe(start);
  for (let i = 1; i < roadIds.length; i += 1) {
    expect(city.roads[roadIds[i]].from).toBe(city.roads[roadIds[i - 1]].to);
  }
  expect(city.roads[roadIds[roadIds.length - 1]].to).toBe(goal);
}

describe("A* on generated cities", () => {
  it("routes deterministic pairs on all five sizes with valid, closed-free paths", () => {
    for (const size of ALL_SIZES) {
      const city = generateCity(size, 42);
      const count = city.intersections.length;
      const pairs: Array<[number, number]> = [
        [0, count - 1],
        [count - 1, 0],
        [Math.floor(count / 2), 0],
        [0, Math.floor(count / 2)],
      ];
      for (const [start, goal] of pairs) {
        const route = findRoute(city, start, goal);
        expect(route.found, `${size} ${start}->${goal}`).toBe(true);
        if (!route.found) {
          continue;
        }
        assertValidRoute(city, start, goal, route.roadIds);
        expect(route.intersectionIds[0]).toBe(start);
        expect(route.intersectionIds[route.intersectionIds.length - 1]).toBe(goal);
        expect(route.intersectionIds.length).toBe(route.roadIds.length + 1);
        expect(route.cost).toBe(computePathCost(city, route.roadIds));
        for (const roadId of route.roadIds) {
          expect(city.roads[roadId].closed).toBe(false);
        }
      }
    }
  });

  it("reroutes around a closed mid-route road on a generated city", () => {
    const city = generateCity("medium", 42);
    const count = city.intersections.length;
    const start = 0;
    const goal = count - 1;
    const first = findRoute(city, start, goal);
    expect(first.found).toBe(true);
    if (!first.found) {
      return;
    }
    const victimId = first.roadIds[Math.floor(first.roadIds.length / 2)];
    const victim = city.roads[victimId];
    const reverse = city.roads.find(
      (road) => road.from === victim.to && road.to === victim.from,
    );
    expect(reverse).toBeDefined();
    const closedCity: City = {
      ...city,
      roads: city.roads.map((road) =>
        road.id === victimId || road.id === reverse?.id
          ? { ...road, closed: true }
          : road,
      ),
    };
    const second = findRoute(closedCity, start, goal);
    expect(second.found).toBe(true);
    if (!second.found) {
      return;
    }
    expect(second.roadIds).not.toContain(victimId);
    expect(second.roadIds).not.toContain(reverse?.id);
    assertValidRoute(closedCity, start, goal, second.roadIds);
    for (const roadId of second.roadIds) {
      expect(closedCity.roads[roadId].closed).toBe(false);
    }
  });

  it("stays deterministic on generated cities across repeated calls", () => {
    const city = generateCity("small", 42);
    const first = findRoute(city, 0, city.intersections.length - 1);
    for (let i = 0; i < 20; i += 1) {
      expect(findRoute(city, 0, city.intersections.length - 1)).toEqual(first);
    }
  });
});
