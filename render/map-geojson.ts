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

/* ------------------------------------------------------------------ */
/* Polygon debris rules                                                */
/* ------------------------------------------------------------------ */

/**
 * Geometry that is measurably debris — a clipping fragment or a simplification
 * artifact — is dropped before it reaches the style. The rules are deliberately
 * about SIZE and THINNESS, never about shape: Chicago has plenty of legitimate
 * triangular buildings where a diagonal avenue cuts a block, and those stay.
 */
const BUILDING_MIN_AREA_M2 = 25;
const SLIVER_COMPACTNESS = 0.05;

/** Shoelace area of a metric ring, in m². */
function ringArea(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let index = 0, prev = ring.length - 1; index < ring.length; prev = index, index += 1) {
    sum += ring[prev][0] * ring[index][1] - ring[index][0] * ring[prev][1];
  }
  return sum / 2;
}

/** Perimeter of a metric ring, in metres. */
function ringPerimeter(ring: readonly (readonly number[])[]): number {
  let sum = 0;
  for (let index = 1; index < ring.length; index += 1) {
    sum += Math.hypot(ring[index][0] - ring[index - 1][0], ring[index][1] - ring[index - 1][1]);
  }
  return sum;
}

/** Polsby-Popper compactness: 1 is a circle, near 0 is a hair-thin sliver. */
function compactnessOf(ring: readonly (readonly number[])[]): number {
  const area = Math.abs(ringArea(ring));
  const perimeter = ringPerimeter(ring);
  return perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 1;
}

export interface ShowcaseGeoJson {
  readonly land: FeatureCollection<PolygonGeometry>;
  readonly water: FeatureCollection<PolygonGeometry>;
  readonly parks: FeatureCollection<PolygonGeometry>;
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
    features: model.parks
      // Hair-thin fragments are debris; small gardens are real green space and
      // stay (the style decides when they are worth drawing).
      .filter((entry) => compactnessOf(entry.rings[0]) >= SLIVER_COMPACTNESS)
      .map((entry, index) =>
        polygonFeature(projection, entry.rings, {
          id: `park-${index}`,
          kind: entry.kind,
          areaM2: Math.round(entry.areaM2),
        }),
      ),
  };

  const buildings: FeatureCollection<PolygonGeometry> = {
    type: "FeatureCollection",
    features: model.buildings
      .map((building) => {
        const outerRing = building.rings[0];
        const area = Math.abs(ringArea(outerRing));
        const perimeter = ringPerimeter(outerRing);
        // Compactness (Polsby-Popper): a sliver left by clipping or by a bad
        // simplification is debris; a triangular block is a real Chicago
        // building and is kept.
        const compactness =
          perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 1;
        return { building, area, compactness };
      })
      .filter((entry) => entry.area >= BUILDING_MIN_AREA_M2 && entry.compactness >= SLIVER_COMPACTNESS)
      .map(({ building, area }) =>
        polygonFeature(projection, building.rings, {
          district: building.district,
          prominent: building.prominent,
          area: Math.round(area),
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
    // Real Chicago street and highway names, one label per NAME rather than per
    // piece: a long avenue is many OSM pieces, and labelling each of them put
    // the same name through every block. The longest piece wins, because it has
    // room to be read.
    streetLabels: {
      type: "FeatureCollection",
      features: (() => {
        const best = new Map<string, { piece: (typeof model.streets)[number]; length: number }>();
        for (const piece of model.streets) {
          if (piece.name === undefined) {
            continue;
          }
          if (
            piece.osmClass !== "motorway" &&
            piece.osmClass !== "trunk" &&
            piece.osmClass !== "primary" &&
            piece.osmClass !== "secondary"
          ) {
            continue;
          }
          const key = `name:${piece.name}`;
          let length = 0;
          for (let index = 1; index < piece.points.length; index += 1) {
            length += Math.hypot(
              piece.points[index][0] - piece.points[index - 1][0],
              piece.points[index][1] - piece.points[index - 1][1],
            );
          }
          const current = best.get(key);
          if (!current || length > current.length) {
            best.set(key, { piece, length });
          }
        }
        const byName = [...best.values()].map(({ piece }) =>
          lineFeature(projection, piece.points, {
            name: piece.name ?? "",
            ref: piece.ref ?? "",
            osmClass: piece.osmClass,
            rank: piece.osmClass === "motorway" || piece.osmClass === "trunk" ? 3 : 4,
          }),
        );
        // Expressway refs additionally get one ref-only label each: I-90 and
        // I-94 can share a street name, and each still deserves its own shield.
        // The name is blanked so the street-name layer cannot double-label.
        const refBest = new Map<string, { piece: (typeof model.streets)[number]; length: number }>();
        for (const piece of model.streets) {
          if (!piece.ref || piece.osmClass !== "motorway") {
            continue;
          }
          let length = 0;
          for (let index = 1; index < piece.points.length; index += 1) {
            length += Math.hypot(
              piece.points[index][0] - piece.points[index - 1][0],
              piece.points[index][1] - piece.points[index - 1][1],
            );
          }
          const current = refBest.get(piece.ref);
          if (!current || length > current.length) {
            refBest.set(piece.ref, { piece, length });
          }
        }
        return [
          ...byName,
          ...[...refBest.values()].map(({ piece }) =>
            lineFeature(projection, piece.points, {
              name: "",
              ref: piece.ref ?? "",
              osmClass: piece.osmClass,
              rank: 3,
            }),
          ),
        ];
      })(),
    },
    layerOrder: [
      "land",
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
