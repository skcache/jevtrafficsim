/**
 * Showcase geometry (Task 11 visual correction): presentation-side helpers
 * that turn the compiled model into per-road path indexes for interpolation
 * and deck.gl, plus the vehicle visual language (wait heat, lane side).
 *
 * Framework-free: no map library, no React, no DOM.
 */
import type { MapModel } from "@/cities/map-model";
import { buildPathIndex, samplePathIndex, type PathIndex, type PathSample } from "@/cities/paths";
import type { RoadId } from "@/sim/types";

/** Wait-heat thresholds (blocked time, ms) — the product's congestion signal. */
export const WAIT_HEAT_THRESHOLDS_MS = [5_000, 15_000, 30_000, 60_000] as const;
export type WaitHeatBucket = 0 | 1 | 2 | 3 | 4;
/**
 * Warm ink ramp (blocked time): neutral -> amber -> orange -> red -> deep red.
 * Bucket 1 is deliberately darker than the highway gold (#F8CE8B / #D9A85C)
 * so a waiting vehicle never disappears on an arterial.
 */
export const WAIT_HEAT_COLORS = [
  [74, 70, 64],
  [184, 134, 42],
  [192, 90, 24],
  [163, 51, 40],
  [110, 27, 26],
] as const;

export function waitHeatBucket(blockedWaitMs: number): WaitHeatBucket {
  if (!Number.isFinite(blockedWaitMs) || blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[0]) {
    return 0;
  }
  if (blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[1]) {
    return 1;
  }
  if (blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[2]) {
    return 2;
  }
  if (blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[3]) {
    return 3;
  }
  return 4;
}

/**
 * Lane offset applied in world metres. Vehicles drive on the RIGHT side of
 * their direction of travel, so the two directions of one physical road
 * separate purely from heading.
 *
 * The offset is REQUIRED, and comes from `render/road-presentation` (the
 * carriageway's own lane group). There is deliberately no default: a silent
 * 3.2 m constant here is how every vehicle ended up on one made-up lane
 * whatever the road was.
 */
export function applyLaneOffset(sample: PathSample, metres: number): PathSample {
  return {
    x: sample.x + Math.sin(sample.heading) * metres,
    y: sample.y - Math.cos(sample.heading) * metres,
    heading: sample.heading,
  };
}

/** Per-directed-road path indexes, built once per compiled scale. */
export type DirectedPathIndexes = readonly (PathIndex | null)[];

export function buildDirectedPathIndexes(model: MapModel): DirectedPathIndexes {
  return model.directedPaths.map((points) => (points ? buildPathIndex(points) : null));
}

export function sampleDirectedRoad(
  indexes: DirectedPathIndexes,
  roadId: RoadId,
  progress: number,
): PathSample | null {
  const index = indexes[roadId];
  if (!index) {
    return null;
  }
  return samplePathIndex(index, progress);
}

/**
 * Sample plus right-side lane offset, ready for rendering. The offset is passed
 * in from the carriageway model — never defaulted here.
 */
export function sampleDirectedRoadWithLane(
  indexes: DirectedPathIndexes,
  roadId: RoadId,
  progress: number,
  laneOffsetMetres: number,
): PathSample | null {
  const sample = sampleDirectedRoad(indexes, roadId, progress);
  return sample ? applyLaneOffset(sample, laneOffsetMetres) : null;
}
