/**
 * Rush Hour road-hierarchy weighting (issue #56).
 *
 * The defect: `shapeContext` had no functional-class notion at all - `core` was
 * busiest-by-degree (local grid corners) and `arterial` a length proxy - and every
 * OD pair carried the same base weight, so rush-hour trips were drawn at random
 * and loaded local blocks as hard as expressways. These assertions pin the
 * hierarchy that replaced it, on the real benchmark city (the shape it must hold
 * for), without pinning any specific sampled demand.
 */
import { describe, expect, it } from "vitest";
import { loadBenchmarkModel } from "@/benchmark/model";
import { demandProfileFor, PRODUCTION_DEMAND } from "@/sim/demand-profile";
import { SHAPES, shapeContext } from "@/sim/demand-shape";
import type { IntersectionId } from "@/sim/types";

const model = loadBenchmarkModel();
const city = model.city;
const context = shapeContext(city);

/** Endpoints of roads of a kind, straight from the graph. */
function endpointsOf(kind: string): { ends: Set<IntersectionId>; roads: number } {
  const ends = new Set<IntersectionId>();
  let roads = 0;
  for (const road of city.roads) {
    if (road.kind !== kind) continue;
    roads += 1;
    ends.add(road.from);
    ends.add(road.to);
  }
  return { ends, roads };
}

const highway = endpointsOf("highway");
const rushShape = SHAPES["downtown-bound"];

describe("rush hour road hierarchy", () => {
  it("finds a real expressway network to weight toward", () => {
    expect(highway.roads).toBeGreaterThan(50);
    expect(context.highways.size).toBe(highway.ends.size);
    for (const id of highway.ends) {
      expect(context.highways.has(id), `endpoint ${id}`).toBe(true);
    }
  });

  it("weights expressway pairs above ordinary local pairs", () => {
    const [a, b] = [...context.highways].sort((x, y) => x - y);
    const localOnly = city.intersections
      .map((intersection) => intersection.id)
      .filter((id) => !context.highways.has(id) && !context.arterialRoads.has(id))
      .slice(0, 2);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(localOnly).toHaveLength(2);
    const expresswayPair = rushShape.weight(a!, b!, context);
    const randomPair = rushShape.weight(localOnly[0]!, localOnly[1]!, context);
    expect(expresswayPair).toBeGreaterThan(randomPair);
    // Local pairs still carry their base weight: the streets are not emptied.
    expect(randomPair).toBeGreaterThanOrEqual(1);
  });

  it("keeps the morning peak destination, now weighted through the spine", () => {
    const core = [...context.core][0];
    expect(core).toBeDefined();
    const localOnly = city.intersections
      .map((intersection) => intersection.id)
      .filter((id) => !context.highways.has(id) && !context.arterialRoads.has(id))
      .slice(0, 1);
    // A highway origin bound for the core must outweigh a local origin bound
    // somewhere equally unremarkable.
    const highwayToCore = rushShape.weight([...context.highways][0]!, core!, context);
    const localToLocal = rushShape.weight(localOnly[0]!, localOnly[0]!, context);
    expect(highwayToCore).toBeGreaterThan(localToLocal);
  });

  it("is deterministic: the same city yields the same landmarks", () => {
    const again = shapeContext(city);
    expect([...again.highways].sort((x, y) => x - y)).toEqual([...context.highways].sort((x, y) => x - y));
    expect([...again.arterialRoads].sort((x, y) => x - y)).toEqual(
      [...context.arterialRoads].sort((x, y) => x - y),
    );
    expect(again.core).toEqual(context.core);
  });

  it("keeps the shipping rush-hour profile on the hierarchy-aware shape", () => {
    const profile = demandProfileFor("rush-hour");
    expect(profile.shape).toBe("downtown-bound");
    expect(profile.multiplier).toBe(3.75);
    expect(profile.label).toBe("rush-3.75-downtown-v2");
    // Everyday and Light keep the shapes they were calibrated with.
    expect(PRODUCTION_DEMAND.everyday.shape).toBe("corridor-heavy");
    expect(PRODUCTION_DEMAND.light).toEqual({ multiplier: 1, shape: "uniform", label: "light-v1" });
  });
});
