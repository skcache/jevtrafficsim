/**
 * Route geometry: the ego's CURRENT remaining route as a list of per-road
 * polylines. Traffic class stays attached for ETA/debug summaries, while the
 * visible navigation band is intentionally one consistent blue.
 *
 * The geometry comes from the presentation frame's trip payload — which is
 * rebuilt from the vehicle's own route every frame — so an incident reroute
 * moves the drawn route immediately; the curated trip's original roads are
 * never re-used after the simulation has moved on.
 *
 * The first segment is TRIMMED to the ego's current progress: what is drawn is
 * the road still to drive, not the road behind.
 */
import type { MapModel, Projection } from "@/cities/map-model";
import { metricToLngLat } from "@/cities/map-model";
import { buildPathIndex, type Point } from "@/cities/paths";
import { classForRoad, type RouteTrafficClass } from "./route-traffic";
import type { PresentationTripProgress } from "@/worker/presentation-snapshot";
import type { RoadId } from "@/sim/types";

export interface RouteSegment {
  readonly roadId: RoadId;
  readonly path: readonly [number, number][];
  readonly traffic: RouteTrafficClass;
}

/**
 * The tail of `points` from `fromDistance` onward, with the exact start
 * position inserted so the line begins under the car rather than at the next
 * vertex.
 */
export function trimPathFrom(points: readonly Point[], fromDistance: number): Point[] {
  if (points.length < 2) {
    return [...points];
  }
  const index = buildPathIndex(points);
  const clamped = Math.max(0, Math.min(index.total, fromDistance));
  if (clamped <= 0) {
    return [...points];
  }
  let segment = 0;
  while (segment < index.cumulative.length - 2 && index.cumulative[segment + 1] < clamped) {
    segment += 1;
  }
  const start = points[segment];
  const end = points[segment + 1] ?? points[points.length - 1];
  const span = index.cumulative[segment + 1] - index.cumulative[segment];
  const t = span > 0 ? (clamped - index.cumulative[segment]) / span : 0;
  const entry: Point = [start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t];
  return [entry, ...points.slice(segment + 1)];
}

/**
 * Presentation route index aligned to the interpolated ego road.
 *
 * Worker snapshots advance `trip.routeIndex` atomically, while the visible car
 * spends part of the 200 ms interpolation interval finishing the previous road.
 * During that interval presentation must keep using the previous route segment
 * or the blue band / upcoming control jumps one intersection ahead of the car.
 */
export function presentationRouteIndex(
  trip: PresentationTripProgress,
  ego: { readonly roadId: RoadId | null } | null,
): number {
  const base = Math.max(0, Math.min(trip.routeIndex, trip.routeRoadIds.length));
  if (!ego || ego.roadId === null || trip.routeRoadIds.length === 0) {
    return base;
  }
  const candidates = [base - 1, base, base + 1];
  for (const index of candidates) {
    if (
      index >= 0 &&
      index < trip.routeRoadIds.length &&
      trip.routeRoadIds[index] === ego.roadId
    ) {
      return index;
    }
  }
  return base;
}

/**
 * Build the remaining-route segments, in driving order.
 *
 * `ego` is the interpolated on-screen car: its progress trims the current road.
 * When the car is between roads (mid-junction) the payload's routeIndex still
 * decides which roads are ahead, so the route never lags the vehicle.
 */
export function buildRouteSegments(
  model: MapModel,
  trip: PresentationTripProgress,
  ego: { readonly roadId: RoadId | null; readonly progress: number } | null,
  classes: ReadonlyMap<RoadId, RouteTrafficClass>,
): RouteSegment[] {
  const segments: RouteSegment[] = [];
  const startIndex = presentationRouteIndex(trip, ego);
  for (let index = startIndex; index < trip.routeRoadIds.length; index += 1) {
    const roadId = trip.routeRoadIds[index];
    const points = model.directedPaths[roadId];
    if (!points || points.length < 2) {
      continue;
    }
    const isCurrent = index === startIndex;
    const fromDistance = isCurrent && ego && ego.roadId === roadId ? ego.progress : 0;
    const trimmed = trimPathFrom(points, fromDistance);
    if (trimmed.length < 2) {
      continue;
    }
    segments.push({
      roadId,
      path: trimmed.map(([x, y]) => metricToLngLat(model.projection as Projection, x, y)),
      traffic: classForRoad(classes, roadId),
    });
  }
  return segments;
}

/**
 * Remaining-route membership by traffic class. This is diagnostic/summary
 * state; the citywide traffic overlay communicates traffic visually while the
 * navigation band itself stays one colour.
 */
export function routeTrafficMix(
  segments: readonly RouteSegment[],
): Record<RouteTrafficClass, number> {
  const mix: Record<RouteTrafficClass, number> = { free: 0, slowed: 0, congested: 0 };
  for (const segment of segments) {
    mix[segment.traffic] += 1;
  }
  return mix;
}
