import { describe, expect, it } from "vitest";
import { chicagoModel } from "./chicago-support";
import { buildPathIndex, type Point } from "@/cities/paths";
import {
  clamp01,
  frameAlpha,
  interpolateVehicles,
  positionForRoad,
} from "@/render/interpolate";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import type { PresentationSnapshot, PresentationVehicle } from "@/worker/presentation-snapshot";

const model = chicagoModel(2);
const indexes = buildDirectedPathIndexes(model);

/** A straight synthetic road for exact-math assertions. */
const straight: Point[] = [
  [0, 0],
  [100, 0],
];
const straightIndex = buildPathIndex(straight);

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
    controller: "adaptive",
    vehicles,
    signals: [],
    roadConditions: [],
    incidents: [],
  };
}

describe("interpolation helpers", () => {
  it("clamps alpha and survives nonsense timing", () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(frameAlpha(100, 0, 200)).toBe(0.5);
    expect(frameAlpha(0, 100, 200)).toBe(0);
    expect(frameAlpha(1_000, 0, 200)).toBe(1);
    expect(frameAlpha(50, 0, 0)).toBe(1);
  });

  it("samples world positions along presentation paths", () => {
    expect(positionForRoad([straightIndex], 0, 0)).toEqual({ x: 0, y: -3.2, heading: 0 });
    const mid = positionForRoad([straightIndex], 0, 50)!;
    expect(mid.x).toBeCloseTo(50, 9);
    // Lane offset moves the vehicle sideways (right of travel), never along the road.
    expect(mid.y).toBeCloseTo(-3.2, 9);
    expect(positionForRoad([straightIndex], null, 0)).toBeNull();
    expect(positionForRoad([null], 0, 0)).toBeNull();
  });

  it("interpolates along a road between two frames", () => {
    const previous = snapshot(0, 0, [vehicle({ id: 0, progress: 10 })]);
    const current = snapshot(1, 200, [vehicle({ id: 0, progress: 30 })]);
    const atStart = interpolateVehicles([straightIndex], previous, current, 0);
    expect(atStart[0].x).toBeCloseTo(10, 9);
    const middle = interpolateVehicles([straightIndex], previous, current, 0.5);
    expect(middle[0].x).toBeCloseTo(20, 9);
    const atEnd = interpolateVehicles([straightIndex], previous, current, 1);
    expect(atEnd[0].x).toBeCloseTo(30, 9);
  });

  it("interpolates across a road change through the junction", () => {
    // Road 1 runs (100,0) -> (200,0): a change at the shared node is linear.
    const second = buildPathIndex([
      [100, 0],
      [200, 0],
    ]);
    const previous = snapshot(0, 0, [vehicle({ id: 0, roadId: 0, progress: 90 })]);
    const current = snapshot(1, 200, [vehicle({ id: 0, roadId: 1, progress: 10 })]);
    const middle = interpolateVehicles([straightIndex, second], previous, current, 0.5);
    // 90 on road 0 and 110 on road 1 -> midpoint 100 (the junction).
    expect(middle[0].x).toBeCloseTo(100, 9);
  });

  it("renders newly spawned vehicles and omits departed ones", () => {
    const previous = snapshot(0, 0, [
      vehicle({ id: 0, progress: 50 }),
      vehicle({ id: 1, progress: 20 }),
    ]);
    const current = snapshot(1, 200, [
      vehicle({ id: 1, progress: 30 }),
      vehicle({ id: 2, progress: 40 }),
      vehicle({ id: 3, roadId: null }),
      vehicle({ id: 4, roadId: 99 }),
    ]);
    const rendered = interpolateVehicles([straightIndex], previous, current, 0.5);
    expect(rendered.map((entry) => entry.id)).toEqual([1, 2]);
    const spawned = rendered.find((entry) => entry.id === 2)!;
    expect(spawned.x).toBeCloseTo(40, 9);
  });

  it("never mutates the received snapshots", () => {
    const previous = snapshot(0, 0, [vehicle({ id: 0, progress: 10 })]);
    const current = snapshot(1, 200, [vehicle({ id: 0, progress: 30 })]);
    const beforePrevious = JSON.stringify(previous);
    const beforeCurrent = JSON.stringify(current);
    interpolateVehicles([straightIndex], previous, current, 0.5);
    expect(JSON.stringify(previous)).toBe(beforePrevious);
    expect(JSON.stringify(current)).toBe(beforeCurrent);
  });

  it("carries wait heat and headings into rendered vehicles", () => {
    const current = snapshot(1, 200, [
      vehicle({ id: 0, progress: 10, state: "queued", blockedWaitMs: 42_000 }),
    ]);
    const rendered = interpolateVehicles([straightIndex], null, current, 0.5);
    expect(rendered[0].blockedWaitMs).toBe(42_000);
    expect(rendered[0].headingRadians).toBeCloseTo(0, 9);
    expect(rendered[0].y).toBeCloseTo(-3.2, 9);
  });

  it("renders the whole showcase fleet without dropping vehicles", () => {
    const snapshotVehicles: PresentationVehicle[] = [];
    for (let roadId = 0; roadId < 40; roadId += 1) {
      snapshotVehicles.push(vehicle({ id: roadId, roadId, progress: model.city.roads[roadId].length / 2 }));
    }
    const current = snapshot(1, 200, snapshotVehicles);
    const rendered = interpolateVehicles(indexes, null, current, 0.5);
    expect(rendered.length).toBe(40);
    for (const entry of rendered) {
      expect(Number.isFinite(entry.x)).toBe(true);
      expect(Number.isFinite(entry.y)).toBe(true);
      expect(Number.isFinite(entry.headingRadians)).toBe(true);
    }
  });
});
