import { describe, expect, it } from "vitest";
import { citySignature, generateCity } from "@/sim/city-generator";
import { CITY_SIZE_SPECS } from "@/sim/config";
import { isConnected, validateCity } from "@/sim/graph";
import type { City, CitySize } from "@/sim/types";

const ALL_SIZES: CitySize[] = [
  "small",
  "small-medium",
  "medium",
  "medium-large",
  "large",
];
const SAMPLE_SEEDS = [1, 7, 42, 99, 1234];

function bridgeSegmentCount(city: City): number {
  return city.roads.filter((road) => road.kind === "bridge").length / 2;
}

function undirectedEdgeCount(city: City): number {
  return city.roads.length / 2;
}

function cyclomaticComplexity(city: City): number {
  // E - V + 1 for a single connected component: independent-route headroom.
  return undirectedEdgeCount(city) - city.intersections.length + 1;
}

function signalCount(city: City): number {
  return city.intersections.filter((node) => node.control === "signal").length;
}

describe("city determinism", () => {
  it("generates identical topology for the same size and seed", () => {
    for (const size of ALL_SIZES) {
      const a = generateCity(size, 42);
      const b = generateCity(size, 42);
      expect(citySignature(a)).toBe(citySignature(b));
      expect(JSON.stringify(a.intersections)).toBe(JSON.stringify(b.intersections));
      expect(JSON.stringify(a.roads)).toBe(JSON.stringify(b.roads));
      expect(JSON.stringify(a.corridors)).toBe(JSON.stringify(b.corridors));
    }
  });

  it("generates materially different topology for different seeds", () => {
    for (const size of ALL_SIZES) {
      expect(citySignature(generateCity(size, 42))).not.toBe(
        citySignature(generateCity(size, 43)),
      );
      const signatures = new Set(
        SAMPLE_SEEDS.map((seed) => citySignature(generateCity(size, seed))),
      );
      expect(signatures.size).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("size targets", () => {
  it("lands inside the configured intersection range for every size and seed", () => {
    for (const size of ALL_SIZES) {
      const spec = CITY_SIZE_SPECS[size];
      for (const seed of SAMPLE_SEEDS) {
        const city = generateCity(size, seed);
        expect(city.intersections.length).toBeGreaterThanOrEqual(spec.minIntersections);
        expect(city.intersections.length).toBeLessThanOrEqual(spec.maxIntersections);
      }
    }
  });
});

describe("connectivity and validity", () => {
  it("is connected and passes full validation for sampled seeds", () => {
    for (const size of ALL_SIZES) {
      for (const seed of [1, 42, 99]) {
        const city = generateCity(size, seed);
        expect(validateCity(city)).toEqual([]);
        expect(isConnected(city)).toBe(true);
      }
    }
  });

  it("survives closing any single bridge", () => {
    for (const size of ["medium-large", "large"] as CitySize[]) {
      for (const seed of [1, 42]) {
        const city = generateCity(size, seed);
        const bridges = city.roads.filter((road) => road.kind === "bridge");
        expect(bridges.length).toBeGreaterThan(0);
        const first = bridges[0];
        const reverse = bridges.find(
          (road) => road.id !== first.id && road.from === first.to && road.to === first.from,
        );
        expect(reverse).toBeDefined();
        const closed: City = {
          ...city,
          roads: city.roads.map((road) =>
            road.id === first.id || road.id === reverse!.id
              ? { ...road, closed: true }
              : road,
          ),
        };
        expect(isConnected(closed)).toBe(true);
      }
    }
  });
});

describe("geometry", () => {
  it("has no zero-length roads, valid endpoints, no self-loops, no duplicates", () => {
    for (const size of ALL_SIZES) {
      const city = generateCity(size, 42);
      const nodeIds = new Set(city.intersections.map((node) => node.id));
      const seenDirected = new Set<string>();
      for (const node of city.intersections) {
        expect(Number.isFinite(node.x)).toBe(true);
        expect(Number.isFinite(node.y)).toBe(true);
      }
      for (const road of city.roads) {
        expect(nodeIds.has(road.from)).toBe(true);
        expect(nodeIds.has(road.to)).toBe(true);
        expect(road.from).not.toBe(road.to);
        expect(Number.isFinite(road.length)).toBe(true);
        expect(road.length).toBeGreaterThan(0);
        const key = `${road.from}>${road.to}`;
        expect(seenDirected.has(key)).toBe(false);
        seenDirected.add(key);
      }
    }
  });
});

describe("road hierarchy", () => {
  it("adds highway and diagonals from medium upward, bridges from medium-large upward", () => {
    const small = generateCity("small", 42);
    expect(small.roads.some((road) => road.kind === "highway")).toBe(false);
    expect(small.corridors.some((corridor) => corridor.kind === "diagonal")).toBe(false);
    expect(small.roads.some((road) => road.kind === "bridge")).toBe(false);

    const medium = generateCity("medium", 42);
    expect(medium.roads.some((road) => road.kind === "highway")).toBe(true);
    expect(medium.corridors.some((corridor) => corridor.kind === "diagonal")).toBe(true);
    expect(medium.roads.some((road) => road.kind === "bridge")).toBe(false);

    expect(bridgeSegmentCount(generateCity("medium-large", 42))).toBeGreaterThanOrEqual(2);
    expect(bridgeSegmentCount(generateCity("large", 42))).toBeGreaterThanOrEqual(3);
  });

  it("classifies control types by structural importance", () => {
    for (const size of ALL_SIZES) {
      const city = generateCity(size, 42);
      for (const node of city.intersections) {
        const touches = (kinds: string[]): boolean =>
          city.roads.some(
            (road) =>
              (road.from === node.id || road.to === node.id) &&
              kinds.includes(road.kind),
          );
        if (node.control === "signal") {
          expect(touches(["arterial", "highway", "bridge"])).toBe(true);
        } else if (node.control === "stop") {
          expect(touches(["arterial", "highway", "bridge"])).toBe(false);
          expect(degreeOf(city, node.id)).toBeGreaterThanOrEqual(3);
        } else {
          expect(degreeOf(city, node.id)).toBeLessThanOrEqual(2);
        }
      }
    }
  });
});

function degreeOf(city: City, id: number): number {
  const set = new Set<number>();
  for (const road of city.roads) {
    if (road.from === id) set.add(road.to);
    if (road.to === id) set.add(road.from);
  }
  return set.size;
}

describe("structural progression", () => {
  it("larger tiers meaningfully increase size, corridors, and route headroom", () => {
    const cities = ALL_SIZES.map((size) => generateCity(size, 42));
    for (let i = 1; i < cities.length; i += 1) {
      expect(cities[i].intersections.length).toBeGreaterThan(
        cities[i - 1].intersections.length,
      );
      expect(cities[i].roads.length).toBeGreaterThan(cities[i - 1].roads.length);
      expect(cities[i].corridors.length).toBeGreaterThan(
        cities[i - 1].corridors.length,
      );
      expect(cyclomaticComplexity(cities[i])).toBeGreaterThan(
        cyclomaticComplexity(cities[i - 1]),
      );
      expect(signalCount(cities[i])).toBeGreaterThan(signalCount(cities[i - 1]));
    }
  });
});

describe("regions", () => {
  it("assigns every intersection to a populated in-range region", () => {
    for (const size of ALL_SIZES) {
      const spec = CITY_SIZE_SPECS[size];
      const regionCount = spec.regionCols * spec.regionRows;
      for (const seed of [1, 42]) {
        const city = generateCity(size, seed);
        const populated = new Set<number>();
        for (const node of city.intersections) {
          expect(Number.isInteger(node.regionId)).toBe(true);
          expect(node.regionId).toBeGreaterThanOrEqual(0);
          expect(node.regionId).toBeLessThan(regionCount);
          populated.add(node.regionId);
        }
        expect(populated.size).toBe(regionCount);
      }
    }
  });
});

describe("frozen structural signatures", () => {
  it("keeps the seed-42 small city stable", () => {
    const city = generateCity("small", 42);
    expect({
      nodes: city.intersections.length,
      roads: city.roads.length,
      corridors: city.corridors.length,
      signals: signalCount(city),
      stops: city.intersections.filter((n) => n.control === "stop").length,
      regions: new Set(city.intersections.map((n) => n.regionId)).size,
    }).toEqual({
      nodes: 12,
      roads: 32,
      corridors: 2,
      signals: 6,
      stops: 3,
      regions: 2,
    });
  });

  it("keeps the seed-42 large city stable", () => {
    const city = generateCity("large", 42);
    expect({
      nodes: city.intersections.length,
      roads: city.roads.length,
      corridors: city.corridors.length,
      bridges: bridgeSegmentCount(city),
      signals: signalCount(city),
      regions: new Set(city.intersections.map((n) => n.regionId)).size,
    }).toEqual({
      nodes: 238,
      roads: 840,
      corridors: 9,
      bridges: 3,
      signals: 111,
      regions: 6,
    });
  });
});
