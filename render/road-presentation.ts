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
import type { City } from "@/sim/types";

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

/**
 * Presentation scale for roads. Physical map scaling already makes a road grow
 * with zoom; this adds a deliberate close-inspection exaggeration so streets do
 * not remain hairlines while cars and traffic lights become legible.
 */
export function roadVisualScaleAt(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return 1;
  }
  const stops: readonly [number, number][] = [
    [9, 0.95],
    [11, 1],
    [13, 1.06],
    [15, 1.16],
    [17, 1.4],
    [18.5, 1.75],
    [19.5, 2.05],
  ];
  if (zoom <= stops[0][0]) {
    return stops[0][1];
  }
  for (let i = 1; i < stops.length; i += 1) {
    const [z1, s1] = stops[i];
    const [z0, s0] = stops[i - 1];
    if (zoom <= z1) {
      const t = (zoom - z0) / (z1 - z0);
      return s0 + (s1 - s0) * t;
    }
  }
  return stops[stops.length - 1][1];
}

/** Pixel width for a physical width at a zoom (never below `minPx`). */
export function widthPxAt(zoom: number, widthMetres: number, minPx = 0.6): number {
  return Math.max(minPx, (widthMetres * roadVisualScaleAt(zoom)) / metresPerPixel(zoom));
}

/**
 * Directed roads grouped by carriageway.
 *
 * The authority is `model.streets[].roadIds` — the physical StreetPiece the
 * compiler built from the importer's carriageway model. Deriving the grouping
 * from unordered `from`/`to` node pairs instead (as this did) is not
 * authoritative: two geometrically distinct carriageways that happen to share
 * logical endpoints — a divided roadway, a one-way pair rejoining the same two
 * intersections — were merged into one carriageway, which then reported double
 * the lanes, double the width and the wrong lane centres.
 *
 * `widthM` is likewise the piece's own physical width, not a recomputation.
 */
export function carriagewayPairs(model: MapModel): {
  readonly partners: readonly (readonly number[])[];
  readonly indexOf: readonly number[];
  readonly pieceOf: readonly number[];
  readonly widthM: readonly number[];
} {
  const count = model.city.roads.length;
  const partners: number[][] = model.city.roads.map(() => []);
  const indexOf: number[] = model.city.roads.map(() => -1);
  const pieceOf: number[] = model.city.roads.map(() => -1);
  const widthM: number[] = model.city.roads.map(() => 0);
  model.streets.forEach((piece, pieceIndex) => {
    const members = [...piece.roadIds].sort((a, b) => a - b);
    for (const roadId of members) {
      if (roadId < 0 || roadId >= count) {
        continue;
      }
      partners[roadId] = members;
      indexOf[roadId] = pieceIndex;
      pieceOf[roadId] = pieceIndex;
      widthM[roadId] = piece.widthM;
    }
  });
  // Any directed road the compiler did not place in a piece stands alone.
  for (let roadId = 0; roadId < count; roadId += 1) {
    if (partners[roadId].length === 0) {
      partners[roadId] = [roadId];
      indexOf[roadId] = pieceOf[roadId] = -1;
      const road = model.city.roads[roadId];
      widthM[roadId] = carriagewayWidthMetres(
        Math.max(1, road?.lanes ?? 1),
        road?.kind === "highway" && (road?.lanes ?? 1) <= 1,
      );
    }
  }
  return { partners, indexOf, pieceOf, widthM };
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
  pairs: { readonly partners: readonly (readonly number[])[]; readonly widthM?: readonly number[] },
): number {
  const declared = pairs.widthM?.[roadId];
  if (typeof declared === "number" && declared > 0) {
    return declared;
  }
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
  /**
   * Lane slot within this direction's group. Omit it for the group CENTRE
   * (what a single vehicle on the road should use); pass a slot to spread
   * several vehicles across the lanes the road actually has.
   */
  slot?: number,
): number {
  const partners = pairs.partners[roadId] ?? [roadId];
  const lanes = directionalLanes(model, roadId);
  // Shared carriageway: this direction keeps to its own half. One-way
  // carriageway: its traffic runs on the carriageway centre.
  const base = partners.length < 2 ? 0 : (lanes * LANE_WIDTH_M) / 2;
  if (slot === undefined) {
    return base;
  }
  const clamped = Math.max(0, Math.min(lanes - 1, slot));
  return base + (clamped - (lanes - 1) / 2) * LANE_WIDTH_M;
}

/**
 * Deterministic presentation-only lane assignment: the same vehicle keeps the
 * same lane on the same road, and different vehicles spread across the lanes
 * the road actually has. Simulation truth is untouched — this only decides where
 * on the carriageway the glyph is painted.
 */
export function laneSlotFor(vehicleId: number, roadId: number, lanes: number): number {
  if (lanes <= 1) {
    return 0;
  }
  // A cheap stable mix: consecutive ids land on different lanes on one road
  // while staying spread within the road's own lane count.
  return Math.abs((vehicleId * 2654435761 + roadId * 40503) % lanes);
}

/**
 * Stable physical lane offset for one vehicle on one directed road.
 *
 * `baseOffsets` contains the centre of the direction's lane group. This helper
 * adds the per-vehicle lane slot inside that group so interpolation, signal
 * clamping and queue packing cannot disagree about which lane a vehicle uses.
 */
export function vehicleLaneOffsetMetres(
  city: City,
  baseOffsets: readonly number[],
  vehicleId: number,
  roadId: number,
): number {
  const road = city.roads[roadId];
  const lanes = Math.max(1, road?.lanes ?? 1);
  const slot = laneSlotFor(vehicleId, roadId, lanes);
  const withinGroup = (slot - (lanes - 1) / 2) * LANE_WIDTH_M;
  return (baseOffsets[roadId] ?? 0) + withinGroup;
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
/** Extra bumper clearance behind the rendered stop/go gate. */
export const STOP_LINE_CLEARANCE_M = 0.8;

/**
 * Physical stop-line setback from an intersection centre for one incoming lane
 * group. Signal rendering and queued-vehicle placement MUST share this helper,
 * otherwise the light and the vehicle can disagree about where "stop" is.
 */
export function stopLineSetbackMetres(lanes: number): number {
  const halfLaneGroupM = (Math.max(1, lanes) * LANE_WIDTH_M) / 2;
  return Math.min(9, Math.max(5, halfLaneGroupM + 3.6));
}
