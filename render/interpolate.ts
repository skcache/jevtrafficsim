/**
 * Snapshot interpolation (Task 11): pure logic that turns 5 Hz presentation
 * frames into smooth 60 Hz vehicle positions. Never mutates received frames.
 *
 * Scheme: the main thread keeps (previous, current) frames plus the arrival
 * timestamp of `current`; each animation frame renders between previous ->
 * current with `alpha` from wall time. One frame of visual latency, no
 * extrapolation, linear motion across intersections (no path splines).
 *
 * Vehicle positions are derived from the static render model: a directed
 * road's world segment is `directedToSegment[roadId]` and progress/length
 * places the vehicle along it (the directed road's own from -> to direction,
 * NOT the segment's canonical orientation).
 */
import { laneSignForRoad, type StaticRenderModel, type WorldPoint } from "./model";
import type { PresentationSnapshot, PresentationVehicle } from "@/worker/presentation-snapshot";

export interface RenderedVehicle {
  readonly id: number;
  readonly type: PresentationVehicle["type"];
  readonly state: PresentationVehicle["state"];
  readonly x: number;
  readonly y: number;
  readonly headingRadians: number;
  readonly blockedWaitMs: number;
  /** Lane side (+1/-1) for the screen-space perpendicular offset. */
  readonly laneSign: 1 | -1;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * World position of a directed-road vehicle. Uses the DIRECTIONAL geometry of
 * the directed road (its own endpoints), so progress counts from its `from`.
 * Returns null for defensively unrenderable vehicles (no road / bad ids).
 */
export function vehicleWorldPosition(
  model: StaticRenderModel,
  vehicle: PresentationVehicle,
): WorldPoint | null {
  if (vehicle.roadId === null) {
    return null;
  }
  const road = model.roads[vehicle.roadId];
  if (!road) {
    return null;
  }
  const length = road.length > 0 ? road.length : 1;
  const fraction = clamp01(vehicle.progress / length);
  return {
    x: road.from.x + (road.to.x - road.from.x) * fraction,
    y: road.from.y + (road.to.y - road.from.y) * fraction,
  };
}

/**
 * Interpolates one frame. `previous` may be null (first frame): everything
 * renders at its current position. Vehicles present only in `current` appear
 * at their current position; vehicles only in `previous` are omitted.
 */
export function interpolateVehicles(
  model: StaticRenderModel,
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
    const currentPosition = vehicleWorldPosition(model, vehicle);
    if (!currentPosition) {
      continue;
    }
    const before = previousById.get(vehicle.id);
    const beforePosition = before ? vehicleWorldPosition(model, before) : null;
    const x = beforePosition
      ? beforePosition.x + (currentPosition.x - beforePosition.x) * t
      : currentPosition.x;
    const y = beforePosition
      ? beforePosition.y + (currentPosition.y - beforePosition.y) * t
      : currentPosition.y;
    // Heading follows the vehicle's CURRENT directed road: stable for
    // stationary (queued) vehicles and consistent with the lane offset.
    const road = vehicle.roadId === null ? undefined : model.roads[vehicle.roadId];
    const headingRadians = road
      ? Math.atan2(road.to.y - road.from.y, road.to.x - road.from.x)
      : 0;
    rendered.push({
      id: vehicle.id,
      type: vehicle.type,
      state: vehicle.state,
      x,
      y,
      headingRadians,
      blockedWaitMs: vehicle.blockedWaitMs,
      laneSign: road ? laneSignForRoad({ from: road.fromId, to: road.toId }) : 1,
    });
  }
  return rendered;
}

/**
 * Alpha for the current animation frame: fraction of the expected snapshot
 * interval elapsed since the current frame arrived, clamped to [0, 1].
 */
export function frameAlpha(
  nowMs: number,
  currentFrameReceivedAtMs: number,
  expectedSnapshotIntervalMs: number,
): number {
  if (expectedSnapshotIntervalMs <= 0) {
    return 1;
  }
  return clamp01((nowMs - currentFrameReceivedAtMs) / expectedSnapshotIntervalMs);
}
