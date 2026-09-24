/**
 * Frame interpolation between worker snapshots (one per real tick) at display rate.
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
import {
  STOP_LINE_CLEARANCE_M,
  VEHICLE_LENGTH_M,
  stopLineSetbackMetres,
  vehicleLaneOffsetMetres,
} from "@/render/road-presentation";
import type { City, RoadId } from "@/sim/types";
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
 * The map runs at rAF while worker snapshots arrive at the worker tick cadence. Route trimming
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
      const transition = transitionPosition(indexes, previous, before, vehicle, t, options);
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
      const from = heldProgress(previous, before, vehicle.roadId, before.progress, options.city);
      const to = heldProgress(current, vehicle, vehicle.roadId, vehicle.progress, options.city);
      const progress = from + (to - from) * t;
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
 * The furthest along its road the rendered car may sit when the simulation says
 * it is held at the stop line.
 *
 * The simulation's control point is the graph node, but the map draws a physical
 * stop line several metres upstream. Presentation used to apply that correction
 * to the INTERPOLATED result (clamp/pack after interpolation), so the frame where
 * a car became queued yanked it backwards onto the stop line in one step —
 * measured at 8-10 m on the followed car, i.e. the hero visibly sliding backwards
 * at every red light. Correcting each SNAPSHOT's own progress instead lets the
 * interpolation carry the car the last few metres up to the stop line, which is
 * what a car actually does.
 */
/**
 * Stop-line warp (issue #56).
 *
 * The simulation's control point is the graph NODE, so a queued car sits at
 * `progress === road.length` — measured, 0.0 m from the end — while the painted
 * line is `stopLineSetbackMetres + body/2 + clearance` earlier. Two earlier
 * attempts to reconcile that in presentation each produced a different visible
 * defect: clamping the interpolated result yanked a car backwards onto the line,
 * and clamping the snapshots by PERMISSION froze a car that was still moving
 * (measured: 100% of real motion lost across the whole 0.5-3 m/s band, then a
 * ~9 m snap when it released).
 *
 * Both existed because a CLAMP is discontinuous: it holds a fixed value and
 * jumps when it lets go. This is a WARP instead. Over the last `band` metres of a
 * signal-controlled road, progress is compressed smoothly so the node maps onto
 * the line:
 *
 *     display = progress - residual * smoothstep((band - fromEnd) / band)
 *
 * - at the node, display is exactly the stop line;
 * - further back than `band`, display is untouched, so ordinary driving — and
 *   creeping behind a queue — is bit-identical to the simulation;
 * - the derivative stays positive with `band = 3 * residual`, so it is monotone:
 *   the car never moves backwards and never jumps;
 * - it is a function of progress alone: no state, no time, no filtering, and the
 *   result is always a point ON the road, never a smoothed free-space position.
 *
 * Stop-controlled nodes are excluded: the simulation has no yield behaviour, so
 * there is no queue to map, and warping them would move cars for no reason.
 */
function heldProgress(
  snapshot: PresentationSnapshot | null,
  ego: PresentationEgoVehicle | null,
  roadId: RoadId,
  progress: number,
  city: City,
): number {
  if (!snapshot || !ego || ego.roadId !== roadId) {
    return progress;
  }
  const road = city.roads[roadId];
  if (!road) {
    return progress;
  }
  const intersection = city.intersections[road.to];
  if (!intersection || intersection.control !== "signal") {
    return progress;
  }
  const bodyLength = VEHICLE_LENGTH_M[ego.type] ?? VEHICLE_LENGTH_M.car;
  const stop = Math.max(
    0,
    road.length - stopLineSetbackMetres(road.lanes) - bodyLength / 2 - STOP_LINE_CLEARANCE_M,
  );
  const residual = road.length - stop;
  if (residual <= 0.05) {
    return progress;
  }
  const band = Math.min(road.length, Math.max(residual * 3, residual + 8));
  const fromEnd = road.length - progress;
  if (fromEnd >= band) {
    return progress;
  }
  // SPATIAL gate: only the final approach is affected, so mid-block driving is
  // bit-identical to the simulation.
  const raw = 1 - fromEnd / band;
  const gate = raw * raw * (3 - 2 * raw);
  // SPEED factor: the residual is a standstill correction. A car that is moving
  // has, by definition, already crossed the point it was being held at, so the
  // correction must shrink as speed rises — otherwise the display would have to
  // make the whole residual up in one step when the car finally leaves the road.
  // At 0 m/s it is the full residual (the car waits ON the painted line); at the
  // road's own cruise speed it is gone (the display is the simulation's own
  // position). Both are frame scalars, so this stays stateless and derivable.
  const cruise = Math.max(4, road.speedLimit);
  const speedFactor = 1 - Math.min(1, Math.max(0, ego.speed ?? 0) / cruise);
  return progress - residual * gate * speedFactor;
}

/**
 * Position and heading while crossing from one road to the next.
 *
 * A straight continuation walks the road paths exactly as before: old road to
 * its node, new road from its node, nose on the road's own tangent.
 *
 * A real TURN is one rounded corner: a quadratic from where the car is on the
 * old road, through the corner where the two tangents cross, to where it will be
 * on the new road. Both the position and the heading come from that curve, so
 * the nose is always the tangent of the path the car is actually travelling.
 *
 * That last property is the fix for the sideways car. The previous version kept
 * the position on the old road while blending the heading toward the next road's
 * tangent over the last eight metres — so a sprite rotated up to 90 degrees
 * while still driving straight, which is exactly "the car goes sideways on
 * turns". Rotating early is not a smoothing trick; it is a lie about where the
 * car is going.
 */
function transitionPosition(
  indexes: DirectedPathIndexes,
  previousSnapshot: PresentationSnapshot | null,
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

  const previousProgress = heldProgress(
    previousSnapshot,
    before,
    before.roadId,
    before.progress,
    options.city,
  );
  const remaining = Math.max(0, previousIndex.total - previousProgress);
  const travelled = Math.max(0, current.progress);
  const total = remaining + travelled;
  if (total <= 0) {
    return null;
  }
  // A REROUTE is not a junction crossing. When the route changes, the ego is
  // moved to a different road with its progress reset, so "remaining + travelled"
  // can span most of a block - measured, 75 m of car sliding sideways across the
  // map in a single interpolation window, which reads exactly like the car
  // flying off its road. Nothing that long is a junction: snap to where the
  // simulation now says the car is (returning null keeps the current position)
  // and let the reroute be a reroute.
  if (total > MAX_TRANSITION_M) {
    return null;
  }

  const previousOffset = vehicleLaneOffsetMetres(options.city, options.laneOffsets, before.id, before.roadId);
  const currentOffset = vehicleLaneOffsetMetres(options.city, options.laneOffsets, current.id, current.roadId);
  // Lane centres on two roads generally do not meet at exactly the same
  // coordinate. Taper each lane offset into the junction node, then back out on
  // the next road, so the path through the shared node stays continuous.
  const laneTaperM = 8;
  const outgoingProgress = Math.min(currentIndex.total, Math.max(0, travelled));
  const incoming = applyLaneOffset(
    samplePathIndex(previousIndex, previousProgress),
    previousOffset * Math.min(1, Math.max(0, previousIndex.total - previousProgress) / laneTaperM),
  );
  const outgoing = applyLaneOffset(
    samplePathIndex(currentIndex, outgoingProgress),
    currentOffset * Math.min(1, outgoingProgress / laneTaperM),
  );
  const incomingHeading = samplePathIndex(previousIndex, previousIndex.total).heading;
  const outgoingHeading = samplePathIndex(currentIndex, 0).heading;

  const u = clamp01(t);
  if (Math.abs(angleDelta(incomingHeading, outgoingHeading)) < TURN_MIN_RADIANS) {
    // Straight through: stay on the roads themselves. Inventing a line here is
    // what used to drift vehicles off curved carriageways.
    if (u * total <= remaining) {
      const progress = previousProgress + u * total;
      const distanceToJunction = Math.max(0, previousIndex.total - progress);
      const position = applyLaneOffset(
        samplePathIndex(previousIndex, progress),
        previousOffset * Math.min(1, distanceToJunction / laneTaperM),
      );
      return { ...position, heading: incomingHeading };
    }
    const position = applyLaneOffset(
      samplePathIndex(currentIndex, Math.min(currentIndex.total, u * total - remaining)),
      currentOffset * Math.min(1, Math.max(0, u * total - remaining) / laneTaperM),
    );
    return { ...position, heading: outgoingHeading };
  }

  // The corner: where the incoming tangent line meets the outgoing one. A right
  // angle puts it on the shared node, which is what rounds a city turn.
  const corner = cornerControlPoint(incoming, outgoing, incomingHeading, outgoingHeading);
  const x = quadratic(incoming.x, corner.x, outgoing.x, u);
  const y = quadratic(incoming.y, corner.y, outgoing.y, u);
  const dx = quadraticTangent(incoming.x, corner.x, outgoing.x, u);
  const dy = quadraticTangent(incoming.y, corner.y, outgoing.y, u);
  if (Math.hypot(dx, dy) < 1e-9) {
    return { x, y, heading: outgoingHeading };
  }
  return { x, y, heading: Math.atan2(dy, dx) };
}

/**
 * The control point of the rounded corner: where the incoming and outgoing
 * tangents cross, clamped so a shallow turn cannot fling the curve sideways.
 */
function cornerControlPoint(
  incoming: WorldPosition,
  outgoing: WorldPosition,
  incomingHeading: number,
  outgoingHeading: number,
): { x: number; y: number } {
  const inDir = { x: Math.cos(incomingHeading), y: Math.sin(incomingHeading) };
  const outDir = { x: Math.cos(outgoingHeading), y: Math.sin(outgoingHeading) };
  const cross = inDir.x * outDir.y - inDir.y * outDir.x;
  const reach = Math.hypot(outgoing.x - incoming.x, outgoing.y - incoming.y);
  if (Math.abs(cross) < 1e-6) {
    return { x: (incoming.x + outgoing.x) / 2, y: (incoming.y + outgoing.y) / 2 };
  }
  const dx = outgoing.x - incoming.x;
  const dy = outgoing.y - incoming.y;
  const along = Math.min(reach, Math.max(0, (dx * outDir.y - dy * outDir.x) / cross));
  return { x: incoming.x + inDir.x * along, y: incoming.y + inDir.y * along };
}

function quadratic(a: number, b: number, c: number, u: number): number {
  const inv = 1 - u;
  return inv * inv * a + 2 * inv * u * b + u * u * c;
}

/** Derivative of the quadratic at u: 2(1-u)(b-a) + 2u(c-b). */
function quadraticTangent(a: number, b: number, c: number, u: number): number {
  return 2 * (1 - u) * (b - a) + 2 * u * (c - b);
}

/** Below this a junction is a continuation, not a turn. */
const TURN_MIN_RADIANS = 0.15;

/**
 * The longest gap a single junction crossing can span. A city junction is tens of
 * metres at the very most; anything beyond this is a route change, which must not
 * be animated as a drive.
 */
const MAX_TRANSITION_M = 60;

/** Above this the car is crossing, not arriving: the stop line must not hold it. */

