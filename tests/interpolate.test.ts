import { describe, expect, it } from "vitest";
import {
  clamp01,
  frameAlpha,
  interpolateVehicles,
  vehicleWorldPosition,
} from "@/render/interpolate";
import { buildRenderModel } from "@/render/model";
import type { PresentationSnapshot, PresentationVehicle } from "@/worker/presentation-snapshot";
import { makeStreet } from "./traffic-support";

function vehicle(overrides: Partial<PresentationVehicle> & { id: number }): PresentationVehicle {
  return {
    type: "car",
    state: "moving",
    roadId: 0,
    progress: 0,
    blockedWaitMs: 0,
    ...overrides,
  };
}

function snapshot(
  sequence: number,
  timeMs: number,
  vehicles: PresentationVehicle[],
): PresentationSnapshot {
  return {
    sequence,
    timeMs,
    controller: "fixed",
    vehicles,
    signals: [],
    roadConditions: [],
    incidents: [],
  };
}

describe("interpolation helpers", () => {
  it("clamps alpha to [0, 1] and survives nonsense input", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(frameAlpha(100, 0, 200)).toBe(0.5);
    expect(frameAlpha(0, 100, 200)).toBe(0); // clock skew never yields negative
    expect(frameAlpha(1_000, 0, 200)).toBe(1);
    expect(frameAlpha(50, 0, 0)).toBe(1);
  });

  it("derives world positions from the directed road geometry", () => {
    const { city } = makeStreet([{ length: 10 }]);
    const model = buildRenderModel(city);
    expect(vehicleWorldPosition(model, vehicle({ id: 0, progress: 0 }))).toEqual({ x: 0, y: 0 });
    expect(vehicleWorldPosition(model, vehicle({ id: 0, progress: 5 }))).toEqual({ x: 5, y: 0 });
    expect(vehicleWorldPosition(model, vehicle({ id: 0, progress: 10 }))).toEqual({ x: 10, y: 0 });
    // Clamped beyond the road, defensive on missing geometry.
    expect(vehicleWorldPosition(model, vehicle({ id: 0, progress: 99 }))).toEqual({ x: 10, y: 0 });
    expect(vehicleWorldPosition(model, vehicle({ id: 0, roadId: null }))).toBeNull();
    expect(vehicleWorldPosition(model, vehicle({ id: 0, roadId: 99 }))).toBeNull();
  });

  it("interpolates along a road between two frames", () => {
    // Road length 100 spans 10 world units (nodes at x=0 and x=10), so world
    // position = progress / 100 * 10.
    const { city } = makeStreet([{ length: 100 }]);
    const model = buildRenderModel(city);
    const previous = snapshot(0, 0, [vehicle({ id: 0, progress: 10 })]);
    const current = snapshot(1, 200, [vehicle({ id: 0, progress: 30 })]);
    const atStart = interpolateVehicles(model, previous, current, 0);
    expect(atStart[0].x).toBeCloseTo(1, 10);
    const middle = interpolateVehicles(model, previous, current, 0.5);
    expect(middle[0].x).toBeCloseTo(2, 10);
    const atEnd = interpolateVehicles(model, previous, current, 1);
    expect(atEnd[0].x).toBeCloseTo(3, 10);
  });

  it("interpolates linearly across a road change (no splines)", () => {
    // Roads are 100 long but 10 units apart: progress 90 on road 0 is x=9;
    // progress 30 on road 1 is x=10 + 3 = 13.
    const { city } = makeStreet([{ length: 100 }, { length: 100 }]);
    const model = buildRenderModel(city);
    const previous = snapshot(0, 0, [vehicle({ id: 0, roadId: 0, progress: 90 })]);
    const current = snapshot(1, 200, [vehicle({ id: 0, roadId: 1, progress: 30 })]);
    const middle = interpolateVehicles(model, previous, current, 0.5);
    expect(middle[0].x).toBeCloseTo(11, 10); // between 9 and 13
  });

  it("renders a newly spawned vehicle at its current position", () => {
    const { city } = makeStreet([{ length: 100 }]);
    const model = buildRenderModel(city);
    const previous = snapshot(0, 0, []);
    const current = snapshot(1, 200, [vehicle({ id: 7, progress: 40 })]);
    const rendered = interpolateVehicles(model, previous, current, 0.5);
    expect(rendered.length).toBe(1);
    expect(rendered[0].id).toBe(7);
    expect(rendered[0].x).toBeCloseTo(4, 10); // progress 40 of 100 over a 10-unit span
  });

  it("omits departed vehicles and skips unrenderable ones defensively", () => {
    const { city } = makeStreet([{ length: 100 }]);
    const model = buildRenderModel(city);
    const previous = snapshot(0, 0, [
      vehicle({ id: 0, progress: 50 }),
      vehicle({ id: 1, progress: 20 }),
    ]);
    const current = snapshot(1, 200, [
      vehicle({ id: 1, progress: 30 }),
      vehicle({ id: 2, roadId: null }), // pending: no position
      vehicle({ id: 3, roadId: 99 }), // invalid: skipped
    ]);
    const rendered = interpolateVehicles(model, previous, current, 0.5);
    expect(rendered.map((entry) => entry.id)).toEqual([1]);
  });

  it("never mutates the received snapshots", () => {
    const { city } = makeStreet([{ length: 100 }]);
    const model = buildRenderModel(city);
    const previous = snapshot(0, 0, [vehicle({ id: 0, progress: 10 })]);
    const current = snapshot(1, 200, [vehicle({ id: 0, progress: 30 })]);
    const previousBefore = JSON.stringify(previous);
    const currentBefore = JSON.stringify(current);
    interpolateVehicles(model, previous, current, 0.5);
    expect(JSON.stringify(previous)).toBe(previousBefore);
    expect(JSON.stringify(current)).toBe(currentBefore);
  });

  it("carries wait heat and stable lane signs into the frame", () => {
    const { city } = makeStreet([{ length: 100 }]);
    const model = buildRenderModel(city);
    const current = snapshot(1, 200, [
      vehicle({ id: 0, progress: 10, state: "queued", blockedWaitMs: 42_000 }),
    ]);
    const rendered = interpolateVehicles(model, null, current, 0.5);
    expect(rendered[0].blockedWaitMs).toBe(42_000);
    expect(rendered[0].laneSign).toBe(1);
    expect(rendered[0].headingRadians).toBeCloseTo(0, 10);
  });
});
