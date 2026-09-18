import { describe, expect, it } from "vitest";
import { generateCity } from "@/sim/city-generator";
import {
  approachAxisKey,
  deriveApproachGroups,
  isLatticeCity,
  validateSignalPlanForCity,
} from "@/sim/signals";
import type { City, CitySize, Intersection, Road } from "@/sim/types";
import { makeCrossroads } from "./traffic-support";

const ALL_SIZES: CitySize[] = ["small", "small-medium", "medium", "medium-large", "large"];

/**
 * Hand-authored 3x3 generated-lattice city with deliberately EXTREME positions:
 * the nominal north neighbour of the centre sits far east, the nominal east
 * neighbour far west, the nominal west neighbour far south, and the nominal
 * south neighbour far north — so geometric bearings classify the roads exactly
 * opposite to their true lattice families.
 */
function extremeLattice(): City {
  const positions: Array<[number, number]> = [
    [300, 300], // 0 (r0c0) — nominal NW
    [500, 0], // 1 (r0c1) — nominal NORTH of 4, placed east
    [-300, 300], // 2 (r0c2) — nominal NE
    [0, 500], // 3 (r1c0) — nominal WEST of 4, placed south
    [0, 0], // 4 (r1c1) centre
    [-500, 0], // 5 (r1c2) — nominal EAST of 4, placed west
    [300, -300], // 6 (r2c0) — nominal SW
    [0, -500], // 7 (r2c1) — nominal SOUTH of 4, placed north
    [-300, -300], // 8 (r2c2) — nominal SE
  ];
  const intersections: Intersection[] = positions.map(([x, y], id) => ({
    id,
    x,
    y,
    incoming: [],
    outgoing: [],
    control: (id === 4 ? "signal" : "uncontrolled") as Intersection["control"],
    regionId: 0,
  }));
  // Directed approaches INTO the centre (node 4), ids in build order.
  const approachPairs: Array<[number, number]> = [
    [1, 4], // v family (delta gridWidth)
    [3, 4], // h family (delta 1)
    [5, 4], // h family
    [7, 4], // v family
    [0, 4], // d+ family (delta gridWidth + 1)
    [2, 4], // d- family (delta gridWidth - 1)
    [6, 4], // d- family
    [8, 4], // d+ family
  ];
  const roads: Road[] = approachPairs.map(([from, to], id) => ({
    id,
    from,
    to,
    length: Math.hypot(positions[to][0] - positions[from][0], positions[to][1] - positions[from][1]),
    lanes: 1,
    speedLimit: 10,
    capacity: 4,
    kind: "local" as const,
    closed: false,
  }));
  for (const road of roads) {
    intersections[road.to].incoming.push(road.id);
    intersections[road.from].outgoing.push(road.id);
  }
  return {
    size: "small",
    seed: 0,
    gridWidth: 3,
    gridHeight: 3,
    intersections,
    roads,
    corridors: [],
  };
}

describe("structural axis classification", () => {
  it("classifies generated roads by lattice delta, covering all four families", () => {
    const city = generateCity("large", 42);
    expect(isLatticeCity(city)).toBe(true);
    const families = new Set<string>();
    for (const road of city.roads) {
      const key = approachAxisKey(city, road.id);
      expect(key.kind).toBe("family");
      if (key.kind === "family") {
        families.add(key.family);
      }
    }
    expect(families).toEqual(new Set(["h", "v", "d-", "d+"]));
  });

  it("classifies every generated road across all sizes and several seeds", () => {
    for (const size of ALL_SIZES) {
      for (const seed of [42, 7, 1234]) {
        const city = generateCity(size, seed);
        expect(isLatticeCity(city)).toBe(true);
        for (const road of city.roads) {
          expect(approachAxisKey(city, road.id).kind).toBe("family");
        }
      }
    }
  });

  it("keeps non-lattice fixtures on the geometric fallback", () => {
    const { city, centerId, approachRoadIds } = makeCrossroads({
      control: "signal",
      arms: [
        { angleDeg: 0, length: 2 },
        { angleDeg: 90, length: 2 },
        { angleDeg: 180, length: 2 },
        { angleDeg: 270, length: 2 },
      ],
    });
    expect(isLatticeCity(city)).toBe(false);
    for (const roadId of approachRoadIds) {
      expect(approachAxisKey(city, roadId).kind).toBe("geometric");
    }
    // Fallback grouping is unchanged from the geometric model.
    expect(deriveApproachGroups(city, centerId)).toEqual([
      [approachRoadIds[0], approachRoadIds[2]],
      [approachRoadIds[1], approachRoadIds[3]],
    ]);
  });

  it("uses structural families even when coordinates lie about every axis", () => {
    const city = extremeLattice();
    expect(isLatticeCity(city)).toBe(true);
    const groups = deriveApproachGroups(city, 4);
    // Road ids: 0=1->4(v), 1=3->4(h), 2=5->4(h), 3=7->4(v),
    //           4=0->4(d+), 5=2->4(d-), 6=6->4(d-), 7=8->4(d+)
    // Family order: h, v, d-, d+ — opposite approaches share their family group.
    expect(groups).toEqual([
      [1, 2], // horizontal lattice axis
      [0, 3], // vertical lattice axis
      [5, 6], // one diagonal family
      [4, 7], // the other diagonal family
    ]);
    expect(validateSignalPlanForCity(city, 4, groups)).toEqual([]);
  });

  it("coordinate distortion does not change structural grouping", () => {
    const city = generateCity("medium", 42);
    const distorted: City = {
      ...city,
      intersections: city.intersections.map((intersection) => ({
        ...intersection,
        x: intersection.y * 1.9 - intersection.id * 11 + 40,
        y: -intersection.x * 0.4 + (intersection.id % 5) * 97,
      })),
    };
    for (const intersection of city.intersections) {
      const original = deriveApproachGroups(city, intersection.id);
      const moved = deriveApproachGroups(distorted, intersection.id);
      expect(moved).toEqual(original);
    }
  });

  it("keeps structural phase groups free of family mixtures and splits", () => {
    for (const size of ALL_SIZES) {
      for (const seed of [42, 7, 1234]) {
        const city = generateCity(size, seed);
        for (const intersection of city.intersections) {
          if (intersection.control !== "signal" || intersection.incoming.length === 0) {
            continue;
          }
          const groups = deriveApproachGroups(city, intersection.id);
          const seenFamilies: string[] = [];
          for (const group of groups) {
            const families = new Set(
              group.map((roadId) => {
                const key = approachAxisKey(city, roadId);
                return key.kind === "family" ? key.family : "geometric";
              }),
            );
            expect(families.size).toBe(1); // never mix families in one phase
            const family = [...families][0];
            expect(seenFamilies.includes(family)).toBe(false); // never split a family
            seenFamilies.push(family);
          }
          expect(validateSignalPlanForCity(city, intersection.id, groups)).toEqual([]);
        }
      }
    }
  });
});
