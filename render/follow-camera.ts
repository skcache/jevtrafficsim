/**
 * Follow camera (Issue #25) — pure state, no MapLibre in here.
 *
 * The rule set, in words:
 *
 * - While following, the camera centre sits a fixed distance AHEAD of the car
 *   along its direction of travel, so the user sees the road they are about to
 *   drive rather than the road behind.
 * - The direction is exponentially smoothed with a half-life, because a raw
 *   per-frame velocity swings wildly through junctions and would make the
 *   camera wobble (the "no camera oscillation" requirement).
 * - The caller feeds the INTERPOLATED on-screen position, never the raw worker
 *   snapshot: the camera must not step at 5 Hz while the car moves at 60.
 * - Manual pan disables following (disableFollow). Manual zoom does NOT:
 *   zooming is how the user inspects the route, and the camera keeps tracking.
 * - Recenter resumes immediately. Nothing here fights an intentional gesture:
 *   once following is off, `advance` returns no target at all.
 */
import { FOLLOW_SCALE as FOLLOW } from "./scale";

export interface FollowState {
  readonly following: boolean;
  /** Smoothed unit direction of travel in local map space. */
  readonly direction: readonly [number, number] | null;
  readonly lastPosition: readonly [number, number] | null;
}

export function createFollowState(following = true): FollowState {
  return { following, direction: null, lastPosition: null };
}

export function disableFollow(state: FollowState): FollowState {
  if (!state.following) {
    return state;
  }
  return { ...state, following: false };
}

export function enableFollow(state: FollowState): FollowState {
  if (state.following) {
    return state;
  }
  return { ...state, following: true };
}

/** Blend two unit directions, keeping the result unit-length. Returns b when a is missing. */
function blendDirection(
  a: readonly [number, number] | null,
  b: readonly [number, number],
  alpha: number,
): [number, number] {
  if (!a) {
    return [b[0], b[1]];
  }
  const x = a[0] + (b[0] - a[0]) * alpha;
  const y = a[1] + (b[1] - a[1]) * alpha;
  const length = Math.hypot(x, y);
  if (length < 1e-6) {
    return [b[0], b[1]];
  }
  return [x / length, y / length];
}

export interface FollowAdvance {
  readonly state: FollowState;
  /** Camera centre in local map metres, or null when not following. */
  readonly target: readonly [number, number] | null;
}

export interface FollowEgoSample {
  readonly x: number;
  readonly y: number;
  /**
   * Direction of travel in the same metric frame (atan2(dy, dx)). Used to seed
   * the smoothed direction on the very first frame and whenever the car is too
   * slow to measure — without it the camera would apply the full look-ahead
   * only once a velocity sample existed, i.e. jump 85 m on frame two.
   */
  readonly headingRadians?: number;
}

/**
 * One display frame. `ego` is the interpolated car (null before it exists),
 * `dtMs` the frame delta.
 */
export function advanceFollow(
  state: FollowState,
  ego: FollowEgoSample | null,
  dtMs: number,
): FollowAdvance {
  if (!state.following) {
    return { state, target: null };
  }
  if (!ego) {
    // Before the first spawn frame, hold wherever the camera already is.
    return { state, target: state.lastPosition };
  }
  let direction = state.direction;
  if (!direction && typeof ego.headingRadians === "number") {
    direction = [Math.cos(ego.headingRadians), Math.sin(ego.headingRadians)];
  }
  const last = state.lastPosition;
  if (last) {
    const dx = ego.x - last[0];
    const dy = ego.y - last[1];
    const speed = dtMs > 0 ? Math.hypot(dx, dy) / (dtMs / 1000) : 0;
    if (speed >= FOLLOW.minSpeedMps && Math.hypot(dx, dy) > 1e-6) {
      const alpha = dtMs > 0 ? 1 - Math.exp(-dtMs / FOLLOW.directionHalfLifeMs) : 1;
      direction = blendDirection(direction, [dx / Math.hypot(dx, dy), dy / Math.hypot(dx, dy)], alpha);
    }
  }
  const next: FollowState = {
    following: true,
    direction,
    lastPosition: [ego.x, ego.y],
  };
  const bias = direction ?? [0, 0];
  return {
    state: next,
    target: [ego.x + bias[0] * FOLLOW.lookAheadM, ego.y + bias[1] * FOLLOW.lookAheadM],
  };
}
