import { describe, expect, it } from "vitest";
import { compileShowcaseCity } from "@/cities/showcase-city";
import { buildPathIndex, pathLength, type Point } from "@/cities/paths";
import {
  applyLaneOffset,
  buildDirectedPathIndexes,
  LANE_OFFSET_METRES,
  sampleDirectedRoad,
  sampleDirectedRoadWithLane,
  waitHeatBucket,
  WAIT_HEAT_COLORS,
} from "@/render/showcase-geometry";

describe("showcase geometry", () => {
  it("builds a presentation path for every directed road", () => {
    for (const scale of [0, 2, 4]) {
      const model = compileShowcaseCity(scale);
      const indexes = buildDirectedPathIndexes(model);
      expect(indexes.length).toBe(model.city.roads.length);
      model.city.roads.forEach((road) => {
        const index = indexes[road.id];
        expect(index, `road ${road.id} path`).not.toBeNull();
        // Road length equals presentation path length (progress maps to distance).
        expect(index!.total).toBeCloseTo(road.length, 6);
      });
    }
  });

  it("orients reverse paths backwards along the same physical street", () => {
    const model = compileShowcaseCity(2);
    const indexes = buildDirectedPathIndexes(model);
    for (const piece of model.streets) {
      const [forward, reverse] = piece.roadIds;
      const a = indexes[forward]!;
      const b = indexes[reverse]!;
      expect(a.total).toBeCloseTo(b.total, 6);
      expect(b.points[0]).toEqual(a.points[a.points.length - 1]);
      expect(b.points[b.points.length - 1]).toEqual(a.points[0]);
    }
  });

  it("samples curved roads by distance with correct headings", () => {
    // A hand-made curved street: quarter arc from (0,0) to (100,100).
    const curve: Point[] = [
      [0, 0],
      [70, 30],
      [100, 100],
    ];
    const index = buildPathIndex(curve);
    const total = pathLength(curve);
    const start = sampleDirectedRoad([index], 0, 0)!;
    expect(start.x).toBeCloseTo(0, 6);
    expect(start.y).toBeCloseTo(0, 6);
    expect(start.heading).toBeCloseTo(Math.atan2(30, 70), 6);
    const middle = sampleDirectedRoad([index], 0, total / 2)!;
    expect(middle.x).toBeGreaterThan(0);
    expect(middle.x).toBeLessThan(100);
    expect(middle.y).toBeGreaterThan(0);
    expect(middle.y).toBeLessThan(100);
    const end = sampleDirectedRoad([index], 0, total)!;
    expect(end.x).toBeCloseTo(100, 6);
    expect(end.y).toBeCloseTo(100, 6);
    // Beyond the end clamps; negative clamps to the start.
    expect(sampleDirectedRoad([index], 0, total + 500)!.x).toBeCloseTo(100, 6);
    expect(sampleDirectedRoad([index], 0, -50)!.x).toBeCloseTo(0, 6);
  });

  it("samples showcase streets within world bounds and on the right side", () => {
    const model = compileShowcaseCity(4);
    const indexes = buildDirectedPathIndexes(model);
    for (const road of model.city.roads) {
      const sample = sampleDirectedRoad(indexes, road.id, road.length / 2)!;
      expect(sample.x).toBeGreaterThanOrEqual(0);
      expect(sample.x).toBeLessThanOrEqual(5600);
      expect(sample.y).toBeGreaterThanOrEqual(0);
      expect(sample.y).toBeLessThanOrEqual(4600);
    }
    // Both directions sample the same centreline point...
    const piece = model.streets[0];
    const [forward, reverse] = piece.roadIds;
    const midForward = sampleDirectedRoad(indexes, forward, model.city.roads[forward].length / 2)!;
    const midReverse = sampleDirectedRoad(indexes, reverse, model.city.roads[reverse].length / 2)!;
    expect(Math.hypot(midForward.x - midReverse.x, midForward.y - midReverse.y)).toBeCloseTo(0, 4);
    // ...but the lane-offset versions sit on opposite sides (right of travel
    // for each direction), so they never overlap.
    const laneForward = sampleDirectedRoadWithLane(indexes, forward, model.city.roads[forward].length / 2)!;
    const laneReverse = sampleDirectedRoadWithLane(indexes, reverse, model.city.roads[reverse].length / 2)!;
    expect(Math.hypot(laneForward.x - laneReverse.x, laneForward.y - laneReverse.y)).toBeCloseTo(
      LANE_OFFSET_METRES * 2,
      4,
    );
  });

  it("applies deterministic right-side lane offsets", () => {
    const model = compileShowcaseCity(2);
    const indexes = buildDirectedPathIndexes(model);
    const road = model.city.roads[0];
    const plain = sampleDirectedRoad(indexes, road.id, 10)!;
    const withLane = sampleDirectedRoadWithLane(indexes, road.id, 10)!;
    expect(Math.hypot(withLane.x - plain.x, withLane.y - plain.y)).toBeCloseTo(
      LANE_OFFSET_METRES,
      6,
    );
    // Right side of travel: for an eastbound heading the offset points south.
    const eastbound = applyLaneOffset({ x: 0, y: 0, heading: 0 });
    expect(eastbound.y).toBeCloseTo(-LANE_OFFSET_METRES, 9);
    const westbound = applyLaneOffset({ x: 0, y: 0, heading: Math.PI });
    expect(westbound.y).toBeCloseTo(LANE_OFFSET_METRES, 9);
  });

  it("maps blocked wait to the documented heat buckets", () => {
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
    expect(WAIT_HEAT_COLORS.length).toBe(5);
  });
});
