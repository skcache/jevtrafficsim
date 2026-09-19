/**
 * One physical model for road width, lane centres and vehicle placement.
 *
 * Before this module, road visual width, vehicle offset, vehicle glyph size and
 * lane count were unrelated: every vehicle sat at a fixed 3.2 m offset whatever
 * the road was, so cars read as an overlay on the map rather than traffic inside
 * a street. Everything physical now derives from the directional lane counts the
 * importer emits, so a 3-lane one-way street is visibly wider than a 1-lane
 * residential street and opposing traffic on a shared carriageway separates.
 *
 * US right-hand traffic. All lengths are metres in the model's metric frame;
 * `*PxAt` helpers convert to pixels at a given zoom using Chicago's latitude.
 */
import type { MapModel } from "@/cities/map-model";

import {
  LANE_WIDTH_M,
  ROAD_CASING_M,
  MIN_CARRIAGEWAY_M,
  RAMP_WIDTH_FACTOR,
  carriagewayWidthMetres,
} from "@/cities/map-model";

export { LANE_WIDTH_M, ROAD_CASING_M, MIN_CARRIAGEWAY_M, RAMP_WIDTH_FACTOR };

const CHICAGO_LATITUDE = 41.881;
const EARTH_CIRCUMFERENCE_PX = 156543.03392;

/** Metres covered by one screen pixel at `zoom` and Chicago's latitude. */
export function metresPerPixel(zoom: number): number {
  return (EARTH_CIRCUMFERENCE_PX * Math.cos((CHICAGO_LATITUDE * Math.PI) / 180)) / 2 ** zoom;
}

/** Pixel width for a physical width at a zoom (never below `minPx`). */
export function widthPxAt(zoom: number, widthMetres: number, minPx = 0.6): number {
  return Math.max(minPx, widthMetres / metresPerPixel(zoom));
}

/**
 * Directed roads paired by carriageway: two directed roads that are the same
 * physical street (both directions of one roadway) share a carriageway, while a
 * one-way street is its own carriageway.
 */
export function carriagewayPairs(model: MapModel): {
  readonly partners: readonly (readonly number[])[];
  readonly indexOf: readonly number[];
} {
  const byPair = new Map<string, number[]>();
  for (const road of model.city.roads) {
    const key = `${Math.min(road.from, road.to)}:${Math.max(road.from, road.to)}`;
    const list = byPair.get(key) ?? [];
    list.push(road.id);
    byPair.set(key, list);
  }
  const partners: number[][] = model.city.roads.map(() => []);
  const indexOf: number[] = model.city.roads.map(() => -1);
  let index = 0;
  for (const list of byPair.values()) {
    for (const roadId of list) {
      partners[roadId] = list;
      indexOf[roadId] = index;
    }
    index += 1;
  }
  return { partners, indexOf };
}

/** Directional lanes of the road itself. */
export function directionalLanes(model: MapModel, roadId: number): number {
  return Math.max(1, model.city.roads[roadId]?.lanes ?? 1);
}

/**
 * Lanes across the whole carriageway: both directions on a shared roadway, or
 * just this direction on a one-way carriageway.
 */
export function carriagewayLanes(
  model: MapModel,
  roadId: number,
  pairs: { readonly partners: readonly (readonly number[])[] },
): number {
  let lanes = 0;
  for (const other of pairs.partners[roadId] ?? [roadId]) {
    lanes += directionalLanes(model, other);
  }
  return Math.max(1, lanes);
}

/** Physical width of the carriageway this directed road belongs to. */
export function widthMetresForRoad(
  model: MapModel,
  roadId: number,
  pairs: { readonly partners: readonly (readonly number[])[] },
): number {
  const road = model.city.roads[roadId];
  const lanes = carriagewayLanes(model, roadId, pairs);
  // Ramps stay visibly narrower than the road they leave.
  const isRamp = road?.kind === "highway" && road.lanes <= 1;
  return carriagewayWidthMetres(lanes, isRamp);
}

/**
 * Offset from the centreline to the centre of this direction's lane group.
 *
 * On a shared carriageway each direction keeps to its own side, so opposing
 * traffic separates: the offset is half the direction's lane span, applied to
 * the right of that direction's own heading (both directions call this with
 * their own path orientation, which puts them on opposite sides). A one-way
 * carriageway has no partner to separate from, so its traffic runs on the
 * carriageway centre.
 */
export function laneCentreOffsetMetres(
  model: MapModel,
  roadId: number,
  pairs: { readonly partners: readonly (readonly number[])[] },
): number {
  const partners = pairs.partners[roadId] ?? [roadId];
  if (partners.length < 2) {
    return 0;
  }
  const lanes = directionalLanes(model, roadId);
  return (lanes * LANE_WIDTH_M) / 2;
}

/** True when this directed road is one of two directions on one carriageway. */
export function isSharedCarriageway(
  pairs: { readonly partners: readonly (readonly number[])[] },
  roadId: number,
): boolean {
  return (pairs.partners[roadId] ?? [roadId]).length > 1;
}

/**
 * Class-specific physical length used for queue packing (bumper to bumper) and
 * for sizing the glyph. Bicycles are short, trucks are long and boxy.
 */
export const VEHICLE_LENGTH_M: Record<string, number> = {
  car: 4.6,
  truck: 8.2,
  bicycle: 1.9,
};
/** Gap left between queued vehicles. */
export const QUEUE_GAP_M = 1.1;
