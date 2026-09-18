/**
 * Showcase city compiler (Task 11 visual correction).
 *
 * Compiles the authored master geography into:
 *  - a dense, valid `City` for the simulation (stable ids, connectivity,
 *    signal/stop controls, districts as regions, named corridors), and
 *  - a presentation model (road polylines, directed path geometry for
 *    vehicle interpolation, buildings, water, parks, landmarks, labels,
 *    camera targets) for MapLibre + deck.gl.
 *
 * Deterministic and seed-free by construction: traffic seeds never change
 * macro geography. Framework-free — no browser, no map library, no React.
 */
import { createRng } from "@/sim/rng";
import { ROAD_KIND_DEFAULTS } from "@/sim/config";
import type { City, CitySize, Corridor, CorridorKind, Intersection, Road, RoadKind } from "@/sim/types";
import {
  BUILDING_ZONES,
  DISTRICTS,
  LANDMARKS,
  PARKS,
  STREETS,
  WORLD,
  riverPolygon,
  type ShowcaseStreet,
} from "./showcase-city-data";
import {
  boundsOfPoints,
  buildPathIndex,
  ellipsePolygon as ellipse,
  expandBounds,
  pathLength,
  pointInPolygon,
  projectPointOntoPath,
  splitPathAt,
  type Bounds,
  type PathIndex,
  type Point,
} from "./paths";

export const SHOWCASE_SIZES: readonly CitySize[] = [
  "small",
  "small-medium",
  "medium",
  "medium-large",
  "large",
];

const NODE_SNAP_METRES = 1.5;
const PATH_TOLERANCE_METRES = 2.5;

export interface BuildingFootprint {
  readonly district: string;
  readonly polygon: readonly Point[];
  /** Slightly larger footprints get a darker outline (towers, warehouses). */
  readonly prominent: boolean;
}

export interface ShowcaseStreetPiece {
  readonly streetId: string;
  readonly kind: RoadKind;
  readonly district: string;
  readonly bridge?: { readonly name: string; readonly rank: number };
  readonly points: readonly Point[];
  readonly length: number;
  /** [forwardRoadId, reverseRoadId] */
  readonly roadIds: readonly [number, number];
}

export interface ShowcaseLabel {
  readonly name: string;
  readonly at: Point;
  readonly rank: number;
  readonly kind: "district" | "landmark";
}

export interface ShowcaseMapModel {
  readonly scaleIndex: number;
  readonly size: CitySize;
  readonly city: City;
  readonly streets: readonly ShowcaseStreetPiece[];
  /** Directed road id -> presentation path (oriented from -> to); null when absent. */
  readonly directedPaths: readonly (readonly Point[] | null)[];
  readonly buildings: readonly BuildingFootprint[];
  readonly water: readonly (readonly Point[])[];
  readonly parks: readonly (readonly Point[])[];
  readonly districts: readonly { id: string; name: string; kind: string; polygon: readonly Point[] }[];
  readonly landmarks: readonly { id: string; name: string; kind: string; polygon: readonly Point[] }[];
  readonly labels: readonly ShowcaseLabel[];
  readonly bounds: Bounds;
  readonly centralCamera: Bounds;
  readonly cityCamera: Bounds;
  readonly stats: { intersections: number; roads: number; buildings: number; signals: number; stops: number };
}

interface RawPiece {
  street: ShowcaseStreet;
  points: Point[];
  length: number;
}

function streetPoints(street: ShowcaseStreet): Point[] {
  const points: Point[] = [street.from, ...(street.via ?? []), street.to];
  const deduped: Point[] = [];
  for (const point of points) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.hypot(point[0] - last[0], point[1] - last[1]) > 0.01) {
      deduped.push(point);
    }
  }
  return deduped;
}

function snapKey(point: Point): string {
  return `${Math.round(point[0] / NODE_SNAP_METRES)}|${Math.round(point[1] / NODE_SNAP_METRES)}`;
}

/**
 * Proper crossing point of two segments, excluding touches at their own
 * endpoints (those are handled by the endpoint-on-path rule instead).
 */
function segmentCrossing(
  a1: Point,
  a2: Point,
  b1: Point,
  b2: Point,
): Point | null {
  const d1x = a2[0] - a1[0];
  const d1y = a2[1] - a1[1];
  const d2x = b2[0] - b1[0];
  const d2y = b2[1] - b1[1];
  const denominator = d1x * d2y - d1y * d2x;
  if (Math.abs(denominator) < 1e-9) {
    return null; // parallel or collinear
  }
  const t = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denominator;
  const u = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / denominator;
  const eps = 1e-6;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) {
    return null;
  }
  return [a1[0] + d1x * t, a1[1] + d1y * t];
}

/**
 * Splits each street into pieces at every junction: authored endpoints that
 * lie on another street's path (T-junctions), and proper crossings between
 * street segments (grid junctions). Via points are geometry only — they never
 * create intersections.
 */
function splitStreets(streets: readonly ShowcaseStreet[]): RawPiece[] {
  const paths = streets.map((street) => {
    const points = streetPoints(street);
    return { street, points, index: buildPathIndex(points) };
  });
  const cutsPerStreet: number[][] = paths.map(() => []);
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = 0; j < paths.length; j += 1) {
      if (i === j) {
        continue;
      }
      const other = paths[j];
      for (const endpoint of [other.points[0], other.points[other.points.length - 1]]) {
        const along = pointOnPathDistance(paths[i].index, endpoint);
        if (along !== null) {
          cutsPerStreet[i].push(along);
        }
      }
    }
  }
  for (let i = 0; i < paths.length; i += 1) {
    for (let j = i + 1; j < paths.length; j += 1) {
      const a = paths[i];
      const b = paths[j];
      for (let ai = 0; ai < a.points.length - 1; ai += 1) {
        for (let bi = 0; bi < b.points.length - 1; bi += 1) {
          const hit = segmentCrossing(
            a.points[ai],
            a.points[ai + 1],
            b.points[bi],
            b.points[bi + 1],
          );
          if (!hit) {
            continue;
          }
          const alongA = pointOnPathDistance(a.index, hit);
          const alongB = pointOnPathDistance(b.index, hit);
          if (alongA !== null) {
            cutsPerStreet[i].push(alongA);
          }
          if (alongB !== null) {
            cutsPerStreet[j].push(alongB);
          }
        }
      }
    }
  }
  const pieces: RawPiece[] = [];
  for (let i = 0; i < paths.length; i += 1) {
    const { street, points } = paths[i];
    const parts = splitPathAt(points, cutsPerStreet[i]);
    for (const part of parts) {
      pieces.push({ street, points: part, length: pathLength(part) });
    }
  }
  return pieces;
}

/** Distance along the path where `point` lies (within tolerance), else null. */
function pointOnPathDistance(index: PathIndex, point: Point): number | null {
  const along = projectPointOntoPath(index, point);
  const sample = sampleAt(index, along);
  const offset = Math.hypot(sample[0] - point[0], sample[1] - point[1]);
  return offset <= PATH_TOLERANCE_METRES ? along : null;
}

function sampleAt(index: PathIndex, at: number): Point {
  const { points, cumulative, total } = index;
  const clamped = Math.min(Math.max(at, 0), total);
  let segment = 0;
  while (segment < cumulative.length - 2 && cumulative[segment + 1] < clamped) {
    segment += 1;
  }
  const from = points[segment];
  const to = points[segment + 1];
  const segmentLength = cumulative[segment + 1] - cumulative[segment];
  const t = segmentLength > 0 ? (clamped - cumulative[segment]) / segmentLength : 0;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** Deterministic building generation inside authored zones (seed-free). */
function buildFootprints(scaleIndex: number): BuildingFootprint[] {
  const buildings: BuildingFootprint[] = [];
  const water = [riverPolygon(), ellipse(470, 1880, 95, 62, 20)];
  const reserved: readonly Point[][] = [
    ...water,
    ...PARKS.filter((park) => park.minScale <= scaleIndex).map((park) => [...park.polygon]),
    ...LANDMARKS.filter((landmark) => landmark.minScale <= scaleIndex).map((landmark) => [...landmark.polygon]),
  ];
  const overlapsReserved = (polygon: Point[]): boolean => {
    const center: Point = [
      polygon.reduce((sum, point) => sum + point[0], 0) / polygon.length,
      polygon.reduce((sum, point) => sum + point[1], 0) / polygon.length,
    ];
    return reserved.some((area) => pointInPolygon(center, area));
  };

  for (const zone of BUILDING_ZONES) {
    if (zone.minScale > scaleIndex) {
      continue;
    }
    const bounds = boundsOfPoints(zone.polygon);
    const cell =
      zone.district === "northworks" ? 250 : zone.district === "west-park" ? 190 : 170;
    const rng = createRng(0x5eed).fork("showcase-buildings").fork(zone.district);
    const columns = Math.max(1, Math.floor((bounds.maxX - bounds.minX) / cell));
    const rows = Math.max(1, Math.floor((bounds.maxY - bounds.minY) / cell));
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const x0 = bounds.minX + column * cell;
        const y0 = bounds.minY + row * cell;
        const inset =
          zone.district === "northworks"
            ? 26
            : zone.district === "west-park"
              ? 26
              : 12;
        const style = zone.district;
        const count =
          style === "northworks"
            ? 1
            : style === "west-park"
              ? 2 + rng.nextInt(0, 1)
              : style === "riverside"
                ? 1 + rng.nextInt(0, 1)
                : style === "downtown" || style === "market"
                  ? 2 + rng.nextInt(0, 2)
                  : 1 + rng.nextInt(0, 1);
        for (let i = 0; i < count; i += 1) {
          const slotWidth = (cell - inset * 2) / count;
          const margin = style === "west-park" ? 10 : 4;
          const width = Math.max(14, slotWidth - margin * 2 - rng.nextInt(0, 8));
          const depthFactor =
            style === "northworks"
              ? 0.86
              : style === "downtown" || style === "market"
                ? 0.7
                : 0.62;
          const depth = Math.max(14, (cell - inset * 2) * depthFactor - rng.nextInt(0, 14));
          const bx = x0 + inset + i * slotWidth + margin + rng.nextInt(0, 6);
          const by = y0 + inset + rng.nextInt(0, Math.max(1, Math.floor(cell - inset * 2 - depth)));
          const polygon: Point[] = [
            [bx, by],
            [bx + width, by],
            [bx + width, by + depth],
            [bx, by + depth],
          ];
          if (overlapsReserved(polygon)) {
            continue;
          }
          const prominent =
            style === "northworks" ||
            style === "downtown" ? rng.nextFloat() < 0.12 : false;
          buildings.push({ district: zone.district, polygon, prominent });
        }
      }
    }
  }
  return buildings;
}

const CORRIDOR_SPECS: readonly {
  readonly name: string;
  readonly kind: CorridorKind;
  readonly matches: (streetId: string) => boolean;
}[] = [
  { name: "Grand Avenue", kind: "arterial", matches: (id) => id === "central-ns-1940" },
  {
    name: "Market Street",
    kind: "arterial",
    matches: (id) => id === "market-ew-1550" || id === "market-link-central" || id === "central-ew-1550",
  },
  {
    name: "Harbor Route",
    kind: "arterial",
    matches: (id) =>
      id === "harbor-bridge" ||
      id === "riverside-ns-2050" ||
      id.startsWith("northworks-ns-2050"),
  },
  { name: "Ring Highway", kind: "highway", matches: (id) => id.startsWith("highway-") || id.startsWith("interchange-") },
  { name: "Waterfront", kind: "arterial", matches: (id) => id === "riverside-waterfront" },
  {
    name: "Mill Route",
    kind: "diagonal",
    matches: (id) => id === "mill-bridge" || id === "riverside-ns-1300" || id === "mill-link-west",
  },
];

export function compileShowcaseCity(scaleIndex: number): ShowcaseMapModel {
  const scale = Math.min(Math.max(Math.floor(scaleIndex), 0), 4);
  const size = SHOWCASE_SIZES[scale];
  const streets = STREETS.filter((street) => street.minScale <= scale);
  const pieces = splitStreets(streets);

  // Dense node ids: deterministic ordering by (y, x) of the snapped position.
  const nodeKeys = new Map<string, { point: Point; neighbours: Set<string> }>();
  for (const piece of pieces) {
    for (const endpoint of [piece.points[0], piece.points[piece.points.length - 1]]) {
      const key = snapKey(endpoint);
      if (!nodeKeys.has(key)) {
        nodeKeys.set(key, { point: endpoint, neighbours: new Set() });
      }
    }
  }
  for (const piece of pieces) {
    const a = snapKey(piece.points[0]);
    const b = snapKey(piece.points[piece.points.length - 1]);
    if (a === b) {
      continue;
    }
    nodeKeys.get(a)?.neighbours.add(b);
    nodeKeys.get(b)?.neighbours.add(a);
  }
  const sortedKeys = [...nodeKeys.entries()]
    .sort(
      (a, b) =>
        a[1].point[1] - b[1].point[1] ||
        a[1].point[0] - b[1].point[0] ||
        a[0].localeCompare(b[0]),
    )
    .map(([key]) => key);
  const nodeIdByKey = new Map<string, number>(sortedKeys.map((key, index) => [key, index]));

  const includedDistricts = DISTRICTS.filter((district) => district.minScale <= scale);
  const districtIdByIndex = new Map(includedDistricts.map((district, index) => [district.id, index]));

  const intersections: Intersection[] = sortedKeys.map((key, index) => {
    const entry = nodeKeys.get(key)!;
    const district =
      includedDistricts.find((candidate) => pointInPolygon(entry.point, candidate.polygon)) ??
      includedDistricts
        .map((candidate) => ({
          candidate,
          distance: Math.hypot(
            candidate.labelAt[0] - entry.point[0],
            candidate.labelAt[1] - entry.point[1],
          ),
        }))
        .sort((a, b) => a.distance - b.distance)[0].candidate;
    const degree = entry.neighbours.size;
    const isCivicCentre =
      Math.hypot(entry.point[0] - 1150, entry.point[1] - 800) < 60;
    const control =
      isCivicCentre || degree <= 2 ? "uncontrolled" : degree >= 4 ? "signal" : "stop";
    return {
      id: index,
      x: entry.point[0],
      y: entry.point[1],
      incoming: [],
      outgoing: [],
      control,
      regionId: districtIdByIndex.get(district.id) ?? 0,
    };
  });

  const roads: Road[] = [];
  const streetPieces: ShowcaseStreetPiece[] = [];
  const directedPaths: (readonly Point[] | null)[] = [];
  for (const piece of pieces) {
    const fromKey = snapKey(piece.points[0]);
    const toKey = snapKey(piece.points[piece.points.length - 1]);
    const from = nodeIdByKey.get(fromKey);
    const to = nodeIdByKey.get(toKey);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const defaults = ROAD_KIND_DEFAULTS[piece.street.kind];
    const forward: Road = {
      id: roads.length,
      from,
      to,
      length: piece.length,
      lanes: defaults.lanes,
      speedLimit: defaults.speedLimit,
      capacity: defaults.capacity,
      kind: piece.street.kind,
      closed: false,
    };
    roads.push(forward);
    const reverse: Road = { ...forward, id: roads.length, from: to, to: from };
    roads.push(reverse);
    directedPaths[forward.id] = piece.points;
    directedPaths[reverse.id] = [...piece.points].reverse();
    intersections[from].outgoing.push(forward.id);
    intersections[to].incoming.push(forward.id);
    intersections[to].outgoing.push(reverse.id);
    intersections[from].incoming.push(reverse.id);
    streetPieces.push({
      streetId: piece.street.id,
      kind: piece.street.kind,
      district: piece.street.district,
      bridge: piece.street.bridge,
      points: piece.points,
      length: piece.length,
      roadIds: [forward.id, reverse.id],
    });
  }

  const corridors: Corridor[] = [];
  for (const spec of CORRIDOR_SPECS) {
    const roadIds = streetPieces
      .filter((piece) => spec.matches(piece.streetId))
      .flatMap((piece) => [piece.roadIds[0], piece.roadIds[1]])
      .sort((a, b) => a - b);
    if (roadIds.length > 0) {
      corridors.push({ id: corridors.length, kind: spec.kind, roadIds });
    }
  }

  const city: City = {
    size,
    seed: 0,
    gridWidth: 0,
    gridHeight: 0,
    intersections,
    roads,
    corridors,
  };

  const buildings = buildFootprints(scale);
  const bounds = boundsOfPoints([
    [0, 0],
    [WORLD.width, WORLD.height],
  ]);
  const centralCamera = { minX: 1700, minY: 1380, maxX: 2180, maxY: 1720 };
  const cityCamera = expandBounds(
    boundsOfPoints(
      intersections.length > 0
        ? intersections.map((intersection) => [intersection.x, intersection.y] as Point)
        : [[0, 0]],
    ),
    160,
  );

  const labels: ShowcaseLabel[] = [
    ...includedDistricts.map((district) => ({
      name: district.name,
      at: district.labelAt,
      rank: district.rank,
      kind: "district" as const,
    })),
    ...LANDMARKS.filter((landmark) => landmark.minScale <= scale).map((landmark) => ({
      name: landmark.name,
      at: [
        landmark.polygon.reduce((sum, point) => sum + point[0], 0) / landmark.polygon.length,
        landmark.polygon.reduce((sum, point) => sum + point[1], 0) / landmark.polygon.length,
      ] as Point,
      rank: 3,
      kind: "landmark" as const,
    })),
  ];

  return {
    scaleIndex: scale,
    size,
    city,
    streets: streetPieces,
    directedPaths,
    buildings,
    water: [riverPolygon(), ellipse(470, 1880, 95, 62, 20)],
    parks: PARKS.filter((park) => park.minScale <= scale).map((park) => park.polygon),
    districts: includedDistricts.map((district) => ({
      id: district.id,
      name: district.name,
      kind: district.kind,
      polygon: district.polygon,
    })),
    landmarks: LANDMARKS.filter((landmark) => landmark.minScale <= scale).map((landmark) => ({
      id: landmark.id,
      name: landmark.name,
      kind: landmark.kind,
      polygon: landmark.polygon,
    })),
    labels,
    bounds,
    centralCamera,
    cityCamera,
    stats: {
      intersections: intersections.length,
      roads: roads.length,
      buildings: buildings.length,
      signals: intersections.filter((intersection) => intersection.control === "signal").length,
      stops: intersections.filter((intersection) => intersection.control === "stop").length,
    },
  };
}

/** Cached compile (deterministic): the map surface and the worker share it. */
const compileCache = new Map<number, ShowcaseMapModel>();

export function showcaseCity(scaleIndex: number): ShowcaseMapModel {
  const scale = Math.min(Math.max(Math.floor(scaleIndex), 0), 4);
  const cached = compileCache.get(scale);
  if (cached) {
    return cached;
  }
  const compiled = compileShowcaseCity(scale);
  compileCache.set(scale, compiled);
  return compiled;
}

export function showcaseScaleForSize(size: CitySize): number {
  const index = SHOWCASE_SIZES.indexOf(size);
  return index === -1 ? 2 : index;
}
