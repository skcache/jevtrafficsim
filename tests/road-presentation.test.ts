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
  laneKeyFor,
  laneSlotFor,
  roadVisualScaleAt,
  vehicleLaneOffsetMetres,
  widthMetresForRoad,
  LANE_WIDTH_M,
  RAMP_WIDTH_FACTOR,
} from "@/render/road-presentation";
import { carriagewayWidthMetres } from "@/cities/map-model";
import { chicagoModel } from "./chicago-support";

describe("road width by lanes and class", () => {
  it("grows presentation width materially as inspection zoom increases", () => {
    expect(roadVisualScaleAt(13)).toBeCloseTo(1.06, 6);
    expect(roadVisualScaleAt(17)).toBeCloseTo(1.4, 6);
    expect(roadVisualScaleAt(18.5)).toBeCloseTo(1.75, 6);
    expect(roadVisualScaleAt(19.5)).toBeCloseTo(2.05, 6);
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

describe("lane slots along one physical road", () => {
  const model = chicagoModel(4);
  const pairs = carriagewayPairs(model);
  const baseOffsets = model.city.roads.map((road) => laneCentreOffsetMetres(model, road.id, pairs));

  it("keys a lane slot on the corridor, not the junction-split road id", () => {
    const corridor = model.city.corridors.find(
      (candidate) => candidate.kind === "highway" && candidate.roadIds.length >= 3,
    );
    expect(corridor, "an expressway corridor exists").toBeTruthy();
    if (!corridor) {
      return;
    }
    for (const roadId of corridor.roadIds) {
      expect(laneKeyFor(model.city, roadId)).toBe(corridor.id);
    }
  });

  it("holds one lane across consecutive segments of the same corridor", () => {
    // The importer splits one street into a road per junction. A road-id-keyed
    // slot re-rolled at every split: measured on the live map, the ego on I-290
    // drifted -3.4 m -> +1.7 m -> 0 m -> -5.1 m across four consecutive
    // segments of the same expressway, i.e. it changed lanes at each junction.
    const egoVehicleId = 0;
    const headingOf = (roadId: number): number | null => {
      const points = model.directedPaths[roadId];
      if (!points || points.length < 2) {
        return null;
      }
      const head = points[0];
      const tail = points[points.length - 1];
      return Math.atan2(tail[1] - head[1], tail[0] - head[0]);
    };
    let directionsChecked = 0;
    for (const corridor of model.city.corridors) {
      const segments = corridor.roadIds.filter((roadId) => model.city.roads[roadId]);
      if (segments.length < 2) {
        continue;
      }
      const reference = headingOf(segments[0]);
      if (reference === null) {
        continue;
      }
      // A corridor carries BOTH directions of a street. A vehicle holds its
      // lane within its own direction of travel, never across the oncoming one
      // (the two directions offset to opposite sides of the centreline).
      const ownDirection = segments.filter((roadId) => {
        const heading = headingOf(roadId);
        return heading !== null && Math.cos(heading - reference) > 0;
      });
      if (ownDirection.length < 2) {
        continue;
      }
      const lanes = new Set(ownDirection.map((roadId) => directionalLanes(model, roadId)));
      if (lanes.size !== 1) {
        continue; // a merge or a split legitimately re-centres the car
      }
      // The invariant is the lane WITHIN the direction's group: the base offset
      // may legitimately change where a street's carriageway structure changes
      // (a two-way piece becomes a one-way piece), the lane slot may not.
      const slotOffset = (roadId: number) =>
        vehicleLaneOffsetMetres(model.city, baseOffsets, egoVehicleId, roadId) - baseOffsets[roadId];
      const first = slotOffset(ownDirection[0]);
      for (const roadId of ownDirection.slice(1)) {
        expect(slotOffset(roadId), `corridor ${corridor.id} road ${roadId}`).toBeCloseTo(first, 9);
      }
      directionsChecked += 1;
      if (directionsChecked >= 25) {
        break;
      }
    }
    expect(directionsChecked).toBeGreaterThan(10);
  });

  it("keeps every lane slot inside the lanes the road actually has", () => {
    for (const road of model.city.roads) {
      const lanes = directionalLanes(model, road.id);
      const slot = laneSlotFor(0, laneKeyFor(model.city, road.id), lanes);
      expect(slot).toBeGreaterThanOrEqual(0);
      expect(slot).toBeLessThan(lanes);
    }
  });

  it("spreads different vehicles across the lanes of one road", () => {
    const wide = model.city.roads.find((road) => directionalLanes(model, road.id) === 4);
    expect(wide, "a four-lane road exists").toBeTruthy();
    if (!wide) {
      return;
    }
    const key = laneKeyFor(model.city, wide.id);
    const slots = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((vehicleId) => laneSlotFor(vehicleId, key, 4)));
    expect(slots.size).toBe(4);
  });

  it("falls back to the road itself when no corridor claims it", () => {
    const bare = { ...model.city, corridors: [] };
    expect(laneKeyFor(bare, 7)).toBe(7);
  });
});
