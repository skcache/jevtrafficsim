import { describe, expect, it } from "vitest";
import { generateCity } from "@/sim/city-generator";
import { buildCityPartition, validatePartition, type CityPartition } from "@/sim/regions";
import type { City, CitySize, Intersection } from "@/sim/types";
import { makeStreet } from "./traffic-support";

const SIZES: CitySize[] = ["small", "small-medium", "medium", "medium-large", "large"];
const SEEDS = [42, 7, 1234, 99];

/** Serializable projection with deterministic (ascending) map order. */
function serializePartition(partition: CityPartition): string {
  return JSON.stringify({
    regions: partition.regions,
    corridors: partition.corridors,
    intersectionRegion: [...partition.intersectionRegion.entries()],
    roadCorridors: [...partition.roadCorridors.entries()],
  });
}

function isAscending(values: readonly number[]): boolean {
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] <= values[i - 1]) {
      return false;
    }
  }
  return true;
}

describe("region / corridor partition", () => {
  it("is valid, sorted and byte-stable across all sizes and several seeds", () => {
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        const city = generateCity(size, seed);
        const before = JSON.stringify(city);
        const partition = buildCityPartition(city);

        // Structural validity: regions own every intersection exactly once,
        // roads classified once, corridors and maps consistent.
        expect(validatePartition(city, partition), `${size}/${seed}`).toEqual([]);

        // Every intersection belongs to exactly one region.
        expect(partition.intersectionRegion.size).toBe(city.intersections.length);
        let listed = 0;
        for (const region of partition.regions) {
          listed += region.intersectionIds.length;
        }
        expect(listed).toBe(city.intersections.length);

        // Corridors preserve original id, kind and road content.
        expect(partition.corridors.length).toBe(city.corridors.length);
        for (const corridor of partition.corridors) {
          const source = city.corridors[corridor.corridorId];
          expect(corridor.kind).toBe(source.kind);
          expect(corridor.roadIds).toEqual([...source.roadIds].sort((a, b) => a - b));
          expect(isAscending(corridor.regionIds)).toBe(true);
        }

        // Deterministic ordering everywhere.
        for (const region of partition.regions) {
          expect(isAscending(region.intersectionIds)).toBe(true);
          expect(isAscending(region.internalRoadIds)).toBe(true);
          expect(isAscending(region.outgoingBoundaryRoadIds)).toBe(true);
          expect(isAscending(region.incomingBoundaryRoadIds)).toBe(true);
          expect(isAscending(region.corridorIds)).toBe(true);
        }
        for (const corridorIds of partition.roadCorridors.values()) {
          expect(isAscending(corridorIds)).toBe(true);
        }
        const regionIds = partition.regions.map((region) => region.regionId);
        expect(isAscending(regionIds)).toBe(true);

        // Repeated construction is byte-identical, and the city was not mutated.
        expect(serializePartition(buildCityPartition(city))).toBe(serializePartition(partition));
        expect(JSON.stringify(city)).toBe(before);
      }
    }
  }, 120_000);

  it("classifies internal and boundary roads from endpoint regions", () => {
    // n0 -- road0 -- n1 -- road1 -- n2 with regions 0, 0, 1:
    // road0 internal to region 0; road1 leaves region 0 and enters region 1.
    const { city } = makeStreet([{ length: 10 }, { length: 10 }]);
    const intersections: Intersection[] = city.intersections.map((intersection) => ({
      ...intersection,
      regionId: intersection.id === 2 ? 1 : 0,
    }));
    const edited: City = { ...city, intersections };
    const partition = buildCityPartition(edited);
    expect(validatePartition(edited, partition)).toEqual([]);

    const region0 = partition.regions.find((region) => region.regionId === 0);
    const region1 = partition.regions.find((region) => region.regionId === 1);
    expect(region0?.intersectionIds).toEqual([0, 1]);
    expect(region0?.internalRoadIds).toEqual([0]);
    expect(region0?.outgoingBoundaryRoadIds).toEqual([1]);
    expect(region0?.incomingBoundaryRoadIds).toEqual([]);
    expect(region1?.intersectionIds).toEqual([2]);
    expect(region1?.internalRoadIds).toEqual([]);
    expect(region1?.outgoingBoundaryRoadIds).toEqual([]);
    expect(region1?.incomingBoundaryRoadIds).toEqual([1]);
    expect(partition.intersectionRegion.get(0)).toBe(0);
    expect(partition.intersectionRegion.get(2)).toBe(1);
  });
});
