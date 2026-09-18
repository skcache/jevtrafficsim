/**
 * Showcase city — authored master data (Task 11 visual correction).
 *
 * ONE fictional city, five nested scales. This module holds the declarative
 * geography (districts, streets with presentation geometry, water, parks,
 * landmarks, labels). It is framework-free and deterministic: no RNG, no
 * seed input — traffic seeds never move downtown, the river, or the stadium.
 *
 * Street ids are stable source ids; `showcase-city.ts` compiles each scale to
 * the dense numeric City schema the simulation consumes.
 *
 * Coordinate space: metres, x east, y north, origin at the south-west of the
 * world. District archetypes are deliberately recognizable without copying
 * any real map geometry.
 */
import type { RoadKind } from "@/sim/types";
import { ellipsePolygon, rectPolygon, smoothPath, type Point } from "./paths";

export interface ShowcaseDistrict {
  readonly id: string;
  readonly name: string;
  readonly kind:
    | "downtown"
    | "civic"
    | "residential"
    | "market"
    | "riverside"
    | "industrial"
    | "arena"
    | "outer";
  readonly minScale: number;
  readonly polygon: readonly Point[];
  readonly labelAt: Point;
  /** Label rank: lower = more prominent at far zoom. */
  readonly rank: number;
}

export interface ShowcaseStreet {
  readonly id: string;
  readonly from: Point;
  readonly to: Point;
  /** Optional control points between from and to (curved presentation). */
  readonly via?: readonly Point[];
  readonly kind: RoadKind;
  readonly minScale: number;
  readonly district: string;
  /** Bridge metadata (kind must be "bridge"). */
  readonly bridge?: { readonly name: string; readonly rank: number };
}

export interface ShowcaseLandmark {
  readonly id: string;
  readonly name: string;
  readonly minScale: number;
  readonly polygon: readonly Point[];
  readonly kind: "stadium" | "tower" | "plaza" | "roundabout";
}

export interface ShowcasePark {
  readonly id: string;
  readonly name: string;
  readonly minScale: number;
  readonly polygon: readonly Point[];
}

export const WORLD = { width: 5600, height: 4600 } as const;

const SCALE = { tiny: 0, small: 1, medium: 2, large: 3, metro: 4 } as const;

/** Browser-facing labels for the five nested scales (CitySize stays internal). */
export const SHOWCASE_SCALE_LABELS = ["Tiny", "Small", "Medium", "Large", "Metro"] as const;
export const SHOWCASE_SCALE_DESCRIPTIONS = [
  "Central core",
  "Downtown + neighborhoods",
  "River + bridges",
  "Highway + arena",
  "Full city",
] as const;

/* ------------------------------------------------------------------ */
/* Streets                                                             */
/* ------------------------------------------------------------------ */

const streets: ShowcaseStreet[] = [];

function street(
  id: string,
  from: Point,
  to: Point,
  kind: RoadKind,
  minScale: number,
  district: string,
  options: { via?: Point[]; bridge?: { name: string; rank: number } } = {},
): void {
  streets.push({ id, from, to, kind, minScale, district, via: options.via, bridge: options.bridge });
}

/* Central: dense downtown grid, short blocks, wide avenues. */
const CENTRAL_AVENUES = [1520, 1730, 1940, 2150, 2360];
const CENTRAL_STREETS = [1100, 1250, 1400, 1550, 1700, 1850, 2000];
for (const x of CENTRAL_AVENUES) {
  street(`central-ns-${x}`, [x, 1100], [x, 2000], "arterial", SCALE.tiny, "central");
}
for (const y of CENTRAL_STREETS) {
  const kind: RoadKind = y === 1550 ? "arterial" : "local";
  street(`central-ew-${y}`, [1520, y], [2360, y], kind, SCALE.tiny, "central");
}

/* Civic Circle: radial spokes + a ring, one big circular junction. */
const CIVIC_CENTER: Point = [1150, 800];
const CIVIC_RADIUS = 250;
const civicRingNodes: Point[] = [];
for (let k = 0; k < 8; k += 1) {
  const angle = ((22.5 + k * 45) * Math.PI) / 180;
  civicRingNodes.push([
    CIVIC_CENTER[0] + Math.cos(angle) * CIVIC_RADIUS,
    CIVIC_CENTER[1] + Math.sin(angle) * CIVIC_RADIUS,
  ]);
}
for (let k = 0; k < 8; k += 1) {
  street(`civic-spoke-${k}`, CIVIC_CENTER, civicRingNodes[k], "arterial", SCALE.small, "civic-circle");
  const a = civicRingNodes[k];
  const b = civicRingNodes[(k + 1) % 8];
  const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const outward: Point = [
    CIVIC_CENTER[0] + (mid[0] - CIVIC_CENTER[0]) * 1.09,
    CIVIC_CENTER[1] + (mid[1] - CIVIC_CENTER[1]) * 1.09,
  ];
  street(`civic-ring-${k}`, a, b, "local", SCALE.small, "civic-circle", { via: [outward] });
}
/* Civic connectors: the ring reaches up into Central and across to West Park. */
street("civic-link-north", [1246, 1031], [1246, 1100], "local", SCALE.small, "civic-circle");
street("civic-link-southeast", [1381, 704], [1520, 704], "local", SCALE.small, "civic-circle");
street("civic-link-avenue", [1520, 704], [1520, 1100], "arterial", SCALE.small, "civic-circle");
street("civic-link-west", [919, 896], [700, 896], "local", SCALE.small, "civic-circle");

/* West Park: curving residential streets, T-junctions, a big neighborhood park. */
street("westpark-collector", [700, 1100], [700, 2400], "arterial", SCALE.small, "west-park");
street("westpark-north-extension", [700, 896], [700, 1100], "local", SCALE.small, "west-park");
street("westpark-south-extension", [220, 1100], [1520, 1100], "arterial", SCALE.small, "west-park");
street("westpark-west-edge", [260, 1100], [260, 2400], "local", SCALE.small, "west-park");
street("westpark-east-edge", [1000, 1100], [1000, 2400], "local", SCALE.medium, "west-park");
street(
  "westpark-curve-a",
  [260, 1330],
  [700, 1360],
  "local",
  SCALE.small,
  "west-park",
  { via: [[420, 1390], [560, 1330]] },
);
street(
  "westpark-curve-b",
  [260, 1530],
  [700, 1520],
  "local",
  SCALE.small,
  "west-park",
  { via: [[430, 1580], [570, 1490]] },
);
street(
  "westpark-curve-c",
  [260, 1710],
  [700, 1700],
  "local",
  SCALE.medium,
  "west-park",
  { via: [[450, 1750], [580, 1670]] },
);
street(
  "westpark-curve-d",
  [260, 2050],
  [700, 2060],
  "local",
  SCALE.medium,
  "west-park",
  { via: [[450, 2010], [580, 2090]] },
);
street("westpark-south-edge", [260, 2400], [700, 2400], "local", SCALE.medium, "west-park");
street(
  "westpark-curve-e",
  [700, 2250],
  [1000, 2260],
  "local",
  SCALE.medium,
  "west-park",
  { via: [[850, 2210]] },
);
street("westpark-link-south", [700, 2400], [1000, 2400], "local", SCALE.medium, "west-park");

/* Riverside: waterfront strip between downtown and the river. */
street(
  "riverside-waterfront",
  [700, 2400],
  [2700, 2210],
  "local",
  SCALE.medium,
  "riverside",
  { via: [[1300, 2340], [2050, 2300], [2400, 2250]] },
);
street("riverside-ew-2150", [1000, 2150], [2700, 2150], "local", SCALE.medium, "riverside");
street(
  "riverside-ns-1300",
  [1300, 2100],
  [1300, 2200],
  "arterial",
  SCALE.medium,
  "riverside",
  { via: [[1300, 2150]] },
);
street(
  "riverside-ns-2050",
  [2050, 2000],
  [2050, 2200],
  "arterial",
  SCALE.medium,
  "riverside",
  { via: [[2050, 2150]] },
);
street("riverside-ns-2400", [2400, 2150], [2400, 2250], "local", SCALE.medium, "riverside");
street("riverside-ns-2700", [2700, 2150], [2700, 2210], "local", SCALE.medium, "riverside");

/* Bridges: one critical (Harbor), one secondary (Mill). Both cross the
   waterfront road exactly at its authored vertices, so the junctions exist. */
street("harbor-bridge", [2050, 2200], [2050, 2700], "bridge", SCALE.medium, "riverside", {
  bridge: { name: "Harbor Bridge", rank: 1 },
});
street("mill-bridge", [1300, 2200], [1300, 2700], "bridge", SCALE.medium, "riverside", {
  bridge: { name: "Mill Bridge", rank: 2 },
});
street("mill-link-west", [1000, 2100], [1300, 2100], "local", SCALE.medium, "riverside");

/* Market District: commercial corridor, medium blocks, wide main street. */
const MARKET_NS = [2500, 2650, 2800, 2950, 3100, 3250, 3400, 3550, 3700];
const MARKET_EW = [1100, 1250, 1400, 1550, 1700, 1850, 2000];
for (const x of MARKET_NS) {
  const kind: RoadKind = x === 3100 ? "arterial" : "local";
  street(`market-ns-${x}`, [x, 1100], [x, 2050], kind, SCALE.small, "market");
}
for (const y of MARKET_EW) {
  const kind: RoadKind = y === 1550 ? "arterial" : "local";
  street(`market-ew-${y}`, [2500, y], [3700, y], kind, SCALE.small, "market");
}
street("market-link-central", [2360, 1550], [2500, 1550], "arterial", SCALE.small, "market");

/* Northworks: industrial, wide blocks, truck corridors. */
const NW_NS = [1200, 1300, 1450, 1700, 1950, 2050, 2200, 2450, 2700];
const NW_EW = [2700, 2950, 3200, 3450, 3700, 3950, 4200];
for (const x of NW_NS) {
  const kind: RoadKind = x === 1700 || x === 2050 ? "arterial" : "local";
  street(`northworks-ns-${x}-s`, [x, 2700], [x, 3200], kind, SCALE.medium, "northworks");
  street(`northworks-ns-${x}-n`, [x, 3200], [x, 4300], kind, SCALE.large, "northworks");
}
for (const y of NW_EW) {
  const kind: RoadKind = y === 2700 || y === 3200 ? "arterial" : "local";
  const minScale = y <= 3200 ? SCALE.medium : SCALE.large;
  street(`northworks-ew-${y}`, [1200, y], [2700, y], kind, minScale, "northworks");
}

/* Arena Quarter: stadium + plaza ring + service roads. */
const ARENA_CENTER: Point = [3250, 2950];
const arenaRing: Point[] = [];
for (let k = 0; k < 12; k += 1) {
  const angle = (k / 12) * Math.PI * 2;
  arenaRing.push([
    ARENA_CENTER[0] + Math.cos(angle) * 260,
    ARENA_CENTER[1] + Math.sin(angle) * 210,
  ]);
}
for (let k = 0; k < 12; k += 1) {
  const a = arenaRing[k];
  const b = arenaRing[(k + 1) % 12];
  const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const outward: Point = [
    ARENA_CENTER[0] + (mid[0] - ARENA_CENTER[0]) * 1.07,
    ARENA_CENTER[1] + (mid[1] - ARENA_CENTER[1]) * 1.07,
  ];
  street(`arena-ring-${k}`, a, b, "local", SCALE.large, "arena", { via: [outward] });
}
street("arena-service-north", [3250, 3160], [3250, 3400], "local", SCALE.large, "arena");
street("arena-service-east", [3510, 2950], [3800, 2950], "local", SCALE.large, "arena");
street("arena-service-west", [2990, 2950], [2800, 2950], "local", SCALE.large, "arena");
street("arena-link-northworks", [2700, 2950], [2800, 2950], "local", SCALE.large, "arena");
street("arena-boulevard", [3250, 2500], [3250, 2740], "arterial", SCALE.large, "arena");
street(
  "arena-meridian-approach",
  [4250, 2350],
  [3510, 2950],
  "arterial",
  SCALE.large,
  "arena",
  { via: [[4000, 2620], [3700, 2820]] },
);

/* Highway: curved ring segment, two interchanges, one major river bridge. */
const HIGHWAY_POINTS: Point[] = [
  [120, 420],
  [700, 470],
  [1400, 580],
  [2100, 690],
  [2600, 760],
  [2950, 860],
  [3220, 1120],
  [3480, 1360],
  [3700, 1640],
  [3820, 1810],
  [3980, 2040],
  [4250, 2350],
  [4600, 2780],
  [4900, 3250],
  [5200, 3800],
  [5480, 4300],
  [5600, 4420],
];
for (let i = 0; i < HIGHWAY_POINTS.length - 1; i += 1) {
  const a = HIGHWAY_POINTS[i];
  const b = HIGHWAY_POINTS[i + 1];
  const isRiverCrossing = i === 9; // (3820,1810) -> (3980,2040) crosses the river
  const mid: Point = [
    (a[0] + b[0]) / 2 + (i % 2 === 0 ? 26 : -26),
    (a[1] + b[1]) / 2 + (i % 2 === 0 ? 14 : -14),
  ];
  if (isRiverCrossing) {
    street(`highway-${i}`, a, b, "bridge", SCALE.large, "market", {
      via: [mid],
      bridge: { name: "Meridian Bridge", rank: 1 },
    });
  } else {
    street(`highway-${i}`, a, b, "highway", SCALE.large, "market", { via: [mid] });
  }
}
/* Interchange (Large): ramps feeding the Market District. */
street(
  "interchange-market-west",
  [2950, 860],
  [2950, 1100],
  "highway",
  SCALE.large,
  "market",
  { via: [[2905, 985]] },
);
street(
  "interchange-market-east",
  [2950, 860],
  [3100, 1100],
  "highway",
  SCALE.large,
  "market",
  { via: [[3065, 985]] },
);

/* Metro extensions: outer neighborhoods, a second interchange, outer loop. */
street("metro-highland-w", [500, 3900], [500, 4300], "local", SCALE.metro, "highland");
street("metro-highland-e", [1000, 3900], [1000, 4300], "local", SCALE.metro, "highland");
street("metro-highland-n", [500, 4300], [1000, 4300], "local", SCALE.metro, "highland");
street("metro-highland-mid", [500, 4100], [1000, 4100], "local", SCALE.metro, "highland");
street("metro-highland-link-n", [1000, 3900], [1200, 3900], "local", SCALE.metro, "highland");
street("metro-highland-link-m", [1000, 4100], [1200, 4100], "local", SCALE.metro, "highland");
street("metro-southgate-w", [4600, 1200], [4600, 1600], "local", SCALE.metro, "southgate");
street("metro-southgate-e", [5100, 1200], [5100, 1600], "local", SCALE.metro, "southgate");
street("metro-southgate-n", [4600, 1600], [5100, 1600], "local", SCALE.metro, "southgate");
street("metro-southgate-mid", [4600, 1400], [5100, 1400], "local", SCALE.metro, "southgate");
street("metro-southgate-link", [3700, 1400], [4600, 1400], "arterial", SCALE.metro, "southgate");
street("metro-loop-n", [5100, 1600], [5100, 2600], "arterial", SCALE.metro, "southgate");
street(
  "metro-loop-ne",
  [5100, 2600],
  [5150, 3050],
  "arterial",
  SCALE.metro,
  "southgate",
  { via: [[5170, 2820]] },
);
street(
  "interchange-metro-south",
  [4900, 3250],
  [4700, 3100],
  "highway",
  SCALE.metro,
  "southgate",
  { via: [[4820, 3195]] },
);
street(
  "interchange-metro-north",
  [4900, 3250],
  [5150, 3050],
  "highway",
  SCALE.metro,
  "southgate",
  { via: [[5015, 3155]] },
);
street("metro-arena-north", [3250, 3400], [3250, 3900], "local", SCALE.metro, "arena");
street(
  "metro-north-arterial",
  [3250, 3900],
  [5200, 3800],
  "arterial",
  SCALE.metro,
  "arena",
  { via: [[3900, 4080], [4600, 3980]] },
);

/* ------------------------------------------------------------------ */
/* Water, parks, districts, landmarks                                  */
/* ------------------------------------------------------------------ */

const RIVER_CENTERLINE: Point[] = [
  [0, 2560],
  [600, 2530],
  [1300, 2490],
  [2000, 2450],
  [2600, 2400],
  [3200, 2300],
  [3800, 2130],
  [4400, 1900],
  [5000, 1600],
  [5600, 1300],
];

export function riverCenterline(): Point[] {
  return smoothPath(RIVER_CENTERLINE, 6);
}

export const RIVER_HALF_WIDTH = 90;

export function riverPolygon(): Point[] {
  const center = riverCenterline();
  const south: Point[] = center.map(([x, y]) => [x, y - RIVER_HALF_WIDTH]);
  const north: Point[] = center.map(([x, y]) => [x, y + RIVER_HALF_WIDTH]);
  return [...south, ...north.reverse()];
}

export const DISTRICTS: readonly ShowcaseDistrict[] = [
  {
    id: "central",
    name: "Central",
    kind: "downtown",
    minScale: SCALE.tiny,
    polygon: rectPolygon(1500, 1080, 2380, 2020),
    labelAt: [1940, 1550],
    rank: 0,
  },
  {
    id: "civic-circle",
    name: "Civic Circle",
    kind: "civic",
    minScale: SCALE.small,
    polygon: ellipsePolygon(1150, 800, 470, 470, 10),
    labelAt: [1150, 800],
    rank: 2,
  },
  {
    id: "west-park",
    name: "West Park",
    kind: "residential",
    minScale: SCALE.small,
    polygon: rectPolygon(220, 1080, 1320, 2420),
    labelAt: [620, 1500],
    rank: 2,
  },
  {
    id: "market",
    name: "Market District",
    kind: "market",
    minScale: SCALE.small,
    polygon: rectPolygon(2480, 1080, 3720, 2070),
    labelAt: [3100, 1550],
    rank: 1,
  },
  {
    id: "riverside",
    name: "Riverside",
    kind: "riverside",
    minScale: SCALE.medium,
    polygon: rectPolygon(1000, 2040, 2700, 2440),
    labelAt: [1750, 2225],
    rank: 2,
  },
  {
    id: "northworks",
    name: "Northworks",
    kind: "industrial",
    minScale: SCALE.medium,
    polygon: rectPolygon(1180, 2680, 2720, 4320),
    labelAt: [1950, 3500],
    rank: 1,
  },
  {
    id: "arena",
    name: "Arena Quarter",
    kind: "arena",
    minScale: SCALE.large,
    polygon: rectPolygon(2780, 2430, 3820, 3420),
    labelAt: [3250, 2950],
    rank: 1,
  },
  {
    id: "highland",
    name: "Highland",
    kind: "outer",
    minScale: SCALE.metro,
    polygon: rectPolygon(450, 3850, 1050, 4350),
    labelAt: [750, 4100],
    rank: 3,
  },
  {
    id: "southgate",
    name: "Southgate",
    kind: "outer",
    minScale: SCALE.metro,
    polygon: rectPolygon(4550, 1150, 5250, 3150),
    labelAt: [4900, 2300],
    rank: 3,
  },
];

export const PARKS: readonly ShowcasePark[] = [
  {
    id: "west-park-green",
    name: "West Park Green",
    minScale: SCALE.small,
    polygon: rectPolygon(300, 1740, 640, 2020),
  },
  {
    id: "civic-plaza",
    name: "Civic Plaza",
    minScale: SCALE.tiny,
    polygon: rectPolygon(1960, 1570, 2130, 1680),
  },
  {
    id: "civic-garden",
    name: "Civic Garden",
    minScale: SCALE.small,
    polygon: ellipsePolygon(1150, 800, 60, 60, 12),
  },
  {
    id: "arena-plaza",
    name: "Arena Plaza",
    minScale: SCALE.large,
    polygon: ellipsePolygon(3250, 2950, 250, 200, 16),
  },
  {
    id: "market-square",
    name: "Market Square",
    minScale: SCALE.small,
    polygon: rectPolygon(3250, 1560, 3400, 1690),
  },
  {
    id: "riverside-landing",
    name: "Riverside Landing",
    minScale: SCALE.medium,
    polygon: rectPolygon(1600, 2280, 1900, 2380),
  },
];

export const LANDMARKS: readonly ShowcaseLandmark[] = [
  {
    id: "stadium",
    name: "Arena",
    minScale: SCALE.large,
    polygon: ellipsePolygon(3250, 2950, 185, 135, 28),
    kind: "stadium",
  },
  {
    id: "central-tower",
    name: "Grand Tower",
    minScale: SCALE.tiny,
    polygon: rectPolygon(1745, 1585, 1855, 1690),
    kind: "tower",
  },
  {
    id: "civic-roundabout",
    name: "Civic Circle",
    minScale: SCALE.small,
    polygon: ellipsePolygon(1150, 800, 42, 42, 16),
    kind: "roundabout",
  },
];

export const STREETS: readonly ShowcaseStreet[] = streets;

/** Rough district polygons used to place buildings (inset block areas). */
export const BUILDING_ZONES: readonly {
  readonly district: string;
  readonly minScale: number;
  readonly polygon: readonly Point[];
}[] = [
  { district: "central", minScale: SCALE.tiny, polygon: rectPolygon(1520, 1100, 2360, 2000) },
  { district: "market", minScale: SCALE.small, polygon: rectPolygon(2500, 1100, 3700, 2050) },
  { district: "west-park", minScale: SCALE.small, polygon: rectPolygon(260, 1100, 1000, 2400) },
  { district: "riverside", minScale: SCALE.medium, polygon: rectPolygon(1000, 2050, 2700, 2400) },
  { district: "northworks", minScale: SCALE.medium, polygon: rectPolygon(1200, 2700, 2700, 4300) },
  { district: "arena", minScale: SCALE.large, polygon: rectPolygon(2990, 2500, 3800, 3400) },
  { district: "highland", minScale: SCALE.metro, polygon: rectPolygon(500, 3900, 1000, 4300) },
  { district: "southgate", minScale: SCALE.metro, polygon: rectPolygon(4600, 1200, 5100, 2600) },
];

export { SCALE as SHOWCASE_SCALE_INDEX };
