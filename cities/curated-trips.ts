/**
 * Curated Chicago challenge trips.
 *
 * Product contract: the public challenge always runs against the frozen Metro
 * Chicago graph. A trip is a stable pair of real-world anchors that is snapped
 * deterministically to the nearest graph intersections, then routed through the
 * exact same A* implementation used by every vehicle.
 *
 * The catalog deliberately contains no controller field. Fixed, Adaptive and
 * later Jev receive the same city, trip, demand and incident inputs; the ego
 * trip is an evaluation target, not a private priority channel.
 *
 * Research basis (addresses/identity checked against public Chicago sources):
 * - United Center: 1901 W Madison St
 * - Navy Pier: 600 E Grand Ave
 * - Soldier Field: 1410 S Museum Campus Dr
 * - Millennium Park: 201 E Randolph St
 * - Chicago Union Station: 500 W Jackson Blvd
 * - Magnificent Mile anchor: 625 N Michigan Ave
 *
 * Coordinates use the frozen showcase's existing anchors where available and
 * public landmark coordinates for Union Station / 625 N Michigan. Runtime never
 * calls a geocoder or mapping service.
 */
import { nearestIntersectionTo } from "@/cities/chicago";
import { lngLatToMetric, type MapModel, type StreetPiece } from "@/cities/map-model";
import { findRoute, type RouteFound } from "@/sim/astar";
import type { CorridorKind, RoadId, RoadKind, TrafficLevel } from "@/sim/types";

export const CHALLENGE_SCALE_INDEX = 4;
export const CHALLENGE_CITY_SIZE = "large" as const;

export interface CuratedTripAnchor {
  readonly label: string;
  readonly lon: number;
  readonly lat: number;
}

export interface CuratedTripCameraHints {
  /** Extra world-space breathing room for route overview framing. */
  readonly overviewPaddingM: number;
  /** Preferred follow-camera zoom once the ego trip becomes the presentation. */
  readonly followZoom: number;
}

export interface CuratedTrip {
  readonly id: CuratedTripId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly origin: CuratedTripAnchor;
  readonly destination: CuratedTripAnchor;
  readonly camera: CuratedTripCameraHints;
}

const TRIP_DEFINITIONS = [
  {
    id: "united-center-to-navy-pier",
    label: "United Center → Navy Pier",
    shortLabel: "United Center → Navy Pier",
    description: "West Side to the lakefront through the downtown core.",
    origin: { label: "United Center", lon: -87.6742, lat: 41.8806 },
    destination: { label: "Navy Pier", lon: -87.6055, lat: 41.8916 },
    camera: { overviewPaddingM: 520, followZoom: 16.7 },
  },
  {
    id: "soldier-field-to-merchandise-mart",
    label: "Soldier Field → Merchandise Mart",
    shortLabel: "Soldier Field → The Mart",
    description: "South Loop to River North, crossing the downtown river network.",
    origin: { label: "Soldier Field", lon: -87.6167, lat: 41.8623 },
    destination: { label: "Merchandise Mart", lon: -87.6355, lat: 41.888611 },
    camera: { overviewPaddingM: 460, followZoom: 16.8 },
  },
  {
    id: "union-station-to-magnificent-mile",
    label: "Union Station → Magnificent Mile",
    shortLabel: "Union Station → Mag Mile",
    description: "West Loop rail hub to North Michigan Avenue.",
    origin: { label: "Chicago Union Station", lon: -87.640278, lat: 41.878611 },
    destination: { label: "Magnificent Mile", lon: -87.623798, lat: 41.89368 },
    camera: { overviewPaddingM: 420, followZoom: 16.9 },
  },
  {
    id: "navy-pier-to-willis-tower",
    label: "Navy Pier → Willis Tower",
    shortLabel: "Navy Pier → Willis Tower",
    description: "Streeterville into the Loop and across the river.",
    origin: { label: "Navy Pier", lon: -87.6055, lat: 41.8916 },
    destination: { label: "Willis Tower", lon: -87.635831, lat: 41.878611 },
    camera: { overviewPaddingM: 420, followZoom: 16.9 },
  },
  {
    id: "millennium-park-to-united-center",
    label: "Millennium Park → United Center",
    shortLabel: "Millennium Park → United Center",
    description: "Loop grid to the Near West Side and arena district.",
    origin: { label: "Millennium Park", lon: -87.6229, lat: 41.8826 },
    destination: { label: "United Center", lon: -87.6742, lat: 41.8806 },
    camera: { overviewPaddingM: 480, followZoom: 16.8 },
  },
  {
    id: "united-center-to-soldier-field",
    label: "United Center → Soldier Field",
    shortLabel: "United Center → Soldier Field",
    description: "Arena-to-stadium cross-city run built to exercise major corridors.",
    origin: { label: "United Center", lon: -87.6742, lat: 41.8806 },
    destination: { label: "Soldier Field", lon: -87.6167, lat: 41.8623 },
    camera: { overviewPaddingM: 560, followZoom: 16.7 },
  },
] as const;

export type CuratedTripId = (typeof TRIP_DEFINITIONS)[number]["id"];

export const CURATED_TRIPS: readonly CuratedTrip[] =
  TRIP_DEFINITIONS as unknown as readonly CuratedTrip[];

export const CURATED_TRIP_IDS = CURATED_TRIPS.map((trip) => trip.id) as readonly CuratedTripId[];

export const DEFAULT_CURATED_TRIP_ID: CuratedTripId = "united-center-to-navy-pier";

export interface CuratedTripSelection {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly seed: number;
}

export type RouteClassFamily =
  | "expressway"
  | "primary"
  | "secondary"
  | "tertiary"
  | "local"
  | "service"
  | "bridge";

export interface CuratedTripRouteMetadata {
  readonly distanceM: number;
  readonly freeFlowTimeMs: number;
  readonly roadKinds: readonly RoadKind[];
  readonly roadClassFamilies: readonly RouteClassFamily[];
  readonly corridorKinds: readonly CorridorKind[];
  readonly controlledIntersections: number;
  readonly signalIntersections: number;
  readonly stopIntersections: number;
  readonly namedRoads: readonly string[];
  readonly bridgeNames: readonly string[];
  readonly coverageKinds: readonly string[];
}

export interface MaterializedCuratedTrip {
  readonly trip: CuratedTrip;
  readonly selection: CuratedTripSelection;
  readonly scenarioKey: string;
  readonly originIntersectionId: number;
  readonly destinationIntersectionId: number;
  readonly originSnapDistanceM: number;
  readonly destinationSnapDistanceM: number;
  readonly route: RouteFound;
  readonly metadata: CuratedTripRouteMetadata;
}

export function isCuratedTripId(value: string): value is CuratedTripId {
  return (CURATED_TRIP_IDS as readonly string[]).includes(value);
}

export function curatedTripById(id: CuratedTripId): CuratedTrip {
  const trip = CURATED_TRIPS.find((entry) => entry.id === id);
  if (!trip) {
    throw new RangeError(`unknown curated trip id ${id}`);
  }
  return trip;
}

function validateSeed(seed: number): void {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new RangeError(`seed must be uint32, received ${seed}`);
  }
}

function snapDistanceM(model: MapModel, anchor: CuratedTripAnchor, intersectionId: number): number {
  const [x, y] = lngLatToMetric(model.projection, anchor.lon, anchor.lat);
  const intersection = model.city.intersections[intersectionId];
  return Math.hypot(intersection.x - x, intersection.y - y);
}

function roadClassFamily(osmClass: string, bridge: boolean): RouteClassFamily[] {
  const classes: RouteClassFamily[] = [];
  if (bridge) {
    classes.push("bridge");
  }
  if (osmClass === "motorway" || osmClass === "trunk" || osmClass === "motorway_link" || osmClass === "trunk_link") {
    classes.push("expressway");
  } else if (osmClass === "primary" || osmClass === "primary_link") {
    classes.push("primary");
  } else if (osmClass === "secondary" || osmClass === "secondary_link") {
    classes.push("secondary");
  } else if (osmClass === "tertiary" || osmClass === "tertiary_link") {
    classes.push("tertiary");
  } else if (osmClass === "service") {
    classes.push("service");
  } else {
    classes.push("local");
  }
  return classes;
}

function streetIndex(model: MapModel): readonly (StreetPiece | null)[] {
  const byRoad: (StreetPiece | null)[] = Array.from(
    { length: model.city.roads.length },
    () => null,
  );
  for (const piece of model.streets) {
    for (const roadId of piece.roadIds) {
      byRoad[roadId] = piece;
    }
  }
  return byRoad;
}

function routeMetadata(model: MapModel, route: RouteFound): CuratedTripRouteMetadata {
  const streetByRoad = streetIndex(model);
  const roadKinds = new Set<RoadKind>();
  const roadClassFamilies = new Set<RouteClassFamily>();
  const namedRoads = new Set<string>();
  const bridgeNames = new Set<string>();
  let distanceM = 0;

  for (const roadId of route.roadIds) {
    const road = model.city.roads[roadId];
    const piece = streetByRoad[roadId];
    distanceM += road.length;
    roadKinds.add(road.kind);
    if (piece) {
      for (const family of roadClassFamily(piece.osmClass, piece.bridge !== undefined)) {
        roadClassFamilies.add(family);
      }
      if (piece.name) {
        namedRoads.add(piece.name);
      }
      if (piece.bridge?.name) {
        bridgeNames.add(piece.bridge.name);
      }
    }
  }

  const routeRoadIds = new Set<RoadId>(route.roadIds);
  const corridorKinds = new Set<CorridorKind>();
  for (const corridor of model.city.corridors) {
    if (corridor.roadIds.some((roadId) => routeRoadIds.has(roadId))) {
      corridorKinds.add(corridor.kind);
    }
  }

  let controlledIntersections = 0;
  let signalIntersections = 0;
  let stopIntersections = 0;
  for (const intersectionId of route.intersectionIds.slice(1, -1)) {
    const control = model.city.intersections[intersectionId]?.control;
    if (control === "signal") {
      controlledIntersections += 1;
      signalIntersections += 1;
    } else if (control === "stop") {
      controlledIntersections += 1;
      stopIntersections += 1;
    }
  }

  const coverageKinds = new Set<string>();
  for (const family of roadClassFamilies) {
    coverageKinds.add(`road:${family}`);
  }
  for (const kind of corridorKinds) {
    coverageKinds.add(`corridor:${kind}`);
  }

  return {
    distanceM,
    freeFlowTimeMs: route.cost * 1000,
    roadKinds: [...roadKinds].sort(),
    roadClassFamilies: [...roadClassFamilies].sort(),
    corridorKinds: [...corridorKinds].sort(),
    controlledIntersections,
    signalIntersections,
    stopIntersections,
    namedRoads: [...namedRoads].sort(),
    bridgeNames: [...bridgeNames].sort(),
    coverageKinds: [...coverageKinds].sort(),
  };
}

export function challengeScenarioKey(selection: CuratedTripSelection): string {
  validateSeed(selection.seed);
  return `${selection.tripId}|${selection.trafficLevel}|${selection.seed >>> 0}`;
}

/**
 * Resolves one public challenge selection against the frozen Metro graph.
 *
 * No controller appears in this API on purpose. The exact same materialized
 * trip can be handed to Fixed / Adaptive / Jev later.
 */
export function materializeCuratedTrip(
  model: MapModel,
  selection: CuratedTripSelection,
): MaterializedCuratedTrip {
  if (model.scaleIndex !== CHALLENGE_SCALE_INDEX) {
    throw new RangeError(
      `curated challenge trips require Metro Chicago (scale ${CHALLENGE_SCALE_INDEX}), received ${model.scaleIndex}`,
    );
  }
  validateSeed(selection.seed);
  const trip = curatedTripById(selection.tripId);
  const originIntersectionId = nearestIntersectionTo(
    model,
    trip.origin.lon,
    trip.origin.lat,
  );
  const destinationIntersectionId = nearestIntersectionTo(
    model,
    trip.destination.lon,
    trip.destination.lat,
  );
  if (originIntersectionId === null || destinationIntersectionId === null) {
    throw new RangeError(`trip ${trip.id} does not resolve onto the Metro graph`);
  }
  const route = findRoute(model.city, originIntersectionId, destinationIntersectionId);
  if (!route.found) {
    throw new RangeError(`trip ${trip.id} has no route on the Metro graph`);
  }
  if (route.roadIds.length === 0) {
    throw new RangeError(`trip ${trip.id} collapsed to a zero-length route`);
  }

  return {
    trip,
    selection,
    scenarioKey: challengeScenarioKey(selection),
    originIntersectionId,
    destinationIntersectionId,
    originSnapDistanceM: snapDistanceM(model, trip.origin, originIntersectionId),
    destinationSnapDistanceM: snapDistanceM(
      model,
      trip.destination,
      destinationIntersectionId,
    ),
    route,
    metadata: routeMetadata(model, route),
  };
}
