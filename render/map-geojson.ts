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
import { pointInPolygon } from "@/cities/map-model";
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
  rings: readonly (readonly Point[])[],
  properties: Record<string, string | number | boolean>,
): Feature<PolygonGeometry> {
  return {
    type: "Feature",
    properties,
    // Outer ring first, then holes: MapLibre renders inner rings as cut-outs.
    geometry: { type: "Polygon", coordinates: rings.map((ring) => closedRing(projection, ring)) },
  };
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
  readonly labels: FeatureCollection<PointGeometry>;
  /** Real street/highway names, line-placed at neighborhood zoom. */
  readonly streetLabels: FeatureCollection<LineGeometry>;
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
          [
            [model.bounds.minX, model.bounds.minY],
            [model.bounds.maxX, model.bounds.minY],
            [model.bounds.maxX, model.bounds.maxY],
            [model.bounds.minX, model.bounds.maxY],
          ],
        ],
        { kind: "land" },
      ),
    ],
  };
  const districts: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.districts.map((district) =>
      polygonFeature(projection, district.rings, { id: district.id, name: district.name, kind: district.kind }),
    ),
  };
  const water: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.water.map((entry, index) =>
      polygonFeature(projection, entry.rings, {
        id: `water-${index}`,
        kind: entry.kind,
        areaM2: Math.round(entry.areaM2),
      }),
    ),
  };
  const parks: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.parks.map((entry, index) =>
      polygonFeature(projection, entry.rings, {
        id: `park-${index}`,
        kind: entry.kind,
        areaM2: Math.round(entry.areaM2),
      }),
    ),
  };
  // Canopy: deterministic groves inside park polygons (a grid with a fixed
  // pattern), so parks read as planted ground rather than flat green squares.
  const canopyFeatures: Feature<PointGeometry>[] = [];
  for (const polygon of model.parks.map((entry) => entry.rings[0])) {
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
      const outerRing = building.rings[0];
      let area = 0;
      for (let i = 0, j = outerRing.length - 1; i < outerRing.length; j = i, i += 1) {
        const [xi, yi] = outerRing[i];
        const [xj, yj] = outerRing[j];
        area += xj * yi - xi * yj;
      }
      return polygonFeature(projection, building.rings, {
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
      // Physical metadata for the style: width in metres, class, structure.
      widthM: piece.widthM,
      lanesTotal: piece.lanesTotal,
      osmClass: piece.osmClass,
      bridge: piece.bridgeStructure,
      tunnel: piece.tunnel,
      layer: piece.layer,
      oneway: piece.oneway,
    });
    // Hierarchy follows the OSM class, never "it is a bridge": a motorway
    // bridge stays a motorway on screen.
    if (piece.osmClass === "motorway" || piece.osmClass === "trunk" || piece.osmClass.endsWith("_link")) {
      highway.push(feature);
    } else if (
      piece.osmClass === "primary" ||
      piece.osmClass === "secondary" ||
      piece.osmClass === "tertiary"
    ) {
      arterial.push(feature);
    } else {
      local.push(feature);
    }
    if (piece.bridgeStructure) {
      bridge.push(feature);
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
        polygonFeature(projection, landmark.rings, { id: landmark.id, name: landmark.name, kind: landmark.kind }),
      ),
    },
    labels: {
      type: "FeatureCollection",
      // Symbol-layer labels: MapLibre's collision engine places these, so they
      // never stack on each other or across traffic the way DOM markers did.
      features: model.labels.map((label) =>
        pointFeature(projection, label.at, {
          name: label.name,
          // Priority order: 1 landmark, 2 district, 3 highway ref, 4 arterial.
          rank: label.kind === "landmark" ? label.rank : label.rank + 2,
          kind: label.kind,
        }),
      ),
    },
    // Real Chicago street and highway names, line-placed and limited to the
    // roads that carry a name worth reading at neighborhood zoom.
    streetLabels: {
      type: "FeatureCollection",
      features: model.streets
        .filter(
          (piece) =>
            piece.name !== undefined &&
            (piece.osmClass === "motorway" ||
              piece.osmClass === "trunk" ||
              piece.osmClass === "primary" ||
              piece.osmClass === "secondary"),
        )
        .map((piece) =>
          lineFeature(projection, piece.points, {
            name: piece.name ?? "",
            ref: piece.ref ?? "",
            osmClass: piece.osmClass,
            rank: piece.osmClass === "motorway" || piece.osmClass === "trunk" ? 3 : 4,
          }),
        ),
    },
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
