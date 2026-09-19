/**
 * Presentation map model (Phase 1): the contract every showcase geography must
 * satisfy, plus the one documented projection between simulation metres and
 * WGS84 lng/lat.
 *
 * Chicago assets are compiled into this shape; the renderer, the GeoJSON
 * builder and the deck.gl layers only ever see this model. Framework-free and
 * deterministic — importable by the worker.
 */
import type { City, CitySize, RoadKind } from "@/sim/types";
import type { Point } from "./paths";

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/**
 * Local equirectangular tangent plane at the extent centre. The preprocessing
 * tool emits the same numbers, so metric -> lng/lat is exact for the data.
 */
export interface Projection {
  readonly originLon: number;
  readonly originLat: number;
  readonly metresPerDegreeLon: number;
  readonly metresPerDegreeLat: number;
}

/** Central physical lane width (metres). One constant for width and placement. */
export const LANE_WIDTH_M = 3.4;
/** Casing/shoulder allowance so a 2-lane street is not exactly 6.8 m wide. */
export const ROAD_CASING_M = 1.6;
/** Narrowest a carriageway renders before it stops reading as a road. */
export const MIN_CARRIAGEWAY_M = 3.6;
/** Ramps stay physically narrower than the road they leave. */
export const RAMP_WIDTH_FACTOR = 0.72;

/** Physical width of a carriageway with `lanes` lanes, ramps included. */
export function carriagewayWidthMetres(lanes: number, isRamp: boolean): number {
  const base = Math.max(MIN_CARRIAGEWAY_M, lanes * LANE_WIDTH_M + ROAD_CASING_M);
  return isRamp ? base * RAMP_WIDTH_FACTOR : base;
}

/**
 * One polygon as rings: the outer ring first, then any inner rings (holes).
 * Courtyards, stadium bowls and islands must stay holes rather than being
 * flattened into solid shapes, so holes travel all the way to MapLibre.
 */
export type PolygonRings = readonly (readonly Point[])[];

export interface BuildingFootprint {
  readonly district: string;
  readonly rings: PolygonRings;
  /** Larger footprints get a darker tone (towers, stadiums, warehouses). */
  readonly prominent: boolean;
}

export interface StreetPiece {
  readonly streetId: string;
  readonly kind: RoadKind;
  readonly district: string;
  readonly bridge?: { readonly name: string; readonly rank: number };
  readonly points: readonly Point[];
  readonly length: number;
  /** Every directed road this physical piece covers (1 for one-way streets). */
  readonly roadIds: readonly number[];
  /** Underlying OSM class, so a motorway bridge keeps motorway hierarchy. */
  readonly osmClass: string;
  /** Real OSM name, for line-placed street labels. */
  readonly name?: string;
  /** Real OSM ref (e.g. "I-90"), for highway shields. */
  readonly ref?: string;
  /** Lanes across the whole carriageway (both directions when shared). */
  readonly lanesTotal: number;
  /** Physical width in metres, from lanes and class. */
  readonly widthM: number;
  readonly bridgeStructure: boolean;
  readonly tunnel: boolean;
  readonly layer: number;
  readonly oneway: boolean;
}

/** Even-odd point-in-ring test in the metric frame. */
export function pointInPolygon(point: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1]) {
      const x = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
      if (point[0] < x) {
        inside = !inside;
      }
    }
  }
  return inside;
}

/**
 * A polygon plus what it is worth showing. `kind` and `areaM2` let the map rank
 * a lake above the river and the river above a fountain, and show meaningful
 * green space rather than every grass sliver.
 */
export interface PolygonFeature {
  readonly rings: PolygonRings;
  readonly areaM2: number;
  /** Water: "lake" | "river" | "water". Parks: "major" | "minor". */
  readonly kind: string;
}

export interface WaterCrossingBridge {
  readonly groupId: number;
  readonly roadId: number;
  readonly name: string;
  /** Midpoint of the crossing, for labels and markers. */
  readonly at: Point;
}

export interface MapLabel {
  readonly name: string;
  readonly at: Point;
  readonly rank: number;
  readonly kind: "district" | "landmark";
}

export interface MapDistrict {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly rings: PolygonRings;
}

export interface MapLandmark {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly rings: PolygonRings;
}

export interface MapModel {
  readonly scaleIndex: number;
  readonly size: CitySize;
  readonly city: City;
  readonly projection: Projection;
  readonly streets: readonly StreetPiece[];
  /** Directed road id -> presentation path (oriented from -> to); null when absent. */
  readonly directedPaths: readonly (readonly Point[] | null)[];
  readonly buildings: readonly BuildingFootprint[];
  /** Water and park polygons, each carrying its own rings (holes included). */
  readonly water: readonly PolygonFeature[];
  readonly parks: readonly PolygonFeature[];
  /**
   * Bridge groups whose geometry genuinely crosses extracted water — the only
   * ones a "bridge closed" incident may target on the Chicago showcase. A
   * highway viaduct or an overpass over land is a bridge too, but closing one
   * is meaningless to a viewer.
   */
  readonly waterCrossingBridges: readonly WaterCrossingBridge[];
  readonly districts: readonly MapDistrict[];
  readonly landmarks: readonly MapLandmark[];
  readonly labels: readonly MapLabel[];
  readonly bounds: Bounds;
  readonly centralCamera: Bounds;
  readonly cityCamera: Bounds;
  readonly stats: {
    intersections: number;
    roads: number;
    buildings: number;
    signals: number;
    stops: number;
  };
}

/** Local metres -> WGS84 (the inverse of the preprocessing projection). */
export function metricToLngLat(
  projection: Projection,
  x: number,
  y: number,
): [number, number] {
  return [
    projection.originLon + x / projection.metresPerDegreeLon,
    projection.originLat + y / projection.metresPerDegreeLat,
  ];
}

/** WGS84 -> local metres. */
export function lngLatToMetric(
  projection: Projection,
  lon: number,
  lat: number,
): Point {
  return [
    (lon - projection.originLon) * projection.metresPerDegreeLon,
    (lat - projection.originLat) * projection.metresPerDegreeLat,
  ];
}

/** Bounds of a point list, or null for an empty list. */
export function pointsBounds(points: readonly Point[]): Bounds | null {
  if (points.length === 0) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}
