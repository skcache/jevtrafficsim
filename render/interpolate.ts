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
import { vehicleLaneOffsetMetres } from "@/render/road-presentation";
import type { City } from "@/sim/types";
import type {
  PresentationEgoVehicle,
  PresentationSnapshot,
} from "@/worker/presentation-snapshot";

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function frameAlpha(nowMs: number, receivedAtMs: number, expectedIntervalMs: number): number {
  if (expectedIntervalMs <= 0) {
    return 1;
  }
  return clamp01((nowMs - receivedAtMs) / expectedIntervalMs);
}

/**
 * Time constant of the render clock's low-pass, in real milliseconds.
 *
 * Frames arrive when the worker finishes a tick, which is jittery: a tick that
 * runs long delivers its frame late, and a naive alpha then sits pinned at 1
 * (a frozen world) before snapping forward. Following the frame clock through a
 * short low-pass absorbs that jitter and turns lumpy arrivals into continuous
 * motion. It is deliberately shorter than a frame interval so the car never
 * feels like it is lagging the simulation.
 */
export const RENDER_CLOCK_TAU_MS = 70;

/**
 * Advance the render clock toward the frame clock.
 *
 * The clock is expressed in SIMULATED milliseconds, between the previous and
 * current frame timestamps, so smoothing can never push a position off its
 * road: the value still gets converted to a path position by the same
 * path-aware interpolation as before. A target that jumps further than one
 * frame interval (a reset, a new scale, a long stall) snaps instead of easing,
 * because easing across a discontinuity would sweep the car through the city.
 */
export function smoothRenderClock(
  clockMs: number,
  targetMs: number,
  dtMs: number,
  snapDistanceMs: number,
  tauMs: number = RENDER_CLOCK_TAU_MS,
): number {
  if (!Number.isFinite(clockMs)) {
    return targetMs;
  }
  if (Math.abs(targetMs - clockMs) > snapDistanceMs) {
    return targetMs;
  }
  if (tauMs <= 0) {
    return targetMs;
  }
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tauMs);
  return clockMs + (targetMs - clockMs) * k;
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
  readonly type: PresentationEgoVehicle["type"];
  readonly state: PresentationEgoVehicle["state"];
  readonly x: number;
  readonly y: number;
  readonly headingRadians: number;
  readonly blockedWaitMs: number;
  /** 0 right after a vehicle appears, 1 once fully faded in. */
  readonly fade: number;
  /** Queue rank within its directed road (0 = front), or -1 when moving. */
  readonly queueRank: number;
}

/**
 * Display-time ego road progress.
 *
 * The map runs at rAF while worker snapshots arrive at 5 Hz. Route trimming
 * and contextual-control distance must follow the same interpolated progress as
 * the visible car or the band/light visibly step every 200 ms. Across a road
 * transition the current road wins; same-road motion is a scalar lerp.
 */
export function interpolateEgoRoadProgress(
  previous: PresentationSnapshot | null,
  current: PresentationSnapshot | null,
  alpha: number,
  indexes?: DirectedPathIndexes,
): { roadId: number | null; progress: number } | null {
  const ego = current?.ego ?? null;
  if (!ego) return null;
  const before = previous?.ego ?? null;
  const t = clamp01(alpha);
  if (before && before.id === ego.id && before.roadId === ego.roadId) {
    return {
      roadId: ego.roadId,
      progress: before.progress + (ego.progress - before.progress) * t,
    };
  }
  if (
    indexes &&
    before &&
    before.id === ego.id &&
    before.roadId !== null &&
    ego.roadId !== null &&
    before.roadId !== ego.roadId
  ) {
    const previousIndex = indexes[before.roadId];
    const currentIndex = indexes[ego.roadId];
    if (previousIndex && currentIndex) {
      const remaining = Math.max(0, previousIndex.total - before.progress);
      const travelled = Math.max(0, ego.progress);
      const total = remaining + travelled;
      if (total > 0) {
        const distance = t * total;
        if (distance <= remaining) {
          return {
            roadId: before.roadId,
            progress: Math.min(previousIndex.total, before.progress + distance),
          };
        }
        return {
          roadId: ego.roadId,
          progress: Math.min(currentIndex.total, distance - remaining),
        };
      }
    }
  }
  return { roadId: ego.roadId, progress: ego.progress };
}

export interface InterpolateOptions {
  /** Wall-clock now, for spawn fades. */
  readonly nowMs: number;
  /** When the current snapshot arrived. */
  readonly receivedAtMs: number;
  /** Per-road direction-group centre offsets; per-vehicle lane slots are added here. */
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
  // Issue #24: the frame carries ONE vehicle — the curated trip's ego car.
  // Background traffic stays in the engine, so there is no fleet to interpolate.
  const previousById = new Map<number, PresentationEgoVehicle>();
  if (previous?.ego) {
    previousById.set(previous.ego.id, previous.ego);
  }
  const fade = clamp01((options.nowMs - options.receivedAtMs) / SPAWN_FADE_IN_MS);
  const rendered: RenderedVehicle[] = [];
  for (const vehicle of current.ego ? [current.ego] : []) {
    const offset = vehicle.roadId === null ? 0 : vehicleLaneOffsetMetres(options.city, options.laneOffsets, vehicle.id, vehicle.roadId);
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
        // Heading comes from the path the position is ACTUALLY on, never from a
        // frame-wide blend between the two roads. The old lerp rotated the
        // sprite toward the next road while it was still driving down this one,
        // which is exactly the "car crabbing sideways" artefact: position on the
        // current lane, nose already pointed at the junction exit. The turn now
        // happens where the turn happens — at the junction — and everywhere else
        // the nose is the road's own tangent.
        heading = transition.heading;
      }
    } else if (before && before.roadId !== null && before.roadId === vehicle.roadId) {
      // Same-road motion interpolates scalar progress and resamples the
      // authoritative polyline. x/y lerp cuts across curves between snapshots.
      const progress = before.progress + (vehicle.progress - before.progress) * t;
      const laneOffset = vehicleLaneOffsetMetres(
        options.city,
        options.laneOffsets,
        vehicle.id,
        vehicle.roadId,
      );
      const alongRoad = positionForRoad(indexes, vehicle.roadId, progress, laneOffset);
      if (alongRoad) {
        x = alongRoad.x;
        y = alongRoad.y;
        heading = alongRoad.heading;
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

/**
 * Position and heading while crossing from one road to the next.
 *
 * Position is constrained to one of the two authoritative road paths at every
 * frame. This deliberately gives up free-space Bézier smoothing: a renderer may
 * not invent drivable geometry that the basemap does not contain. Returns null
 * when the two roads are not joined; the caller then keeps the current position.
 */
function transitionPosition(
  indexes: DirectedPathIndexes,
  before: PresentationEgoVehicle,
  current: PresentationEgoVehicle,
  t: number,
  options: InterpolateOptions,
): WorldPosition | null {
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

  const remaining = Math.max(0, previousIndex.total - before.progress);
  const travelled = Math.max(0, current.progress);
  const total = remaining + travelled;
  if (total <= 0) {
    return null;
  }

  // Position is never interpolated through free space. It walks the old road
  // to its actual endpoint, then walks the new road from its actual start.
  // This is intentionally stricter than a cosmetic Bezier: a renderer may not
  // invent drivable geometry that the map itself does not contain.
  const distance = clamp01(t) * total;
  const previousOffset = vehicleLaneOffsetMetres(options.city, options.laneOffsets, before.id, before.roadId);
  const currentOffset = vehicleLaneOffsetMetres(options.city, options.laneOffsets, current.id, current.roadId);
  // The two tangents that meet at the shared node: this road's end, and the next
  // road's start.
  const incomingHeading = samplePathIndex(previousIndex, previousIndex.total).heading;
  const outgoingHeading = samplePathIndex(currentIndex, 0).heading;

  // Lane centres on two roads generally do not meet at exactly the same
  // coordinate. Taper each lane offset into the junction centre, then back out
  // on the next road. This preserves lane identity away from the junction while
  // guaranteeing a continuous path through the shared node.
  const laneTaperM = 8;
  if (distance <= remaining) {
    const progress = before.progress + distance;
    const distanceToJunction = Math.max(0, previousIndex.total - progress);
    const taper = Math.min(1, distanceToJunction / laneTaperM);
    const position = applyLaneOffset(
      samplePathIndex(previousIndex, progress),
      previousOffset * taper,
    );
    // The nose follows THIS road's tangent, and only starts rotating inside the
    // junction window — the last few metres before the node, eased so a 90 degree
    // turn is distributed over a handful of frames instead of snapping. Half a
    // block early is a bug; rotating after the node is a different bug; both are
    // excluded by construction here.
    const blend = smoothstep(clamp01(1 - distanceToJunction / TURN_WINDOW_M));
    return { ...position, heading: lerpAngle(incomingHeading, outgoingHeading, blend) };
  }

  const outgoingProgress = Math.min(currentIndex.total, distance - remaining);
  const taper = Math.min(1, Math.max(0, outgoingProgress) / laneTaperM);
  const position = applyLaneOffset(
    samplePathIndex(currentIndex, outgoingProgress),
    currentOffset * taper,
  );
  // Past the node the turn is done: the nose is exactly the new road's tangent.
  return position;
}

/** Metres before the junction where the sprite begins rotating into the turn. */
const TURN_WINDOW_M = 8;

/** 0..1 with zero slope at both ends, so the turn eases in and out. */
function smoothstep(value: number): number {
  return value * value * (3 - 2 * value);
}
