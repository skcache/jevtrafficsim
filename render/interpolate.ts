/**
 * Frame interpolation between worker snapshots (~10 Hz) at display rate.
 *
 * Two things here are physical rather than cosmetic:
 *
 * - Lane placement comes from the road presentation model: each vehicle sits at
 *   the centre of its direction's lane group, so opposing traffic separates and
 *   nothing drives on the kerb.
 * - Road transitions are path-aware. A vehicle crossing an intersection is
 *   interpolated along the path (previous road -> shared junction -> current
 *   road) rather than straight-lined between the two positions, which used to
 *   cut the corner through buildings on turns.
 */
import type { PathIndex } from "@/cities/paths";
import { samplePathIndex } from "@/cities/paths";
import type { DirectedPathIndexes } from "@/render/map-geometry";
import { applyLaneOffset } from "@/render/map-geometry";
import type { City } from "@/sim/types";
import type { PresentationSnapshot, PresentationVehicle } from "@/worker/presentation-snapshot";

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function frameAlpha(nowMs: number, receivedAtMs: number, expectedIntervalMs: number): number {
  if (expectedIntervalMs <= 0) {
    return 1;
  }
  return clamp01((nowMs - receivedAtMs) / expectedIntervalMs);
}

/** Fade-in for vehicles that appeared since the previous frame. */
export const SPAWN_FADE_IN_MS = 200;

/** Shortest signed angular difference, in (-pi, pi]. */
export function angleDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  if (delta <= -Math.PI) {
    delta += Math.PI * 2;
  }
  return delta;
}

/** Interpolate headings the short way around (never through +-pi). */
export function lerpAngle(from: number, to: number, t: number): number {
  return from + angleDelta(from, to) * t;
}

export interface WorldPosition {
  readonly x: number;
  readonly y: number;
  readonly heading: number;
}

/**
 * World position of a directed-road vehicle along its presentation path,
 * offset to the centre of its own direction's lane group.
 */
export function positionForRoad(
  indexes: readonly (PathIndex | null)[],
  roadId: number | null,
  progress: number,
  laneOffsetMetres: number,
): WorldPosition | null {
  if (roadId === null) {
    return null;
  }
  const index = indexes[roadId];
  if (!index) {
    return null;
  }
  return applyLaneOffset(samplePathIndex(index, progress), laneOffsetMetres);
}

export interface RenderedVehicle {
  readonly id: number;
  readonly roadId: number | null;
  readonly type: PresentationVehicle["type"];
  readonly state: PresentationVehicle["state"];
  readonly x: number;
  readonly y: number;
  readonly headingRadians: number;
  readonly blockedWaitMs: number;
  /** 0 right after a vehicle appears, 1 once fully faded in. */
  readonly fade: number;
  /** Queue rank within its directed road (0 = front), or -1 when moving. */
  readonly queueRank: number;
}

export interface InterpolateOptions {
  /** Wall-clock now, for spawn fades. */
  readonly nowMs: number;
  /** When the current snapshot arrived. */
  readonly receivedAtMs: number;
  /** Per-road lane-centre offsets in metres (see render/road-presentation). */
  readonly laneOffsets: readonly number[];
  /** Road connectivity, for path-aware turns through junctions. */
  readonly city: City;
}

/**
 * Interpolates one frame. `previous` may be null (first frame): everything
 * renders at its current position. Vehicles present only in `current` appear at
 * their current position with a fade-in; vehicles only in `previous` are gone.
 */
export function interpolateVehicles(
  indexes: DirectedPathIndexes,
  previous: PresentationSnapshot | null,
  current: PresentationSnapshot,
  alpha: number,
  options: InterpolateOptions,
): RenderedVehicle[] {
  const t = clamp01(alpha);
  const previousById = new Map<number, PresentationVehicle>();
  if (previous) {
    for (const vehicle of previous.vehicles) {
      previousById.set(vehicle.id, vehicle);
    }
  }
  const fade = clamp01((options.nowMs - options.receivedAtMs) / SPAWN_FADE_IN_MS);
  const rendered: RenderedVehicle[] = [];
  for (const vehicle of current.vehicles) {
    const offset = vehicle.roadId === null ? 0 : options.laneOffsets[vehicle.roadId] ?? 0;
    const currentPosition = positionForRoad(indexes, vehicle.roadId, vehicle.progress, offset);
    if (!currentPosition) {
      continue;
    }
    const before = previousById.get(vehicle.id);
    let x = currentPosition.x;
    let y = currentPosition.y;
    let heading = currentPosition.heading;
    if (before && before.roadId !== null && before.roadId !== vehicle.roadId) {
      const transition = transitionPosition(indexes, before, vehicle, t, options);
      if (transition) {
        x = transition.x;
        y = transition.y;
        // Rotate the short way between the two roads' headings while crossing,
        // instead of snapping at the junction.
        heading = lerpAngle(transition.fromHeading, transition.toHeading, t);
      }
    } else if (before) {
      const beforeOffset = before.roadId === null ? 0 : options.laneOffsets[before.roadId] ?? 0;
      const beforePosition = positionForRoad(indexes, before.roadId, before.progress, beforeOffset);
      if (beforePosition) {
        x = beforePosition.x + (currentPosition.x - beforePosition.x) * t;
        y = beforePosition.y + (currentPosition.y - beforePosition.y) * t;
        heading = lerpAngle(beforePosition.heading, currentPosition.heading, t);
      }
    }
    rendered.push({
      id: vehicle.id,
      roadId: vehicle.roadId,
      type: vehicle.type,
      state: vehicle.state,
      x,
      y,
      headingRadians: heading,
      blockedWaitMs: vehicle.blockedWaitMs,
      fade: before ? 1 : fade,
      queueRank: vehicle.queueRank ?? -1,
    });
  }
  return rendered;
}

/** Half-width of the turn window on each road, in metres. */
const TURN_WINDOW_M = 9;

/** Quadratic Bézier point. */
function quadAt(
  p0: WorldPosition,
  p1: WorldPosition,
  p2: WorldPosition,
  u: number,
): { x: number; y: number; heading: number } {
  const w = 1 - u;
  const x = w * w * p0.x + 2 * w * u * p1.x + u * u * p2.x;
  const y = w * w * p0.y + 2 * w * u * p1.y + u * u * p2.y;
  // Tangent of a quadratic Bézier: B'(u) = 2(1-u)(P1-P0) + 2u(P2-P1).
  const dx = 2 * w * (p1.x - p0.x) + 2 * u * (p2.x - p1.x);
  const dy = 2 * w * (p1.y - p0.y) + 2 * u * (p2.y - p1.y);
  return { x, y, heading: Math.atan2(dy, dx) };
}

/**
 * Position and heading while crossing from one road to the next.
 *
 * The turn is a quadratic curve: it leaves the old lane centre, bends through
 * the junction and arrives on the new lane centre, with heading taken from the
 * curve tangent. Walking the two roads and blending headings (what this did
 * before) kept position continuous but made the heading read as a snap, and it
 * cut the corner whenever the two lane centres were offset differently — which
 * is every real turn.
 *
 * The curve spans a bounded window either side of the junction, so a short
 * segment simply shrinks the window instead of producing nonsense. Returns null
 * when the two roads are not joined: the caller then keeps the current position,
 * which beats drawing a line through a block.
 */
function transitionPosition(
  indexes: DirectedPathIndexes,
  before: PresentationVehicle,
  current: PresentationVehicle,
  t: number,
  options: InterpolateOptions,
): (WorldPosition & { fromHeading: number; toHeading: number }) | null {
  if (before.roadId === null || current.roadId === null) {
    return null;
  }
  const previousIndex = indexes[before.roadId];
  const currentIndex = indexes[current.roadId];
  if (!previousIndex || !currentIndex) {
    return null;
  }
  const previousRoad = options.city.roads[before.roadId];
  const currentRoad = options.city.roads[current.roadId];
  if (!previousRoad || !currentRoad || previousRoad.to !== currentRoad.from) {
    return null;
  }
  const laneOffsets = options.laneOffsets;
  const remaining = Math.max(0, previousIndex.total - before.progress);
  const travelled = Math.max(0, current.progress);
  const total = remaining + travelled;
  if (total <= 0) {
    return null;
  }
  const distance = t * total;
  const previousOffset = laneOffsets[before.roadId] ?? 0;
  const currentOffset = laneOffsets[current.roadId] ?? 0;
  // The window shrinks on a short segment rather than overshooting the road.
  const window = Math.min(TURN_WINDOW_M, remaining, travelled);
  if (window < 0.5) {
    // Not enough room to curve: follow the geometry exactly.
    if (distance <= remaining) {
      const position = applyLaneOffset(
        samplePathIndex(previousIndex, before.progress + distance),
        previousOffset,
      );
      return { ...position, fromHeading: position.heading, toHeading: position.heading };
    }
    const position = applyLaneOffset(
      samplePathIndex(currentIndex, distance - remaining),
      currentOffset,
    );
    return { ...position, fromHeading: position.heading, toHeading: position.heading };
  }
  const turnStart = remaining - window;
  const turnEnd = remaining + window;
  if (distance < turnStart) {
    const position = applyLaneOffset(
      samplePathIndex(previousIndex, before.progress + distance),
      previousOffset,
    );
    return { ...position, fromHeading: position.heading, toHeading: position.heading };
  }
  if (distance > turnEnd) {
    const position = applyLaneOffset(
      samplePathIndex(currentIndex, distance - remaining),
      currentOffset,
    );
    return { ...position, fromHeading: position.heading, toHeading: position.heading };
  }
  const u = (distance - turnStart) / (2 * window);
  const start = applyLaneOffset(
    samplePathIndex(previousIndex, previousIndex.total - window),
    previousOffset,
  );
  const end = applyLaneOffset(samplePathIndex(currentIndex, window), currentOffset);
  // Control point: where the two lane-centre lines meet. That is what makes the
  // curve leave and arrive tangent to the roads; when the lines are parallel
  // (a straight-through movement) the junction midpoint is the honest control.
  const control = laneLineIntersection(start, end);
  const point = quadAt(start, control, end, u);
  return { ...point, fromHeading: point.heading, toHeading: point.heading };
}

/**
 * Intersection of the line through `start` along its heading with the line
 * through `end` along its heading. Parallel or degenerate inputs fall back to
 * the midpoint, which keeps a straight movement straight.
 */
function laneLineIntersection(start: WorldPosition, end: WorldPosition): WorldPosition {
  const ax = Math.cos(start.heading);
  const ay = Math.sin(start.heading);
  const bx = Math.cos(end.heading);
  const by = Math.sin(end.heading);
  const denominator = ax * by - ay * bx;
  if (Math.abs(denominator) < 1e-6) {
    return { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2, heading: start.heading };
  }
  const t = ((end.x - start.x) * by - (end.y - start.y) * bx) / denominator;
  return { x: start.x + ax * t, y: start.y + ay * t, heading: start.heading };
}
