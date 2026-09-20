/**
 * Deterministic materialization and route diagnostics for the public Chicago
 * challenge catalog.
 *
 * Landmark identity/addresses were researched from public Chicago sources; the
 * static catalog itself lives in trip-catalog.ts so client UI/protocol code does
 * not pull routing implementation into its bundle.
 */
import { nearestIntersectionTo } from "@/cities/chicago";
import {
  CHALLENGE_SCALE_INDEX,
  curatedTripById,
  type CuratedTripAnchor,
  type CuratedTripSelection,
} from "@/cities/trip-catalog";
import { lngLatToMetric, type MapModel, type StreetPiece } from "@/cities/map-model";
import { findRoute, type RouteFound } from "@/sim/astar";
import type { CorridorKind, RoadId, RoadKind } from "@/sim/types";

export {
  CHALLENGE_CITY_SIZE,
  CHALLENGE_SCALE_INDEX,
  CURATED_TRIPS,
  CURATED_TRIP_IDS,
  DEFAULT_CURATED_TRIP_ID,
  challengeScenarioKey as _unused,
} from "@/cities/trip-catalog";
export type {
  CuratedTrip,
  CuratedTripAnchor,
  CuratedTripCameraHints,
  CuratedTripId,
  CuratedTripSelection,
} from "@/cities/trip-catalog";

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
  readonly trip: ReturnType<typeof curatedTripById>;
  readonly selection: CuratedTripSelection;
  readonly scenarioKey: string;
  readonly originIntersectionId: number;
  readonly destinationIntersectionId: number;
  readonly originSnapDistanceM: number;
  readonly destinationSnapDistanceM: number;
  readonly route: RouteFound;
  readonly metadata: CuratedTripRouteMetadata;
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
  if (
    osmClass === "motorway" ||
    osmClass === "trunk" ||
    osmClass === "motorway_link" ||
    osmClass === "trunk_link"
  ) {
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
