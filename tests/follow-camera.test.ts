/**
 * Issue #25 — follow camera.
 *
 * The camera follows the INTERPOLATED car at display rate, biases ahead along
 * a smoothed travel direction (so turns cannot wobble it), yields to a manual
 * pan, and resumes immediately on Recenter.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  advanceFollow,
  createFollowState,
  disableFollow,
  enableFollow,
} from "@/render/follow-camera";
import { FOLLOW_SCALE } from "@/render/scale";

const FRAME_MS = 1000 / 60;

/** Drive the state machine along a path, returning the last advance. */
function drive(state = createFollowState(), path: [number, number][] = []) {
  let current = state;
  let last = advanceFollow(current, null, FRAME_MS);
  current = last.state;
  for (const point of path) {
    last = advanceFollow(current, sample(point), FRAME_MS);
    current = last.state;
  }
  return last;
}

/** The car as CityMap feeds it: position plus the rendered heading. */
function sample(point: [number, number], headingRadians = 0) {
  return { x: point[0], y: point[1], headingRadians };
}

describe("follow camera", () => {
  it("biases the target ahead of the car along its direction of travel", () => {
    const state = createFollowState();
    // Two samples moving +x: the direction is established, the target leads.
    const first = advanceFollow(state, sample([0, 0]), FRAME_MS);
    const second = advanceFollow(first.state, sample([1, 0]), FRAME_MS);
    expect(second.target).not.toBeNull();
    expect(second.target![0]).toBeGreaterThan(1);
    expect(second.target![0]).toBeCloseTo(1 + FOLLOW_SCALE.lookAheadM, 3);
    expect(second.target![1]).toBeCloseTo(0, 3);
  });

  it("yields completely when following is off", () => {
    const following = advanceFollow(createFollowState(), sample([0, 0]), FRAME_MS);
    const off = disableFollow(following.state);
    expect(off.following).toBe(false);
    const advance = advanceFollow(off, sample([50, 50]), FRAME_MS);
    expect(advance.target).toBeNull();
    expect(advance.state.following).toBe(false);
  });

  it("resumes immediately on Recenter", () => {
    const off = disableFollow(createFollowState());
    const resumed = enableFollow(off);
    expect(resumed.following).toBe(true);
    const advance = advanceFollow(resumed, sample([10, 20]), FRAME_MS);
    expect(advance.target).not.toBeNull();
    expect(advance.state.following).toBe(true);
  });

  it("keeps the last centre before the car exists", () => {
    const seen = drive(createFollowState(), [
      [0, 0],
      [5, 0],
    ]);
    const before = advanceFollow(seen.state, null, FRAME_MS);
    expect(before.target).toEqual(seen.state.lastPosition);
  });

  it("smooths the direction so a turn cannot swing the camera", () => {
    // Straight east for a while, then a hard 90-degree turn north.
    const path: [number, number][] = [];
    for (let step = 0; step < 40; step += 1) {
      path.push([step * 1.5, 0]);
    }
    for (let step = 1; step <= 40; step += 1) {
      path.push([40 * 1.5, step * 1.5]);
    }
    let state = createFollowState();
    let previousTarget: [number, number] | null = null;
    let maxJump = 0;
    // Headings as the interpolated renderer produces them: east, then north.
    const headingFor = (point: [number, number]): number => (point[1] === 0 ? 0 : Math.PI / 2);
    for (const point of path) {
      const advance = advanceFollow(state, sample(point, headingFor(point)), FRAME_MS);
      state = advance.state;
      if (previousTarget && advance.target) {
        maxJump = Math.max(
          maxJump,
          Math.hypot(advance.target[0] - previousTarget[0], advance.target[1] - previousTarget[1]),
        );
      }
      previousTarget = advance.target ? [advance.target[0], advance.target[1]] : null;
    }
    // The car moves 1.5 m per frame; a raw (unsmoothed) direction would add a
    // one-frame swing of ~2 * lookAhead at the corner. The smoothed camera
    // must stay within a few car-lengths per frame.
    expect(maxJump).toBeLessThan(12);
  });

  it("does not oscillate when the car is stopped", () => {
    const state = drive(createFollowState(), [
      [0, 0],
      [4, 0],
    ]);
    // Parked: repeated identical samples must not move the target at all.
    let current = state.state;
    const settled = advanceFollow(current, sample([4, 0]), FRAME_MS);
    const target = settled.target!;
    for (let step = 0; step < 30; step += 1) {
      const next = advanceFollow(current, sample([4, 0]), FRAME_MS);
      current = next.state;
      expect(next.target![0]).toBeCloseTo(target[0], 6);
      expect(next.target![1]).toBeCloseTo(target[1], 6);
    }
  });

  it("is fed the interpolated on-screen car, never the raw snapshot", () => {
    const source = readFileSync(new URL("../components/CityMap.tsx", import.meta.url), "utf8");
    // The follow advance consumes the rendered (interpolated) position…
    expect(source).toMatch(/advanceFollow\(followRef\.current, lastEgoMetricRef\.current/);
    expect(source).toMatch(
      /lastEgoMetricRef\.current = egoRendered[\s\S]{0,160}?headingRadians: egoRendered\.headingRadians/,
    );
    // …and the rendered car comes out of the interpolation, not the snapshot.
    expect(source).toMatch(/const egoRendered = settled\[0\] \?\? null/);
    // A manual pan is the only gesture that takes the camera, detected from the
    // raw pointer stream (and MapLibre's own dragstart) — never from zoom.
    expect(source).toMatch(/map\.on\("dragstart", onUserDrag\)/);
    expect(source).toMatch(/canvasContainer\.addEventListener\("pointermove", onPointerMove\)/);
    expect(source).toContain("if (Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) < 5)");
    expect(source).not.toMatch(/map\.on\("zoom"[\s\S]{0,80}?onUserDrag/);
    expect(source).toContain("setFollowing(false)");
    expect(source).toContain("setFollowing(true)");
  });
});
