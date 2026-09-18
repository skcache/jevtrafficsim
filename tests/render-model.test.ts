import { describe, expect, it } from "vitest";
import { generateCity } from "@/sim/city-generator";
import {
  buildRenderModel,
  fitTransform,
  laneOffsetSign,
  waitHeatBucket,
  worldToScreen,
} from "@/render/model";
import { makeStreet } from "./traffic-support";

describe("render model", () => {
  it("deduplicates physical segments to about half the directed roads", () => {
    const city = generateCity("medium", 42);
    const model = buildRenderModel(city);
    expect(city.roads.length % 2).toBe(0);
    expect(model.segments.length).toBe(city.roads.length / 2);
    // Every directed road belongs to exactly one rendered segment.
    expect(model.directedToSegment.length).toBe(city.roads.length);
    model.directedToSegment.forEach((segmentIndex, roadId) => {
      expect(segmentIndex).toBeGreaterThanOrEqual(0);
      expect(model.segments[segmentIndex].roadIds).toContain(roadId);
    });
    // Reverse lookup is deterministic and stable across builds.
    const rebuilt = buildRenderModel(generateCity("medium", 42));
    expect(JSON.stringify(rebuilt)).toBe(JSON.stringify(model));
  });

  it("derives world bounds that contain every intersection", () => {
    const city = generateCity("small-medium", 7);
    const model = buildRenderModel(city);
    for (const intersection of city.intersections) {
      expect(intersection.x).toBeGreaterThanOrEqual(model.bounds.minX);
      expect(intersection.x).toBeLessThanOrEqual(model.bounds.maxX);
      expect(intersection.y).toBeGreaterThanOrEqual(model.bounds.minY);
      expect(intersection.y).toBeLessThanOrEqual(model.bounds.maxY);
    }
  });

  it("builds quiet lattice blocks only for lattice cities", () => {
    const lattice = generateCity("small", 42);
    const model = buildRenderModel(lattice);
    expect(model.blocks.length).toBe(
      (lattice.gridWidth - 1) * (lattice.gridHeight - 1),
    );
    const { city: street } = makeStreet([{ length: 10 }, { length: 10 }]);
    expect(buildRenderModel(street).blocks).toEqual([]);
  });

  it("maps directed roads to their directional geometry", () => {
    const { city } = makeStreet([{ length: 10 }, { length: 10 }]);
    const model = buildRenderModel(city);
    expect(model.roads[0]).toEqual({
      fromId: 0,
      toId: 1,
      from: { x: 0, y: 0 },
      to: { x: 10, y: 0 },
      length: 10,
    });
  });
});

describe("world -> screen transform", () => {
  it("fits the whole city inside the canvas with uniform scale and padding", () => {
    const city = generateCity("medium-large", 42);
    const model = buildRenderModel(city);
    const width = 900;
    const height = 600;
    const padding = 20;
    const transform = fitTransform(model.bounds, width, height, padding);
    // Aspect preserved: one scale for both axes by construction.
    const corners = [
      { x: model.bounds.minX, y: model.bounds.minY },
      { x: model.bounds.maxX, y: model.bounds.minY },
      { x: model.bounds.minX, y: model.bounds.maxY },
      { x: model.bounds.maxX, y: model.bounds.maxY },
    ].map((corner) => worldToScreen(transform, corner));
    for (const corner of corners) {
      expect(corner.x).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(corner.x).toBeLessThanOrEqual(width - padding + 1e-6);
      expect(corner.y).toBeGreaterThanOrEqual(padding - 1e-6);
      expect(corner.y).toBeLessThanOrEqual(height - padding + 1e-6);
    }
    // The same city always fits: taller canvas keeps it inside too.
    const tall = fitTransform(model.bounds, 500, 1_000, padding);
    const screen = worldToScreen(tall, { x: model.bounds.maxX, y: model.bounds.maxY });
    expect(screen.x).toBeLessThanOrEqual(500);
    expect(screen.y).toBeLessThanOrEqual(1_000);
  });

  it("never produces NaN for zero-size layouts", () => {
    const transform = fitTransform({ minX: 0, minY: 0, maxX: 0, maxY: 0 }, 0, 0, 20);
    expect(Number.isFinite(transform.scale)).toBe(true);
    const screen = worldToScreen(transform, { x: 0, y: 0 });
    expect(Number.isFinite(screen.x)).toBe(true);
    expect(Number.isFinite(screen.y)).toBe(true);
  });
});

describe("wait heat buckets", () => {
  it("maps blocked wait to the documented semantic buckets", () => {
    expect(waitHeatBucket(0)).toBe(0);
    expect(waitHeatBucket(4_999)).toBe(0);
    expect(waitHeatBucket(5_000)).toBe(1);
    expect(waitHeatBucket(14_999)).toBe(1);
    expect(waitHeatBucket(15_000)).toBe(2);
    expect(waitHeatBucket(29_999)).toBe(2);
    expect(waitHeatBucket(30_000)).toBe(3);
    expect(waitHeatBucket(59_999)).toBe(3);
    expect(waitHeatBucket(60_000)).toBe(4);
    expect(waitHeatBucket(Number.NaN)).toBe(0);
  });
});

describe("lane offset", () => {
  it("puts opposite directions of one physical road on opposite sides", () => {
    const { city } = makeStreet([{ length: 10 }]);
    expect(laneOffsetSign(city, 0)).toBe(1); // 0 -> 1
    const { city: twoWay } = makeStreet([{ length: 10 }]);
    const withReverse = {
      ...twoWay,
      roads: [
        ...twoWay.roads,
        { ...twoWay.roads[0], id: 1, from: 1, to: 0 },
      ],
    };
    expect(laneOffsetSign(withReverse, 0)).toBe(1);
    expect(laneOffsetSign(withReverse, 1)).toBe(-1);
  });
});
