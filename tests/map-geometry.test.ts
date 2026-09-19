import { describe, expect, it } from "vitest";
import { chicagoModel } from "./chicago-support";
import { buildPathIndex, pathLength, type Point } from "@/cities/paths";
import {
  applyLaneOffset,
  buildDirectedPathIndexes,
  sampleDirectedRoad,
  sampleDirectedRoadWithLane,
  waitHeatBucket,
  WAIT_HEAT_COLORS,
} from "@/render/map-geometry";
import {
  carriagewayPairs,
  directionalLanes,
  laneCentreOffsetMetres,
  LANE_WIDTH_M,
} from "@/render/road-presentation";

describe("showcase geometry", () => {
  it("builds a presentation path for every directed road", () => {
    for (const scale of [0, 2, 4]) {
      const model = chicagoModel(scale);
      const indexes = buildDirectedPathIndexes(model);
      expect(indexes.length).toBe(model.city.roads.length);
      model.city.roads.forEach((road) => {
        const index = indexes[road.id];
        expect(index, `road ${road.id} path`).not.toBeNull();
        // Road length equals presentation path length (progress maps to distance).
        // Both are rounded to centimetres by the importer.
        expect(index!.total).toBeCloseTo(road.length, 1);
      });
    }
  });

  it("orients reverse paths backwards along the same physical street", () => {
    const model = chicagoModel(2);
    const indexes = buildDirectedPathIndexes(model);
    let checked = 0;
    for (const piece of model.streets) {
      // One-way Chicago streets have a single directed road; only two-way
      // streets carry a reverse to compare.
      if (piece.roadIds.length < 2) {
        continue;
      }
      const [forward, reverse] = piece.roadIds;
      const a = indexes[forward]!;
      const b = indexes[reverse]!;
      // Dual carriageways are separate OSM ways: lengths agree within a few %.
      expect(Math.abs(a.total - b.total) / Math.max(a.total, b.total)).toBeLessThan(0.05);
      // Separate OSM ways: the endpoints agree to within a carriageway width,
      // not exactly.
      const near = (p: readonly number[], q: readonly number[]) =>
        Math.hypot(p[0] - q[0], p[1] - q[1]) <= 10;
      expect(near(b.points[0], a.points[a.points.length - 1])).toBe(true);
      expect(near(b.points[b.points.length - 1], a.points[0])).toBe(true);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
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

  it("samples Chicago streets within the city bounds and on the right side", () => {
    const model = chicagoModel(4);
    const indexes = buildDirectedPathIndexes(model);
    for (const road of model.city.roads) {
      const sample = sampleDirectedRoad(indexes, road.id, road.length / 2)!;
      expect(sample.x).toBeGreaterThanOrEqual(model.bounds.minX - 1);
      expect(sample.x).toBeLessThanOrEqual(model.bounds.maxX + 1);
      expect(sample.y).toBeGreaterThanOrEqual(model.bounds.minY - 1);
      expect(sample.y).toBeLessThanOrEqual(model.bounds.maxY + 1);
    }
    // Both directions sample the same centreline point... (one-way Chicago
    // streets have a single directed road, so pick a two-way piece).
    const piece = model.streets.find((candidate) => candidate.roadIds.length > 1)!;
    const [forward, reverse] = piece.roadIds;
    const midForward = sampleDirectedRoad(indexes, forward, model.city.roads[forward].length / 2)!;
    const midReverse = sampleDirectedRoad(indexes, reverse, model.city.roads[reverse].length / 2)!;
    // Separate OSM ways per direction: centrelines agree to within a carriageway.
    expect(Math.hypot(midForward.x - midReverse.x, midForward.y - midReverse.y)).toBeLessThan(10);
    // ...but the lane-offset versions sit on opposite sides (right of travel
    // for each direction), so they never overlap.
    const pairs = carriagewayPairs(model);
    const forwardOffset = laneCentreOffsetMetres(model, forward, pairs);
    const reverseOffset = laneCentreOffsetMetres(model, reverse, pairs);
    const laneForward = sampleDirectedRoadWithLane(
      indexes,
      forward,
      model.city.roads[forward].length / 2,
      forwardOffset,
    )!;
    const laneReverse = sampleDirectedRoadWithLane(
      indexes,
      reverse,
      model.city.roads[reverse].length / 2,
      reverseOffset,
    )!;
    // Each direction sits half its own lane span off the centreline, so the two
    // are separated by the sum of both — derived, never a constant.
    expect(Math.hypot(laneForward.x - laneReverse.x, laneForward.y - laneReverse.y)).toBeCloseTo(
      forwardOffset + reverseOffset,
      4,
    );
  });

  it("takes every lane offset from the carriageway model, never a default", () => {
    const model = chicagoModel(2);
    const indexes = buildDirectedPathIndexes(model);
    const pairs = carriagewayPairs(model);
    const road = model.city.roads[0];
    const offset = laneCentreOffsetMetres(model, road.id, pairs);
    const plain = sampleDirectedRoad(indexes, road.id, 10)!;
    const withLane = sampleDirectedRoadWithLane(indexes, road.id, 10, offset)!;
    expect(Math.hypot(withLane.x - plain.x, withLane.y - plain.y)).toBeCloseTo(offset, 6);
    // Right side of travel: for an eastbound heading the offset points south.
    const eastbound = applyLaneOffset({ x: 0, y: 0, heading: 0 }, offset);
    expect(eastbound.y).toBeCloseTo(-offset, 9);
    const westbound = applyLaneOffset({ x: 0, y: 0, heading: Math.PI }, offset);
    expect(westbound.y).toBeCloseTo(offset, 9);
    // Lane slots spread across the lanes the road actually has.
    const lanes = directionalLanes(model, road.id);
    if (lanes > 1) {
      const first = laneCentreOffsetMetres(model, road.id, pairs, 0);
      const last = laneCentreOffsetMetres(model, road.id, pairs, lanes - 1);
      expect(Math.abs(last - first)).toBeCloseTo((lanes - 1) * LANE_WIDTH_M, 6);
    }
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
