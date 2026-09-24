/**
 * Route traffic classification (Issue #25): the ONE rule set that turns the
 * worker's sparse road aggregates into the three states the ego's route paints
 * in.
 *
 *   BLUE   free-flow baseline
 *   AMBER  meaningful slowdown
 *   RED    heavy congestion / severe delay / closed
 *
 * Rules are deterministic and use only stable simulation quantities —
 * occupancy vs capacity, queued count, longest blocked wait and the road's
 * runtime closure state. Nothing here reads the controller, wall-clock time or
 * anything random, so the same frame always classifies the same way.
 *
 * A road absent from `roadTraffic` is a FREE baseline road: the worker sends
 * only roads that carry state.
 */
import type { PresentationRoadTraffic, PresentationSnapshot } from "@/worker/presentation-snapshot";
import { congestionLevelFor } from "./congestion";
import type { RoadId } from "@/sim/types";

export type RouteTrafficClass = "free" | "slowed" | "congested";


/** Blue / amber / red, tuned warm enough to sit on the Chicago basemap. */
export const ROUTE_TRAFFIC_COLORS: Record<RouteTrafficClass, readonly [number, number, number]> = {
  free: [45, 108, 202],
  slowed: [211, 141, 28],
  congested: [187, 52, 42],
};

export function occupancyRatio(entry: PresentationRoadTraffic): number {
  if (entry.capacity <= 0) {
    return 0;
  }
  return entry.occupancy / entry.capacity;
}

/**
 * Classify one road. `closed` comes from the snapshot's road conditions: a
 * closed road on the route can never be free.
 */
export function classifyRoadTraffic(
  entry: PresentationRoadTraffic | undefined,
  closed = false,
): RouteTrafficClass {
  if (closed) {
    return "congested";
  }
  if (!entry) {
    // Absent from the sparse frame = free flow. Same contract as the sim.
    return "free";
  }
  // The SAME rule the city overlay uses (render/congestion): severity, occupancy
  // ratio, queues and blocked wait. Reading severity alone left the route blue
  // through rush hour - measured, 54 frames of a drive had a route road the
  // simulation called "slower" and the route never rendered slowed or congested.
  const level = congestionLevelFor({
    severity: entry.severity,
    occupancyRatio: entry.capacity > 0 ? entry.occupancy / entry.capacity : 0,
    queuedCount: entry.queuedCount,
    maxBlockedWaitMs: entry.maxBlockedWaitMs,
  });
  if (level === "severe" || level === "bad") {
    return "congested";
  }
  return level === "warm" ? "slowed" : "free";
}

/**
 * Whole-frame classification: sparse aggregates joined with closure state.
 * Only roads that appear in the frame are present; callers treat a missing
 * road as free.
 */
export function classifySnapshotRoads(
  snapshot: PresentationSnapshot,
): Map<RoadId, RouteTrafficClass> {
  const closed = new Set<RoadId>();
  for (const condition of snapshot.roadConditions) {
    if (condition.closed) {
      closed.add(condition.roadId);
    }
  }
  const classes = new Map<RoadId, RouteTrafficClass>();
  for (const road of snapshot.roadTraffic) {
    classes.set(road.roadId, classifyRoadTraffic(road, closed.has(road.roadId)));
  }
  // Closures the aggregates have not reported yet still classify.
  for (const roadId of closed) {
    if (!classes.has(roadId)) {
      classes.set(roadId, "congested");
    }
  }
  return classes;
}

/** Convenience: class for a route road, defaulting to the free baseline. */
export function classForRoad(
  classes: ReadonlyMap<RoadId, RouteTrafficClass>,
  roadId: RoadId,
): RouteTrafficClass {
  return classes.get(roadId) ?? "free";
}
