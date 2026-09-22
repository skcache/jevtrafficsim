/**
 * Follow camera (Issue #25, hardened in the shipping pass).
 *
 * The rule set, in words:
 *
 * - While following, the camera centre sits a fixed distance AHEAD of the car
 *   along its direction of travel, so the user sees the road they are about to
 *   drive rather than the road behind.
 * - Direction is exponentially smoothed with a half-life, because raw per-frame
 *   velocity swings wildly through junctions and would make the camera wobble.
 * - The CAMERA CENTRE has its own state and its own (slower) smoothing. This is
 *   the part that makes the camera feel heavier than the car: the ego position
 *   stays authoritative and road-bound, while the camera approaches the desired
 *   target exponentially instead of being welded to it. Direction smoothing
 *   alone still left every bump in the car's own position visible on screen.
 * - A dead zone means tiny target changes do not move the camera at all: a car
 *   creeping in a queue, or a worker frame arriving a millisecond late, must not
 *   produce visible motion. That is also what keeps the view still while stopped.
 * - Look-ahead is smoothed SEPARATELY from the centre, with its own half-life, so
 *   a heading change eases the framing without dragging the whole camera.
 * - Everything is frame-rate independent: each step uses 1 - exp(-dt / tau), so a
 *   16 ms frame and a 33 ms frame converge identically.
 * - The caller feeds the INTERPOLATED on-screen position, never the raw worker
 *   snapshot. Manual pan disables following; manual zoom does not.
 */
import { FOLLOW_SCALE as FOLLOW } from "./scale";

export interface FollowState {
  readonly following: boolean;
  /** Smoothed unit direction of travel in local map space. */
  readonly direction: readonly [number, number] | null;
  readonly lastPosition: readonly [number, number] | null;
  /** The camera's own smoothed centre, in the same metric frame. */
  readonly centre: readonly [number, number] | null;
  /** Smoothed look-ahead vector: separate state, separate half-life. */
  readonly bias: readonly [number, number];
}

export function createFollowState(following = true): FollowState {
  return { following, direction: null, lastPosition: null, centre: null, bias: [0, 0] };
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
  // Re-acquiring follow must not teleport: drop the smoothed centre so the next
  // frame seeds it at the current target and the one-shot ease owns the move.
  return { ...state, following: true, centre: null };
}

/** Frame-rate independent exponential approach: the fraction to move this step. */
export function smoothingAlpha(dtMs: number, halfLifeMs: number): number {
  if (!Number.isFinite(dtMs) || dtMs <= 0 || halfLifeMs <= 0) {
    return 1;
  }
  return 1 - Math.exp((-Math.LN2 * dtMs) / halfLifeMs);
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
   * only once a velocity sample existed, i.e. jump on frame two.
   */
  readonly headingRadians?: number;
}

/**
 * One display frame. `ego` is the interpolated car (null before it exists),
 * `dtMs` the frame delta. Pure: the same trajectory and the same deltas always
 * produce the same camera path, which is what the tests pin.
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
    return { state, target: state.centre };
  }

  // --- direction of travel -------------------------------------------------
  let direction = state.direction;
  if (!direction && typeof ego.headingRadians === "number") {
    direction = [Math.cos(ego.headingRadians), Math.sin(ego.headingRadians)];
  }
  const last = state.lastPosition;
  if (last) {
    const dx = ego.x - last[0];
    const dy = ego.y - last[1];
    const distance = Math.hypot(dx, dy);
    const speed = dtMs > 0 ? distance / (dtMs / 1000) : 0;
    if (speed >= FOLLOW.minSpeedMps && distance > 1e-6) {
      direction = blendDirection(
        direction,
        [dx / distance, dy / distance],
        smoothingAlpha(dtMs, FOLLOW.directionHalfLifeMs),
      );
    }
  }

  // --- look-ahead, smoothed on its own slower clock ------------------------
  const unit = direction ?? [0, 0];
  const desiredBias: [number, number] = [unit[0] * FOLLOW.lookAheadM, unit[1] * FOLLOW.lookAheadM];
  const seeded = state.centre === null;
  const biasAlpha = smoothingAlpha(dtMs, FOLLOW.lookAheadHalfLifeMs);
  // First frame: start AT the lead instead of ramping into it. A ramp drags the
  // camera forward for a second, which defeats the dead zone and makes even a
  // stationary car look like it is drifting.
  const bias: [number, number] = seeded
    ? [desiredBias[0], desiredBias[1]]
    : [
        state.bias[0] + (desiredBias[0] - state.bias[0]) * biasAlpha,
        state.bias[1] + (desiredBias[1] - state.bias[1]) * biasAlpha,
      ];

  // --- camera centre, heavier than the car ---------------------------------
  const desired: [number, number] = [ego.x + bias[0], ego.y + bias[1]];
  const centre = state.centre;
  let nextCentre: [number, number];
  if (centre === null) {
    nextCentre = desired; // first frame: no glide from nowhere
  } else {
    const offsetX = desired[0] - centre[0];
    const offsetY = desired[1] - centre[1];
    const distance = Math.hypot(offsetX, offsetY);
    if (distance <= FOLLOW.deadZoneM) {
      // Inside the dead zone the camera does not move at all: this is what makes
      // a stopped or crawling car produce a perfectly still view.
      nextCentre = [centre[0], centre[1]];
    } else {
      // Soft dead zone: smooth only the error OUTSIDE the dead-zone radius.
      //
      // The old branch smoothed the full offset as soon as it crossed the
      // threshold. That creates a stick-slip discontinuity: the camera is frozen
      // at 2.49 m of error, then suddenly gets a full 2.51 m correction one frame
      // later. It is numerically small but visually obvious when the entire map
      // is moving under one followed car. Removing the radius before smoothing
      // makes the velocity continuous at the boundary.
      const movable = distance - FOLLOW.deadZoneM;
      const scale = movable / distance;
      const alpha = smoothingAlpha(dtMs, FOLLOW.centreHalfLifeMs);
      nextCentre = [
        centre[0] + offsetX * scale * alpha,
        centre[1] + offsetY * scale * alpha,
      ];
    }
  }

  return {
    state: {
      following: true,
      direction,
      lastPosition: [ego.x, ego.y],
      centre: nextCentre,
      bias,
    },
    target: nextCentre,
  };
}
