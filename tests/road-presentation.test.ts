/**
 * Road presentation: widths, lane centres and the carriageway model that keeps
 * road geometry, lane count and vehicle placement consistent.
 */
import { describe, expect, it } from "vitest";
import {
  carriagewayLanes,
  carriagewayPairs,
  directionalLanes,
  isSharedCarriageway,
  laneCentreOffsetMetres,
  roadVisualScaleAt,
  widthMetresForRoad,
  LANE_WIDTH_M,
  RAMP_WIDTH_FACTOR,
} from "@/render/road-presentation";
import { carriagewayWidthMetres } from "@/cities/map-model";
import { chicagoModel } from "./chicago-support";

describe("road width by lanes and class", () => {
  it("grows presentation width materially as inspection zoom increases", () => {
    expect(roadVisualScaleAt(13)).toBeCloseTo(1.06, 6);
    expect(roadVisualScaleAt(17)).toBeCloseTo(1.32, 6);
    expect(roadVisualScaleAt(19.5)).toBeCloseTo(1.55, 6);
    expect(roadVisualScaleAt(19.5)).toBeGreaterThan(roadVisualScaleAt(15));
  });

  it("scales with lane count, never one fixed width", () => {
    const one = carriagewayWidthMetres(1, false);
    const two = carriagewayWidthMetres(2, false);
    const four = carriagewayWidthMetres(4, false);
    expect(two - one).toBeCloseTo(LANE_WIDTH_M, 6);
    expect(four - two).toBeCloseTo(2 * LANE_WIDTH_M, 6);
    expect(one).toBeGreaterThanOrEqual(3.6);
  });

  it("keeps ramps narrower than the road they leave", () => {
    const road = carriagewayWidthMetres(2, false);
    const ramp = carriagewayWidthMetres(2, true);
    expect(ramp).toBeCloseTo(road * RAMP_WIDTH_FACTOR, 6);
    expect(ramp).toBeLessThan(road);
  });

  it("uses the whole carriageway's lanes, not one direction's", () => {
    const model = chicagoModel(2);
    const pairs = carriagewayPairs(model);
    // Find a shared carriageway (both directions present).
    const shared = model.city.roads.find((road) => isSharedCarriageway(pairs, road.id));
    expect(shared, "a two-way street exists").toBeTruthy();
    if (!shared) {
      return;
    }
    const total = carriagewayLanes(model, shared.id, pairs);
    const own = directionalLanes(model, shared.id);
    expect(total).toBeGreaterThanOrEqual(own);
    expect(widthMetresForRoad(model, shared.id, pairs)).toBeCloseTo(
      carriagewayWidthMetres(total, false),
      6,
    );
  });

  it("widens with the real directional lanes across the network", () => {
    const model = chicagoModel(4);
    const pairs = carriagewayPairs(model);
    const widths = model.city.roads.map((road) => widthMetresForRoad(model, road.id, pairs));
    const distinct = new Set(widths.map((value) => Math.round(value * 10)));
    expect(distinct.size).toBeGreaterThan(4);
    expect(Math.min(...widths)).toBeGreaterThan(3);
    expect(Math.max(...widths)).toBeLessThan(40);
  });
});

describe("lane centres and carriageways", () => {
  const model = chicagoModel(2);
  const pairs = carriagewayPairs(model);

  it("separates opposing traffic on a shared carriageway", () => {
    const shared = model.city.roads.find((road) => isSharedCarriageway(pairs, road.id));
    expect(shared).toBeTruthy();
    if (!shared) {
      return;
    }
    // Each direction offsets to its own right, and the two paths run opposite
    // ways, so the offsets land on opposite sides of the centreline.
    const offset = laneCentreOffsetMetres(model, shared.id, pairs);
    const reverse = (pairs.partners[shared.id] ?? []).find((id) => id !== shared.id)!;
    const reverseOffset = laneCentreOffsetMetres(model, reverse, pairs);
    expect(offset).toBeGreaterThan(0);
    expect(reverseOffset).toBeGreaterThan(0);
    const path = model.directedPaths[shared.id]!;
    const reversePath = model.directedPaths[reverse]!;
    const heading = Math.atan2(
      path[path.length - 1][1] - path[0][1],
      path[path.length - 1][0] - path[0][0],
    );
    const reverseHeading = Math.atan2(
      reversePath[reversePath.length - 1][1] - reversePath[0][1],
      reversePath[reversePath.length - 1][0] - reversePath[0][0],
    );
    // Opposite headings: the "right of travel" sides are opposite sides.
    expect(Math.abs(Math.abs(heading - reverseHeading) - Math.PI)).toBeLessThan(0.35);
    // Half the direction's lane span, so a 1-lane direction sits 1.7 m out.
    expect(offset).toBeCloseTo((directionalLanes(model, shared.id) * LANE_WIDTH_M) / 2, 6);
  });

  it("keeps a one-way carriageway on its own centreline", () => {
    // A carriageway with no partner direction: a one-way street.
    const oneWay = model.city.roads.find((road) => !isSharedCarriageway(pairs, road.id));
    expect(oneWay).toBeTruthy();
    if (!oneWay) {
      return;
    }
    expect(laneCentreOffsetMetres(model, oneWay.id, pairs)).toBe(0);
  });
});
