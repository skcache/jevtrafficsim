/**
 * Chicago showcase geography (Phase 1).
 *
 * The public showcase city is REAL central-Chicago geography derived from
 * OpenStreetMap by `tools/chicago-map/extract_chicago.py` and frozen under
 * `data/chicago/`. The browser only ever reads those committed artifacts —
 * no network calls, no Python, no runtime GIS. The procedural generator
 * (`sim/city-generator.ts`) stays untouched for tests and benchmarks; this
 * module is the browser's geography and nothing else.
 *
 * `compileChicagoCity` is pure: same asset bytes -> byte-identical City and
 * presentation model, independent of any traffic seed.
 */
import type {
  City,
  CitySize,
  Corridor,
  CorridorKind,
  Intersection,
  IntersectionControl,
  Road,
  RoadKind,
} from "@/sim/types";
import type { Point } from "./paths";
import {
  carriagewayWidthMetres,
  lngLatToMetric,
  pointInPolygon,
  pointsBounds,
  type BuildingFootprint,
  type Bounds,
  type MapDistrict,
  type MapLabel,
  type MapLandmark,
  type MapModel,
  type PolygonFeature,
  type PolygonRings,
  type WaterCrossingBridge,
  type Projection,
  type StreetPiece,
} from "./map-model";

/** The five nested scales, smallest first. Index = scale index. */
export const CHICAGO_SCALES = ["tiny", "small", "medium", "large", "metro"] as const;
export type ChicagoScaleName = (typeof CHICAGO_SCALES)[number];

/** Scale index -> the sim's CitySize (matches the onboarding options). */
export const CHICAGO_SCALE_SIZES: readonly CitySize[] = [
  "small",
  "small-medium",
  "medium",
  "medium-large",
  "large",
];

/** Human labels for the five scales (onboarding + in-sim identity line). */
export const CHICAGO_SCALE_LABELS: readonly string[] = [
  "Tiny",
  "Small",
  "Medium",
  "Large",
  "Metro",
];

export function chicagoScaleForSize(size: CitySize): number {
  const index = CHICAGO_SCALE_SIZES.indexOf(size);
  return index === -1 ? 2 : index;
}

/** Downtown framing box (lng/lat): the Loop and the river edge. */
const LOOP_BOX = { west: -87.6375, south: 41.8785, east: -87.6215, north: 41.8885 };

/** Named places shown on the map. Positions are presentation metadata. */
const PLACE_LABELS: readonly {
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
  readonly rank: number;
  readonly kind: "district" | "landmark";
}[] = [
  { name: "The Loop", lon: -87.6295, lat: 41.8835, rank: 1, kind: "district" },
  { name: "River North", lon: -87.6340, lat: 41.8930, rank: 2, kind: "district" },
  { name: "West Loop", lon: -87.6520, lat: 41.8830, rank: 2, kind: "district" },
  { name: "Grant Park", lon: -87.6210, lat: 41.8760, rank: 2, kind: "district" },
  { name: "South Loop", lon: -87.6290, lat: 41.8680, rank: 3, kind: "district" },
  { name: "Near West Side", lon: -87.6690, lat: 41.8740, rank: 3, kind: "district" },
  { name: "Streeterville", lon: -87.6170, lat: 41.8930, rank: 3, kind: "district" },
  { name: "Museum Campus", lon: -87.6170, lat: 41.8640, rank: 3, kind: "district" },
  { name: "United Center", lon: -87.6742, lat: 41.8806, rank: 1, kind: "landmark" },
  { name: "Soldier Field", lon: -87.6167, lat: 41.8623, rank: 1, kind: "landmark" },
  { name: "Millennium Park", lon: -87.6220, lat: 41.8825, rank: 2, kind: "landmark" },
  { name: "Navy Pier", lon: -87.6055, lat: 41.8916, rank: 2, kind: "landmark" },
  { name: "Willis Tower", lon: -87.6359, lat: 41.8789, rank: 2, kind: "landmark" },
  { name: "Merchandise Mart", lon: -87.6357, lat: 41.8886, rank: 3, kind: "landmark" },
];

/** Venue anchors used by the event-release incident (nearest intersection). */
export interface ChicagoEventVenue {
  readonly name: string;
  readonly lon: number;
  readonly lat: number;
}

export const CHICAGO_VENUES: readonly ChicagoEventVenue[] = [
  { name: "United Center", lon: -87.6742, lat: 41.8806 },
  { name: "Soldier Field", lon: -87.6167, lat: 41.8623 },
  { name: "Millennium Park", lon: -87.6229, lat: 41.8826 },
  { name: "Merchandise Mart", lon: -87.6356, lat: 41.8885 },
];

/** How close a venue must be to real road topology to be worth releasing. */
const VENUE_ROAD_RADIUS_M = 320;

/**
 * Venues that are genuinely part of the ACTIVE scale.
 *
 * EVENT LETS OUT used to take every known venue and snap it to the nearest
 * intersection, with no bounds check at all: on a scale that does not contain
 * Soldier Field, the nearest intersection is somewhere on the scale's boundary,
 * so the incident fired in a random street nowhere near a stadium. A venue is
 * eligible only when it lies inside the compiled extent AND has real road
 * topology within a short walk of it.
 */
export function availableChicagoEventVenues(model: MapModel): readonly {
  readonly name: string;
  readonly intersectionId: number;
}[] {
  const bounds = model.bounds;
  const margin = 150;
  const available: { name: string; intersectionId: number }[] = [];
  for (const venue of CHICAGO_VENUES) {
    const [x, y] = lngLatToMetric(model.projection, venue.lon, venue.lat);
    if (
      x < bounds.minX + margin ||
      x > bounds.maxX - margin ||
      y < bounds.minY + margin ||
      y > bounds.maxY - margin
    ) {
      continue;
    }
    const intersectionId = nearestIntersectionTo(model, venue.lon, venue.lat);
    if (intersectionId === null) {
      continue;
    }
    const intersection = model.city.intersections[intersectionId];
    if (Math.hypot(intersection.x - x, intersection.y - y) > VENUE_ROAD_RADIUS_M) {
      continue;
    }
    available.push({ name: venue.name, intersectionId });
  }
  return available;
}

/* ------------------------------------------------------------------ */
/* Artifact shapes (produced by the Python preprocessing tool)         */
/* ------------------------------------------------------------------ */

export interface ChicagoIntersectionRecord {
  readonly id: number;
  readonly osmid: number;
  readonly x: number;
  readonly y: number;
  readonly lon: number;
  readonly lat: number;
  readonly control: IntersectionControl;
  readonly region: number;
  readonly roundabout: boolean;
  readonly degree: number;
}

export interface ChicagoRoadRecord {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly kind: RoadKind;
  readonly osmClass: string;
  readonly name: string | null;
  readonly ref: string | null;
  readonly oneway: boolean;
  readonly lanes: number;
  readonly speedMps: number;
  readonly capacity: number;
  readonly lengthM: number;
  readonly bridge: boolean;
  readonly tunnel: boolean;
  readonly layer: number;
  readonly roundabout: boolean;
  readonly points: readonly (readonly [number, number])[];
  readonly cumulative: readonly number[];
  readonly bridgeGroup?: number | null;
  readonly corridor?: number | null;
}

export interface ChicagoAsset {
  readonly version: number;
  readonly scale: ChicagoScaleName;
  readonly size: CitySize;
  readonly bbox: readonly [number, number, number, number];
  readonly intersections: readonly ChicagoIntersectionRecord[];
  readonly roads: readonly ChicagoRoadRecord[];
  readonly corridors: readonly {
    readonly id: number;
    readonly name: string;
    readonly kind: CorridorKind;
    readonly roadIds: readonly number[];
  }[];
  readonly bridges: readonly {
    readonly id: number;
    readonly name: string;
    readonly roadIds: readonly number[];
    /** Set by the importer: the group's path genuinely crosses the river. */
    readonly waterCrossing?: boolean;
    readonly waterOverlapM?: number;
  }[];
  readonly counts: Readonly<Record<string, number>>;
}

/**
 * True when two directed roads are the same carriageway travelled in both
 * directions. Node ids alone are not enough in Chicago: one-way pairs and dual
 * carriageways join the same two junctions by different streets, and pairing
 * those would draw one street's line over the other's and report its length.
 */
/**
 * Minimum length of a bridge path that must lie inside water for the crossing
 * to count. The Chicago River is 60-90 m wide downtown, so a real crossing
 * clears this easily while a viaduct merely touching a bank does not.
 */
const MIN_WATER_CROSSING_M = 20;

/**
 * Walk a road path at a fixed step and measure the part inside any water ring.
 * Point sampling keeps this dependency-free and deterministic; the step is
 * small enough that a 20 m threshold is exact to a couple of metres.
 */
/** Shortest distance from a point to any water ring edge, in metres. */
export function distanceToWater(point: Point, polygons: readonly PolygonRings[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const rings of polygons) {
    for (const ring of rings) {
    for (let index = 0; index + 1 < ring.length; index += 1) {
      const [ax, ay] = ring[index];
      const [bx, by] = ring[index + 1];
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSq = dx * dx + dy * dy;
      const t =
        lengthSq === 0
          ? 0
          : Math.max(0, Math.min(1, ((point[0] - ax) * dx + (point[1] - ay) * dy) / lengthSq));
      const px = ax + dx * t;
      const py = ay + dy * t;
      best = Math.min(best, Math.hypot(point[0] - px, point[1] - py));
      }
    }
  }
  return Number.isFinite(best) ? best : Number.POSITIVE_INFINITY;
}

export function pathInsideWater(
  points: readonly (readonly number[])[],
  water: readonly PolygonRings[],
): { length: number; midpoint: Point; entersAndExits: boolean } {
  const step = 2;
  let length = 0;
  const insideSamples: Point[] = [];
  let sawOutsideBefore = false;
  let sawInside = false;
  let sawOutsideAfter = false;

  for (let index = 0; index < points.length - 1; index += 1) {
    const [x1, y1] = points[index];
    const [x2, y2] = points[index + 1];
    const span = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.ceil(span / step));
    for (let s = 0; s <= steps; s += 1) {
      if (index > 0 && s === 0) {
        continue; // shared vertex, already counted
      }
      const t = s / steps;
      const point: Point = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
      const inWater = water.some(
        (rings) => pointInPolygon(point, rings[0]) && !rings.slice(1).some((hole) => pointInPolygon(point, hole)),
      );
      if (inWater) {
        length += span / steps;
        sawInside = true;
        insideSamples.push(point);
      } else if (!sawInside) {
        sawOutsideBefore = true;
      } else {
        sawOutsideAfter = true;
      }
    }
  }
  // The middle inside sample, not the average of the first and last: a path that
  // crosses water twice (river, then a basin) would average back onto land and
  // plant the incident marker off the bridge.
  const midpoint: Point =
    insideSamples.length > 0 ? insideSamples[Math.floor(insideSamples.length / 2)] : [0, 0];
  return { length, midpoint, entersAndExits: sawInside && sawOutsideBefore && sawOutsideAfter };
}

/**
 * Physical metadata for one rendered carriageway, derived from the directed
 * roads that share it. This is what the map style reads to size a road, so the
 * width on screen comes from the same lane counts the simulation uses.
 */
function piecePhysicals(
  roads: readonly ChicagoRoadRecord[],
  primary: ChicagoRoadRecord,
): {
  osmClass: string;
  lanesTotal: number;
  widthM: number;
  bridgeStructure: boolean;
  tunnel: boolean;
  layer: number;
  oneway: boolean;
} {
  const lanesTotal = roads.reduce((sum, road) => sum + Math.max(1, road.lanes), 0);
  const isRamp = primary.kind === "highway" && primary.lanes <= 1;
  return {
    osmClass: primary.osmClass,
    ...(primary.name ? { name: primary.name } : {}),
    ...(primary.ref ? { ref: primary.ref } : {}),
    lanesTotal,
    widthM: carriagewayWidthMetres(lanesTotal, isRamp),
    bridgeStructure: roads.some((road) => road.bridge),
    tunnel: roads.some((road) => road.tunnel),
    layer: Math.min(...roads.map((road) => road.layer ?? 0)),
    oneway: roads.every((road) => road.oneway),
  };
}

function sameCarriageway(a: ChicagoRoadRecord, b: ChicagoRoadRecord): boolean {
  const longest = Math.max(a.lengthM, b.lengthM);
  if (longest <= 0) {
    return true;
  }
  if (Math.abs(a.lengthM - b.lengthM) / longest > 0.05) {
    return false;
  }
  const near = (p: readonly number[], q: readonly number[]) =>
    Math.hypot(p[0] - q[0], p[1] - q[1]) <= 8;
  const aStart = a.points[0];
  const aEnd = a.points[a.points.length - 1];
  const bStart = b.points[0];
  const bEnd = b.points[b.points.length - 1];
  return near(aStart, bEnd) && near(aEnd, bStart);
}

export interface ChicagoMetadata {
  readonly masterBbox: readonly [number, number, number, number];
  readonly regionGrid: { readonly cols: number; readonly rows: number };
  readonly projection: {
    readonly originLon: number;
    readonly originLat: number;
    readonly metresPerDegreeLon: number;
    readonly metresPerDegreeLat: number;
  };
  readonly attribution: string;
  readonly attributionUrl: string;
}

interface GeoJsonPolygonFeature {
  readonly type: "Feature";
  readonly properties: Readonly<Record<string, unknown>>;
  readonly geometry:
    | { readonly type: "Polygon"; readonly coordinates: readonly (readonly (readonly number[])[])[] }
    | {
        readonly type: "MultiPolygon";
        readonly coordinates: readonly (readonly (readonly (readonly number[])[])[])[];
      };
}

export interface ChicagoFeatureCollection {
  readonly type: "FeatureCollection";
  readonly features: readonly GeoJsonPolygonFeature[];
}

export interface ChicagoFeatures {
  readonly buildings: ChicagoFeatureCollection;
  readonly water: ChicagoFeatureCollection;
  readonly parks: ChicagoFeatureCollection;
  readonly landmarks: ChicagoFeatureCollection;
  /** Urban blocks derived from the street network (presentation only). */
  readonly blocks: ChicagoFeatureCollection;
}

/* ------------------------------------------------------------------ */
/* Compilation                                                         */
/* ------------------------------------------------------------------ */

function ringToMetric(
  projection: Projection,
  coordinates: readonly (readonly number[])[],
): Point[] {
  const points: Point[] = [];
  for (const [lon, lat] of coordinates) {
    if (typeof lon !== "number" || typeof lat !== "number") {
      continue;
    }
    const [x, y] = lngLatToMetric(projection, lon, lat);
    points.push([Math.round(x * 100) / 100, Math.round(y * 100) / 100]);
  }
  return points;
}

/** Every polygon part of a feature, each as outer ring + holes (metric). */
function polygonsOf(
  projection: Projection,
  feature: GeoJsonPolygonFeature,
): PolygonRings[] {
  const parts =
    feature.geometry.type === "Polygon"
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;
  const polygons: PolygonRings[] = [];
  for (const rings of parts) {
    const metric: Point[][] = [];
    for (const ring of rings) {
      const points = ringToMetric(projection, ring);
      // A hole needs three distinct points to be meaningful.
      if (points.length >= (metric.length === 0 ? 4 : 3)) {
        metric.push(points);
      }
    }
    if (metric.length > 0) {
      polygons.push(metric);
    }
  }
  return polygons;
}

function withinBounds(bounds: Bounds, points: readonly Point[]): boolean {
  for (const [x, y] of points) {
    if (x < bounds.minX - 1 || x > bounds.maxX + 1 || y < bounds.minY - 1 || y > bounds.maxY + 1) {
      return false;
    }
  }
  return true;
}

function ringArea(points: readonly Point[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
    area += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  }
  return Math.abs(area) / 2;
}

/**
 * Compiles one frozen scale into the simulation `City` plus the presentation
 * model. Pure and deterministic: no seed, no clock, no randomness.
 */
export function compileChicagoCity(
  asset: ChicagoAsset,
  features: ChicagoFeatures,
  metadata: ChicagoMetadata,
  scaleIndex: number,
): MapModel {
  const projection: Projection = {
    originLon: metadata.projection.originLon,
    originLat: metadata.projection.originLat,
    metresPerDegreeLon: metadata.projection.metresPerDegreeLon,
    metresPerDegreeLat: metadata.projection.metresPerDegreeLat,
  };

  // --- simulation city -------------------------------------------------
  const intersections: Intersection[] = asset.intersections.map((record) => ({
    id: record.id,
    x: record.x,
    y: record.y,
    incoming: [],
    outgoing: [],
    control: record.control,
    regionId: record.region,
  }));
  const roads: Road[] = asset.roads.map((record) => ({
    id: record.id,
    from: record.from,
    to: record.to,
    length: record.lengthM,
    lanes: record.lanes,
    speedLimit: record.speedMps,
    capacity: record.capacity,
    kind: record.kind,
    closed: false,
  }));
  for (const road of roads) {
    intersections[road.from].outgoing.push(road.id);
    intersections[road.to].incoming.push(road.id);
  }
  const corridors: Corridor[] = asset.corridors.map((corridor) => ({
    id: corridor.id,
    kind: corridor.kind,
    roadIds: [...corridor.roadIds],
  }));

  const city: City = {
    size: asset.size,
    // Geography is seed-free: the traffic seed never moves a Chicago street.
    seed: 0,
    // Not a lattice; 0 disables the lattice fast paths in sim/signals.ts.
    gridWidth: 0,
    gridHeight: 0,
    intersections,
    roads,
    corridors,
  };

  // --- presentation ----------------------------------------------------
  const directedPaths: (readonly Point[] | null)[] = asset.roads.map((record) =>
    record.points.map(([x, y]) => [x, y] as Point),
  );

  const bridgeNames = new Map<number, { name: string; rank: number }>();
  for (const bridge of asset.bridges) {
    for (const roadId of bridge.roadIds) {
      bridgeNames.set(roadId, { name: bridge.name, rank: 1 });
    }
  }

  // Physical streets: one presentation piece per physical street.
  //
  // Two directed roads belong to the same street only when they really share a
  // carriageway. Chicago is full of one-way pairs (Adams vs Jackson) and dual
  // carriageways whose two directions are different OSM ways with different
  // geometry — pairing those by node ids alone would draw the wrong line over
  // the map and report the wrong length, so geometry decides.
  const byPair = new Map<string, number[]>();
  for (const record of asset.roads) {
    const key =
      record.from < record.to ? `${record.from}:${record.to}` : `${record.to}:${record.from}`;
    const list = byPair.get(key) ?? [];
    list.push(record.id);
    byPair.set(key, list);
  }
  const streets: StreetPiece[] = [];
  for (const [key, roadIds] of byPair) {
    const first = asset.roads[roadIds[0]];
    const firstPoints = first.points.map(([x, y]) => [x, y] as Point);
    const partners: number[] = [roadIds[0]];
    if (roadIds.length > 1) {
      for (const otherId of roadIds.slice(1)) {
        if (sameCarriageway(asset.roads[otherId], first)) {
          partners.push(otherId);
        }
      }
    }
    const unpaired = roadIds.filter((id) => !partners.includes(id));
    const bridge = bridgeNames.get(partners[0]);
    streets.push({
      streetId: key,
      kind: first.kind,
      district: String(asset.intersections[first.from]?.region ?? 0),
      ...(bridge ? { bridge } : {}),
      points: firstPoints,
      length: first.lengthM,
      roadIds: [...partners].sort((a, b) => a - b),
      ...piecePhysicals(partners.map((id) => asset.roads[id]), first),
    });
    // A diverging counterpart (one-way pair / dual carriageway) becomes its own
    // piece so the map shows the street it actually runs on.
    for (const otherId of unpaired) {
      const other = asset.roads[otherId];
      const otherBridge = bridgeNames.get(otherId);
      streets.push({
        streetId: `${key}-${otherId}`,
        kind: other.kind,
        district: String(asset.intersections[other.from]?.region ?? 0),
        ...(otherBridge ? { bridge: otherBridge } : {}),
        points: other.points.map(([x, y]) => [x, y] as Point),
        length: other.lengthM,
        roadIds: [otherId],
        ...piecePhysicals([other], other),
      });
    }
  }

  const [west, south, east, north] = asset.bbox;
  const [minX, minY] = lngLatToMetric(projection, west, south);
  const [maxX, maxY] = lngLatToMetric(projection, east, north);
  const bounds: Bounds = { minX, minY, maxX, maxY };

  const [loopMinX, loopMinY] = lngLatToMetric(projection, LOOP_BOX.west, LOOP_BOX.south);
  const [loopMaxX, loopMaxY] = lngLatToMetric(projection, LOOP_BOX.east, LOOP_BOX.north);
  const centralCamera: Bounds = {
    minX: Math.max(bounds.minX, Math.min(loopMinX, bounds.maxX - 400)),
    minY: Math.max(bounds.minY, Math.min(loopMinY, bounds.maxY - 400)),
    maxX: Math.min(bounds.maxX, Math.max(loopMaxX, bounds.minX + 400)),
    maxY: Math.min(bounds.maxY, Math.max(loopMaxY, bounds.minY + 400)),
  };

  const buildings: BuildingFootprint[] = [];
  for (const feature of features.buildings.features) {
    const area = typeof feature.properties.area === "number" ? feature.properties.area : 0;
    // A multipolygon building is drawn as separate parts; `area` describes the
    // whole building while `areaM2` describes the part actually drawn here.
    const partArea = typeof feature.properties.areaM2 === "number" ? feature.properties.areaM2 : undefined;
    for (const rings of polygonsOf(projection, feature)) {
      const outer = rings[0];
      if (outer.length < 4 || !withinBounds(bounds, outer)) {
        continue;
      }
      buildings.push({
        district: "",
        rings,
        prominent: (partArea ?? area) >= 3000 || ringArea(outer) >= 3000,
      });
    }
  }

  const water: PolygonFeature[] = [];
  for (const feature of features.water.features) {
    for (const rings of polygonsOf(projection, feature)) {
      if (rings[0].length < 4) {
        continue;
      }
      const areaM2 = ringArea(rings[0]);
      // Rank by geometry, not by source tags: the lake dwarfs the river, and
      // the river dwarfs a fountain. Nothing here needs a hardcoded id.
      const kind = areaM2 >= 400_000 ? "lake" : areaM2 >= 4_000 ? "river" : "water";
      water.push({ rings, areaM2, kind });
    }
  }

  const parks: PolygonFeature[] = [];
  for (const feature of features.parks.features) {
    for (const rings of polygonsOf(projection, feature)) {
      if (rings[0].length < 4 || !withinBounds(bounds, rings[0])) {
        continue;
      }
      const areaM2 = ringArea(rings[0]);
      parks.push({ rings, areaM2, kind: areaM2 >= 20_000 ? "major" : "minor" });
    }
  }

  // Urban blocks: the city fabric between meaningful streets, derived offline
  // from the street network. They are the mid-zoom urban mass, so the map does
  // not depend on thousands of individual footprints to look like a city.
  const blocks: PolygonFeature[] = [];
  for (const feature of features.blocks.features) {
    for (const rings of polygonsOf(projection, feature)) {
      if (rings[0].length < 4 || !withinBounds(bounds, rings[0])) {
        continue;
      }
      blocks.push({ rings, areaM2: ringArea(rings[0]), kind: "block" });
    }
  }

  const landmarks: MapLandmark[] = [];
  for (const feature of features.landmarks.features) {
    const name = typeof feature.properties.name === "string" ? feature.properties.name : "Venue";
    for (const rings of polygonsOf(projection, feature)) {
      if (rings[0].length >= 4 && withinBounds(bounds, rings[0])) {
        landmarks.push({
          id: `${name}-${landmarks.length}`,
          name,
          kind: "stadium",
          rings,
        });
      }
    }
  }

  // Bridge groups that genuinely cross extracted water. Classification is
  // geographic: the bridge path is walked in the metric frame and the portion
  // lying inside a water polygon is measured. Named bridges only break ties.
  const waterCrossingBridges: WaterCrossingBridge[] = [];
  const rings = water.map((entry) => entry.rings);
  for (const bridge of [...asset.bridges].sort((a, b) => a.id - b.id)) {
    let best: { roadId: number; at: Point; inside: number } | null = null;
    for (const roadId of bridge.roadIds) {
      const road = asset.roads[roadId];
      if (!road) {
        continue;
      }
      const inside = pathInsideWater(road.points, rings);
      if (inside.length >= MIN_WATER_CROSSING_M && inside.entersAndExits) {
        if (!best || inside.length > best.inside) {
          best = { roadId, at: inside.midpoint, inside: inside.length };
        }
      }
    }
    if (best) {
      waterCrossingBridges.push({
        groupId: bridge.id,
        roadId: best.roadId,
        name: bridge.name ?? "",
        at: best.at,
      });
      continue;
    }
    // The importer classifies crossings against buffered river geometry, which
    // sees the bridges OSM's river polygons are cut around. Those groups have no
    // strictly-inside road, so place the incident on the group's longest road
    // whose midpoint is nearest water.
    if (bridge.waterCrossing !== true) {
      continue;
    }
    // Nearest water first, then the longest road: the incident must land on the
    // part of the group that actually sits over the river.
    // Walk each road and keep the sample nearest water: the crossing may sit at
    // one END of a road, not at its midpoint.
    let fallback: { roadId: number; at: Point; distance: number; length: number } | null = null;
    for (const roadId of bridge.roadIds) {
      const road = asset.roads[roadId];
      if (!road || road.points.length < 2 || rings.length === 0) {
        continue;
      }
      const step = 5;
      for (let index = 0; index < road.points.length - 1; index += 1) {
        const [x1, y1] = road.points[index];
        const [x2, y2] = road.points[index + 1];
        const span = Math.hypot(x2 - x1, y2 - y1);
        const steps = Math.max(1, Math.ceil(span / step));
        for (let s = 0; s <= steps; s += 1) {
          const t = s / steps;
          const point: Point = [x1 + (x2 - x1) * t, y1 + (y2 - y1) * t];
          const nearest = distanceToWater(point, rings);
          const better =
            !fallback ||
            nearest < fallback.distance - 1 ||
            (Math.abs(nearest - fallback.distance) <= 1 && road.lengthM > fallback.length);
          if (better) {
            fallback = { roadId, at: point, distance: nearest, length: road.lengthM };
          }
        }
      }
    }
    if (fallback) {
      waterCrossingBridges.push({
        groupId: bridge.id,
        roadId: fallback.roadId,
        name: bridge.name ?? "",
        at: fallback.at,
      });
    }
  }

  // Named crossings first, then by how much river they actually span, then by
  // group id: deterministic, and the first BRIDGE CLOSED closes a real, named
  // Loop river bridge rather than an anonymous deck.
  const overlapOf = new Map(asset.bridges.map((bridge) => [bridge.id, bridge.waterOverlapM ?? 0]));
  waterCrossingBridges.sort((a, b) => {
    const namedA = a.name && a.name !== "Bridge" ? 1 : 0;
    const namedB = b.name && b.name !== "Bridge" ? 1 : 0;
    if (namedA !== namedB) {
      return namedB - namedA;
    }
    const overlapA = overlapOf.get(a.groupId) ?? 0;
    const overlapB = overlapOf.get(b.groupId) ?? 0;
    if (overlapA !== overlapB) {
      return overlapB - overlapA;
    }
    return a.groupId - b.groupId;
  });

  // District cells: the fixed region grid, so a street keeps its region id.
  const { cols, rows } = metadata.regionGrid;
  const districts: MapDistrict[] = [];
  const [masterWest, masterSouth, masterEast, masterNorth] = metadata.masterBbox;
  const [gridMinX, gridMinY] = lngLatToMetric(projection, masterWest, masterSouth);
  const [gridMaxX, gridMaxY] = lngLatToMetric(projection, masterEast, masterNorth);
  const cellW = (gridMaxX - gridMinX) / cols;
  const cellH = (gridMaxY - gridMinY) / rows;
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x0 = gridMinX + col * cellW;
      const y0 = gridMinY + row * cellH;
      const x1 = x0 + cellW;
      const y1 = y0 + cellH;
      if (x1 < bounds.minX || x0 > bounds.maxX || y1 < bounds.minY || y0 > bounds.maxY) {
        continue;
      }
      districts.push({
        id: `r${row * cols + col}`,
        name: "",
        kind: "outer",
        rings: [
          [
            [Math.max(x0, bounds.minX), Math.max(y0, bounds.minY)],
            [Math.min(x1, bounds.maxX), Math.max(y0, bounds.minY)],
            [Math.min(x1, bounds.maxX), Math.min(y1, bounds.maxY)],
            [Math.max(x0, bounds.minX), Math.min(y1, bounds.maxY)],
          ],
        ],
      });
    }
  }

  const labels: MapLabel[] = [];
  for (const place of PLACE_LABELS) {
    const [x, y] = lngLatToMetric(projection, place.lon, place.lat);
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
      continue;
    }
    labels.push({ name: place.name, at: [x, y], rank: place.rank, kind: place.kind });
  }

  return {
    scaleIndex,
    size: asset.size,
    city,
    projection,
    streets,
    directedPaths,
    buildings,
    water,
    parks,
    blocks,
    waterCrossingBridges,
    districts,
    landmarks,
    labels,
    bounds,
    centralCamera,
    cityCamera: bounds,
    stats: {
      intersections: city.intersections.length,
      roads: city.roads.length,
      buildings: buildings.length,
      signals: city.intersections.filter((intersection) => intersection.control === "signal").length,
      stops: city.intersections.filter((intersection) => intersection.control === "stop").length,
    },
  };
}

/**
 * The intersection closest to a venue anchor — the event-release target.
 * Deterministic: ties break on the lowest id.
 */
export function nearestIntersectionTo(
  model: MapModel,
  lon: number,
  lat: number,
): number | null {
  const [x, y] = lngLatToMetric(model.projection, lon, lat);
  let best: number | null = null;
  let bestDistance = Infinity;
  for (const intersection of model.city.intersections) {
    const distance = (intersection.x - x) ** 2 + (intersection.y - y) ** 2;
    if (distance < bestDistance - 1e-9) {
      bestDistance = distance;
      best = intersection.id;
    }
  }
  return best;
}

/** Bounds helper re-exported for callers that only need geometry math. */
export { pointsBounds };
