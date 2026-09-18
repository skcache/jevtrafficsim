/**
 * Interpolation (Task 11 visual correction): pure logic that turns 5 Hz
 * presentation frames into smooth 60 Hz vehicle positions along the showcase
 * city's CURVED road geometry. Never mutates received frames.
 *
 * Scheme: the main thread keeps (previous, current, receivedAt). Each rAF:
 *   alpha = clamp((now - receivedAt) / expectedInterval, 0, 1)
 * and vehicles render between previous -> current, keeping one frame of
 * latency instead of extrapolating.
 */
import { samplePathIndex, type PathIndex } from "@/cities/paths";
import type { PresentationSnapshot, PresentationVehicle } from "@/worker/presentation-snapshot";
import { applyLaneOffset } from "./map-geometry";

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

export function frameAlpha(nowMs: number, receivedAtMs: number, expectedIntervalMs: number): number {
  if (expectedIntervalMs <= 0) {
    return 1;
  }
  return clamp01((nowMs - receivedAtMs) / expectedIntervalMs);
}

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/**
 * World position of a directed-road vehicle along its presentation path,
 * offset to the right side of travel (opposite directions never overlap).
 */
export function positionForRoad(
  indexes: readonly (PathIndex | null)[],
  roadId: number | null,
  progress: number,
): WorldPosition | null {
  if (roadId === null) {
    return null;
  }
  const index = indexes[roadId];
  if (!index) {
    return null;
  }
  return applyLaneOffset(samplePathIndex(index, progress));
}

export interface RenderedVehicle {
  readonly id: number;
  readonly type: PresentationVehicle["type"];
  readonly state: PresentationVehicle["state"];
  readonly x: number;
  readonly y: number;
  readonly headingRadians: number;
  readonly blockedWaitMs: number;
}

/**
 * Interpolates one frame. `previous` may be null (first frame): everything
 * renders at its current position. Vehicles present only in `current` appear
 * at their current position; vehicles only in `previous` are omitted.
 */
export function interpolateVehicles(
  indexes: readonly (PathIndex | null)[],
  previous: PresentationSnapshot | null,
  current: PresentationSnapshot,
  alpha: number,
): RenderedVehicle[] {
  const t = clamp01(alpha);
  const previousById = new Map<number, PresentationVehicle>();
  if (previous) {
    for (const vehicle of previous.vehicles) {
      previousById.set(vehicle.id, vehicle);
    }
  }
  const rendered: RenderedVehicle[] = [];
  for (const vehicle of current.vehicles) {
    const currentPosition = positionForRoad(indexes, vehicle.roadId, vehicle.progress);
    if (!currentPosition) {
      continue;
    }
    const before = previousById.get(vehicle.id);
    const beforePosition = before ? positionForRoad(indexes, before.roadId, before.progress) : null;
    let x = currentPosition.x;
    let y = currentPosition.y;
    if (beforePosition) {
      x = beforePosition.x + (currentPosition.x - beforePosition.x) * t;
      y = beforePosition.y + (currentPosition.y - beforePosition.y) * t;
    }
    rendered.push({
      id: vehicle.id,
      type: vehicle.type,
      state: vehicle.state,
      x,
      y,
      headingRadians: currentPosition.heading,
      blockedWaitMs: vehicle.blockedWaitMs,
    });
  }
  return rendered;
}
