/**
 * Showcase GeoJSON (Task 11 visual correction): converts the compiled model
 * into local GeoJSON FeatureCollections consumed by MapLibre layers. All data
 * is ours — no remote tiles, no external basemap, no attribution needed.
 *
 * Coordinates: the showcase world is in metres; we place it at the equator
 * (1° ≈ 111 320 m) so MapLibre's camera, pan and zoom work naturally.
 * Framework-free and deterministic.
 */
import type { ShowcaseMapModel } from "@/cities/showcase-city";
import type { Point } from "@/cities/paths";

export const METRES_PER_DEGREE = 111_320;

export type LngLat = readonly [number, number];

export function toLngLat(point: Point): LngLat {
  return [
    Math.round((point[0] / METRES_PER_DEGREE) * 1e7) / 1e7,
    Math.round((point[1] / METRES_PER_DEGREE) * 1e7) / 1e7,
  ];
}

interface Feature<G> {
  readonly type: "Feature";
  readonly properties: Record<string, string | number | boolean>;
  readonly geometry: G;
}

interface FeatureCollection<G> {
  readonly type: "FeatureCollection";
  readonly features: readonly Feature<G>[];
}

interface PolygonGeometry {
  readonly type: "Polygon";
  readonly coordinates: readonly (readonly LngLat[])[];
}

interface LineGeometry {
  readonly type: "LineString";
  readonly coordinates: readonly LngLat[];
}

/** GeoJSON polygons must be closed rings. */
function closedRing(points: readonly Point[]): LngLat[] {
  const ring = points.map(toLngLat);
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push(first);
  }
  return ring;
}

function polygonFeature(
  points: readonly Point[],
  properties: Record<string, string | number | boolean>,
): Feature<PolygonGeometry> {
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [closedRing(points)] } };
}

function lineFeature(
  points: readonly Point[],
  properties: Record<string, string | number | boolean>,
): Feature<LineGeometry> {
  return { type: "Feature", properties, geometry: { type: "LineString", coordinates: points.map(toLngLat) } };
}

export interface ShowcaseLabels {
  readonly name: string;
  readonly at: LngLat;
  readonly rank: number;
  readonly kind: "district" | "landmark";
}

export interface ShowcaseGeoJson {
  readonly land: FeatureCollection<PolygonGeometry>;
  readonly districts: FeatureCollection<PolygonGeometry>;
  readonly water: FeatureCollection<PolygonGeometry>;
  readonly parks: FeatureCollection<PolygonGeometry>;
  readonly buildings: FeatureCollection<PolygonGeometry>;
  readonly roadsLocal: FeatureCollection<LineGeometry>;
  readonly roadsArterial: FeatureCollection<LineGeometry>;
  readonly roadsHighway: FeatureCollection<LineGeometry>;
  readonly bridges: FeatureCollection<LineGeometry>;
  readonly landmarks: FeatureCollection<PolygonGeometry>;
  readonly labels: readonly ShowcaseLabels[];
  /** Ordered layer ids for the MapLibre style. */
  readonly layerOrder: readonly string[];
}

export function buildShowcaseGeoJson(model: ShowcaseMapModel): ShowcaseGeoJson {
  const land: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: [
      polygonFeature(
        [
          [0, 0],
          [5600, 0],
          [5600, 4600],
          [0, 4600],
        ],
        { kind: "land" },
      ),
    ],
  };
  const districts: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.districts.map((district) =>
      polygonFeature(district.polygon, { id: district.id, name: district.name, kind: district.kind }),
    ),
  };
  const water: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.water.map((polygon, index) => polygonFeature(polygon, { id: `water-${index}` })),
  };
  const parks: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.parks.map((polygon, index) => polygonFeature(polygon, { id: `park-${index}` })),
  };
  const buildings: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.buildings.map((building) =>
      polygonFeature(building.polygon, {
        district: building.district,
        prominent: building.prominent,
      }),
    ),
  };
  const roadsLocal: FeatureCollection<LineGeometry> = { type: "FeatureCollection", features: [] };
  const roadsArterial: FeatureCollection<LineGeometry> = { type: "FeatureCollection", features: [] };
  const roadsHighway: FeatureCollection<LineGeometry> = { type: "FeatureCollection", features: [] };
  const bridges: FeatureCollection<LineGeometry> = { type: "FeatureCollection", features: [] };
  const local: Feature<LineGeometry>[] = [];
  const arterial: Feature<LineGeometry>[] = [];
  const highway: Feature<LineGeometry>[] = [];
  const bridge: Feature<LineGeometry>[] = [];
  for (const piece of model.streets) {
    // One line per PHYSICAL street piece: the two directed roads are the same
    // geometry and must not be drawn twice.
    const feature = lineFeature(piece.points, {
      streetId: piece.streetId,
      kind: piece.kind,
      district: piece.district,
      name: piece.bridge?.name ?? "",
    });
    if (piece.kind === "bridge") {
      bridge.push(feature);
    } else if (piece.kind === "highway") {
      highway.push(feature);
    } else if (piece.kind === "arterial") {
      arterial.push(feature);
    } else {
      local.push(feature);
    }
  }
  return {
    land,
    districts,
    water,
    parks,
    buildings,
    roadsLocal: { ...roadsLocal, features: local },
    roadsArterial: { ...roadsArterial, features: arterial },
    roadsHighway: { ...roadsHighway, features: highway },
    bridges: { ...bridges, features: bridge },
    landmarks: {
      type: "FeatureCollection",
      features: model.landmarks.map((landmark) =>
        polygonFeature(landmark.polygon, { id: landmark.id, name: landmark.name, kind: landmark.kind }),
      ),
    },
    labels: model.labels.map((label) => ({
      name: label.name,
      at: toLngLat(label.at),
      rank: label.rank,
      kind: label.kind,
    })),
    layerOrder: [
      "land",
      "district-tint",
      "water",
      "parks",
      "buildings",
      "roads-local-casing",
      "roads-local",
      "roads-arterial-casing",
      "roads-arterial",
      "roads-highway-casing",
      "roads-highway",
      "bridges-casing",
      "bridges",
      "landmarks",
      "road-markings",
    ],
  };
}
