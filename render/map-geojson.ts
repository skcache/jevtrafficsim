/**
 * Showcase GeoJSON (Task 11 visual correction): converts the compiled model
 * into local GeoJSON FeatureCollections consumed by MapLibre layers. All data
 * is ours — no remote tiles, no external basemap, no attribution needed.
 *
 * Coordinates: the showcase world is in metres; we place it at the equator
 * (1° ≈ 111 320 m) so MapLibre's camera, pan and zoom work naturally.
 * Framework-free and deterministic.
 */
import { metricToLngLat, type MapModel, type Projection } from "@/cities/map-model";
import type { Point } from "@/cities/paths";

export type LngLat = readonly [number, number];

/**
 * Local metres -> WGS84 through the model's own projection (the same numbers
 * the preprocessing tool used), so the map draws exactly what the sim
 * simulates. Coordinates are quantized to ~1 cm of longitude/latitude.
 */
export function toLngLat(projection: Projection, point: Point): LngLat {
  const [lon, lat] = metricToLngLat(projection, point[0], point[1]);
  return [
    Math.round(lon * 1e7) / 1e7,
    Math.round(lat * 1e7) / 1e7,
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

interface PointGeometry {
  readonly type: "Point";
  readonly coordinates: LngLat;
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
function closedRing(projection: Projection, points: readonly Point[]): LngLat[] {
  const ring = points.map((point) => toLngLat(projection, point));
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first && last && (first[0] !== last[0] || first[1] !== last[1])) {
    ring.push(first);
  }
  return ring;
}

function polygonFeature(
  projection: Projection,
  points: readonly Point[],
  properties: Record<string, string | number | boolean>,
): Feature<PolygonGeometry> {
  return { type: "Feature", properties, geometry: { type: "Polygon", coordinates: [closedRing(projection, points)] } };
}

function pointFeature(
  projection: Projection,
  point: Point,
  properties: Record<string, string | number | boolean>,
): Feature<PointGeometry> {
  return {
    type: "Feature",
    properties,
    geometry: { type: "Point", coordinates: toLngLat(projection, point) },
  };
}

function lineFeature(
  projection: Projection,
  points: readonly Point[],
  properties: Record<string, string | number | boolean>,
): Feature<LineGeometry> {
  return {
    type: "Feature",
    properties,
    geometry: { type: "LineString", coordinates: points.map((p) => toLngLat(projection, p)) },
  };
}

export interface ShowcaseLabels {
  readonly name: string;
  readonly at: LngLat;
  readonly rank: number;
  readonly kind: "district" | "landmark";
}

/** Ray-cast point-in-polygon (deterministic, no dependencies). */
function pointInPolygon(point: readonly [number, number], polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
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
 * Crude inward offset: scales the polygon about its centroid so canopy blobs
 * keep clear of the park edge. Parks are convex enough for this to hold.
 */
function insetRing(polygon: readonly Point[], metres: number): Point[] {
  const cx = polygon.reduce((sum, [x]) => sum + x, 0) / polygon.length;
  const cy = polygon.reduce((sum, [, y]) => sum + y, 0) / polygon.length;
  return polygon.map(([x, y]) => {
    const dx = x - cx;
    const dy = y - cy;
    const length = Math.hypot(dx, dy) || 1;
    const scale = Math.max(0, (length - metres) / length);
    return [cx + dx * scale, cy + dy * scale];
  });
}

export interface ShowcaseGeoJson {
  readonly land: FeatureCollection<PolygonGeometry>;
  readonly districts: FeatureCollection<PolygonGeometry>;
  readonly water: FeatureCollection<PolygonGeometry>;
  readonly parks: FeatureCollection<PolygonGeometry>;
  readonly parkCanopy: FeatureCollection<PointGeometry>;
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

export function buildShowcaseGeoJson(model: MapModel): ShowcaseGeoJson {
  const projection = model.projection;
  const land: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: [
      polygonFeature(
        projection,
        [
          [model.bounds.minX, model.bounds.minY],
          [model.bounds.maxX, model.bounds.minY],
          [model.bounds.maxX, model.bounds.maxY],
          [model.bounds.minX, model.bounds.maxY],
        ],
        { kind: "land" },
      ),
    ],
  };
  const districts: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.districts.map((district) =>
      polygonFeature(projection, district.polygon, { id: district.id, name: district.name, kind: district.kind }),
    ),
  };
  const water: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.water.map((polygon, index) => polygonFeature(projection, polygon, { id: `water-${index}` })),
  };
  const parks: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.parks.map((polygon, index) => polygonFeature(projection, polygon, { id: `park-${index}` })),
  };
  // Canopy: deterministic groves inside park polygons (a grid with a fixed
  // pattern), so parks read as planted ground rather than flat green squares.
  const canopyFeatures: Feature<PointGeometry>[] = [];
  for (const polygon of model.parks) {
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const step = 26;
    for (let x = Math.min(...xs) + step / 2; x < Math.max(...xs); x += step) {
      for (let y = Math.min(...ys) + step / 2; y < Math.max(...ys); y += step) {
        const ix = Math.round((x - Math.min(...xs)) / step);
        const iy = Math.round((y - Math.min(...ys)) / step);
        if ((ix * 7 + iy * 13) % 5 >= 3) {
          continue;
        }
        if (!pointInPolygon([x, y], polygon) || !pointInPolygon([x, y], insetRing(polygon, 9))) {
          continue;
        }
        canopyFeatures.push(pointFeature(projection, [x, y], { r: 6 + (((ix * 3 + iy * 5) % 3) * 2) }));
      }
    }
  }
  const parkCanopy: FeatureCollection<PointGeometry> = {
    type: "FeatureCollection",
    features: canopyFeatures,
  };

  const buildings: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.buildings.map((building) => {
      // Shoelace area (m²) drives the three building tones in the map style.
      let area = 0;
      for (let i = 0, j = building.polygon.length - 1; i < building.polygon.length; j = i, i += 1) {
        const [xi, yi] = building.polygon[i];
        const [xj, yj] = building.polygon[j];
        area += xj * yi - xi * yj;
      }
      return polygonFeature(projection, building.polygon, {
        district: building.district,
        prominent: building.prominent,
        area: Math.round(Math.abs(area) / 2),
      });
    }),
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
    const feature = lineFeature(projection, piece.points, {
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
    parkCanopy,
    buildings,
    roadsLocal: { ...roadsLocal, features: local },
    roadsArterial: { ...roadsArterial, features: arterial },
    roadsHighway: { ...roadsHighway, features: highway },
    bridges: { ...bridges, features: bridge },
    landmarks: {
      type: "FeatureCollection",
      features: model.landmarks.map((landmark) =>
        polygonFeature(projection, landmark.polygon, { id: landmark.id, name: landmark.name, kind: landmark.kind }),
      ),
    },
    labels: model.labels.map((label) => ({
      name: label.name,
      at: toLngLat(projection, label.at),
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
