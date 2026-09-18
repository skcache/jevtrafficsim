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

export interface BuildingFootprint {
  readonly district: string;
  readonly polygon: readonly Point[];
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
  readonly polygon: readonly Point[];
}

export interface MapLandmark {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly polygon: readonly Point[];
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
  readonly water: readonly (readonly Point[])[];
  readonly parks: readonly (readonly Point[])[];
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
