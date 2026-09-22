/**
 * Follow camera — Issue #25, hardened in the shipping pass.
 *
 * The camera follows the INTERPOLATED car at display rate, biases ahead along a
 * smoothed travel direction, and — the shipping-pass change — keeps its OWN
 * smoothed centre with a dead zone, so it feels heavier than the car instead of
 * reproducing every millimetre of the ego's motion. Direction smoothing alone
 * still let the car's own position bumps through to the screen.
 *
 * These tests pin the properties that were wrong in the field:
 *   - the camera moves LESS than the car over the same frames (it absorbs)
 *   - a dead zone means a crawling car produces a perfectly still view
 *   - the step is frame-rate independent (60 Hz and 30 Hz converge alike)
 *   - no oscillation once the car stops
 *   - a one-shot resume does not teleport
 */
import { describe, expect, it } from "vitest";
import {
  advanceFollow,
  createFollowState,
  disableFollow,
  enableFollow,
  smoothingAlpha,
} from "@/render/follow-camera";
import { FOLLOW_SCALE } from "@/render/scale";

const FRAME_MS = 1000 / 60;

/** The car as CityMap feeds it: position plus the rendered heading. */
function sample(point: [number, number], headingRadians = 0) {
  return { x: point[0], y: point[1], headingRadians };
}

/** Drive the state machine along a path, returning every camera target. */
function drive(
  path: readonly [number, number][],
  frameMs = FRAME_MS,
  state = createFollowState(),
): { targets: ([number, number] | null)[]; state: ReturnType<typeof createFollowState> } {
  let current = state;
  const targets: ([number, number] | null)[] = [];
  for (const point of path) {
    const advance = advanceFollow(current, sample(point), frameMs);
    current = advance.state;
    targets.push(advance.target as [number, number] | null);
  }
  return { targets, state: current };
}

/** A car driving +x for `count` frames at `metresPerFrame`. */
function straightPath(count: number, metresPerFrame: number): [number, number][] {
  return Array.from({ length: count }, (_unused, index) => [index * metresPerFrame, 0]);
}

function displacement(points: readonly ([number, number] | null)[]): number[] {
  const out: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (a === null || b === null) continue;
    out.push(Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return out;
}

describe("follow camera", () => {
  it("yields completely when following is off", () => {
    const following = advanceFollow(createFollowState(), sample([0, 0]), FRAME_MS);
    const off = disableFollow(following.state);
    expect(off.following).toBe(false);
    const advance = advanceFollow(off, sample([50, 50]), FRAME_MS);
    expect(advance.target).toBeNull();
    expect(advance.state.following).toBe(false);
  });

  it("resumes immediately on Recenter without teleporting", () => {
    const off = disableFollow(createFollowState());
    const resumed = enableFollow(off);
    expect(resumed.following).toBe(true);
    const advance = advanceFollow(resumed, sample([10, 20]), FRAME_MS);
    expect(advance.target).not.toBeNull();
    expect(advance.state.following).toBe(true);
  });

  it("leads the car along its direction of travel, by less than before", () => {
    // Long straight run so the smoothed bias has converged.
    const { targets } = drive(straightPath(120, 0.35));
    const last = targets[targets.length - 1]!;
    const carX = 119 * 0.35;
    expect(last[0]).toBeGreaterThan(carX); // still ahead of the car
    expect(last[0] - carX).toBeLessThanOrEqual(FOLLOW_SCALE.lookAheadM + 1);
    expect(last[1]).toBeCloseTo(0, 1);
  });

  it("absorbs high-frequency jitter instead of reproducing it", () => {
    // The field complaint: the view vibrated with every small change in the car's
    // own position. Same trajectory, one version carrying a 0.25 m per-frame
    // wobble — the camera must smooth that away while still following the trend.
    const jitter = (index: number): number => (index % 2 === 0 ? 0.25 : -0.25);
    const smoothPath = straightPath(240, 0.35);
    const jitteryPath = smoothPath.map(
      (point, index) => [point[0], point[1] + jitter(index)] as [number, number],
    );
    const jittery = drive(jitteryPath).targets;
    // Wobble = mean absolute second difference of the camera path. A camera that
    // copied the car would show the full 0.5 m swing here.
    const wobble = (points: readonly ([number, number] | null)[]): number => {
      const values = points.map((point) => point![1]);
      let total = 0;
      for (let index = 2; index < values.length; index += 1) {
        total += Math.abs(values[index] - 2 * values[index - 1] + values[index - 2]);
      }
      return total / (values.length - 2);
    };
    expect(wobble(jittery)).toBeLessThan(0.02);
    expect(wobble(drive(smoothPath).targets)).toBeLessThan(0.02);
    // ...while keeping pace: the camera lags the desired target by roughly
    // v * tau (a constant offset, not a growing deficit), and its speed over the
    // second half matches the car's.
    const targets = jittery;
    const carEnd = jitteryPath[jitteryPath.length - 1][0];
    const cameraEnd = targets[targets.length - 1]![0];
    expect(carEnd - cameraEnd).toBeLessThan(25);
    const half = Math.floor(targets.length / 2);
    const cameraSpeed = (targets[targets.length - 1]![0] - targets[half]![0]) / (targets.length - half);
    expect(cameraSpeed).toBeGreaterThan(0.9 * 0.35);
  });

  it("does not move at all for sub-dead-zone changes", () => {
    const path: [number, number][] = [
      [0, 0],
      [0.5, 0],
      [1.0, 0],
      [1.4, 0],
    ];
    const { targets } = drive(path);
    const steps = displacement(targets);
    // Every step is inside the dead zone: the view must be perfectly still.
    expect(Math.max(...steps)).toBeLessThan(1e-9);
  });

  it("crosses the dead-zone boundary without a stick-slip jump", () => {
    let state = createFollowState();
    state = advanceFollow(state, sample([0, 0]), FRAME_MS).state;
    const justInside = advanceFollow(
      state,
      sample([FOLLOW_SCALE.deadZoneM - 0.01, 0]),
      FRAME_MS,
    );
    const justOutside = advanceFollow(
      justInside.state,
      sample([FOLLOW_SCALE.deadZoneM + 0.01, 0]),
      FRAME_MS,
    );
    const before = justInside.target!;
    const after = justOutside.target!;
    // Crossing the threshold by two centimetres should produce a tiny continuous
    // correction, not suddenly smooth the whole ~2.5 m accumulated error.
    expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeLessThan(0.005);
  });

  it("does not oscillate when the car is stopped", () => {
    const path: [number, number][] = Array.from({ length: 60 }, () => [12, 7] as [number, number]);
    const { targets } = drive(path);
    const steps = displacement(targets);
    expect(Math.max(...steps)).toBeLessThan(1e-9);
  });

  it("is frame-rate independent", () => {
    // Same physical trajectory at 60 Hz and at 30 Hz must land in the same place.
    const fast = drive(straightPath(120, 0.35), 1000 / 60);
    const slow = drive(straightPath(60, 0.7), 1000 / 30);
    const fastLast = fast.targets[fast.targets.length - 1]!;
    const slowLast = slow.targets[slow.targets.length - 1]!;
    expect(Math.abs(fastLast[0] - slowLast[0])).toBeLessThan(2.5);
  });

  it("smooths the alpha frame-rate independently", () => {
    // Two 16 ms steps and one 32 ms step reach the same place.
    const once = smoothingAlpha(32, FOLLOW_SCALE.centreHalfLifeMs);
    const twice = 1 - (1 - smoothingAlpha(16, FOLLOW_SCALE.centreHalfLifeMs)) ** 2;
    expect(twice).toBeCloseTo(once, 6);
  });

  it("turns without snapping: a right-angle turn never reverses the camera", () => {
    const path: [number, number][] = [
      ...Array.from({ length: 60 }, (_unused, index) => [index * 0.4, 0] as [number, number]),
      ...Array.from({ length: 60 }, (_unused, index) => [24, index * 0.4] as [number, number]),
    ];
    const { targets } = drive(path);
    const steps = displacement(targets);
    // Monotone progress: no step is large enough to be a jump, and the camera
    // never doubles back on itself.
    expect(Math.max(...steps)).toBeLessThan(6);
    for (let index = 1; index < targets.length; index += 1) {
      const previous = targets[index - 1]!;
      const current = targets[index]!;
      // A genuine reversal would be metres; easing the lead through the corner
      // costs a few millimetres of pull-back, which is not motion the eye sees.
      expect(current[0]).toBeGreaterThanOrEqual(previous[0] - 0.5);
      expect(current[1]).toBeGreaterThanOrEqual(previous[1] - 0.5);
    }
  });
});
