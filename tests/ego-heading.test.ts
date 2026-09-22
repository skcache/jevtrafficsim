/**
 * The ego car drives along its road — the launch blocker, pinned.
 *
 * The bug this file exists for: position was constrained to the authoritative
 * road path, but heading was a frame-wide lerp between the OLD and NEW road
 * headings. Mid-transition the sprite therefore pointed at the next road while
 * its position was still travelling down the current one, which reads as a car
 * crabbing sideways down a lane.
 *
 * The contract now:
 *   - outside the junction window, heading IS the local path tangent
 *   - inside it, the turn is distributed over a few metres (bounded per frame)
 *   - the angle between the body and its own motion never gets large outside the
 *     junction, in any direction of travel
 *   - real Chicago roads behave the same as synthetic ones
 */
import { describe, expect, it } from "vitest";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { interpolateVehicles } from "@/render/interpolate";
import { laneCentreOffsetMetres, carriagewayPairs } from "@/render/road-presentation";
import { samplePathIndex } from "@/cities/paths";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import { chicagoModel } from "./chicago-support";

const model = chicagoModel(4);
const offsets = model.city.roads.map((road) =>
  laneCentreOffsetMetres(model, road.id, carriagewayPairs(model)),
);
const indexes = buildDirectedPathIndexes(model);

function snapshot(roadId: number, progress: number): PresentationSnapshot {
  return {
    sequence: 0,
    timeMs: 0,
    controller: "fixed",
    governance: { modified: false, manualIncidents: 0 },
    policy: null,
    ego: {
      id: 1,
      type: "car",
      state: "moving",
      roadId,
      progress,
      routeIndex: 0,
      queueRank: null,
      blockedWaitMs: 0,
      speed: 0,
    },
    roadTraffic: [],
    routeControls: [],
    trip: null,
    roadConditions: [],
    incidents: [],
  } as unknown as PresentationSnapshot;
}

function options() {
  return { nowMs: 1000, receivedAtMs: 1000, laneOffsets: offsets, city: model.city };
}

/** Angle between the sprite's nose and the direction it actually moved. */
function bodyVsMotion(previous: { x: number; y: number }, point: { x: number; y: number; headingRadians: number }): number {
  const dx = point.x - previous.x;
  const dy = point.y - previous.y;
  const moved = Math.hypot(dx, dy);
  if (moved < 0.05) {
    return 0;
  }
  const motion = Math.atan2(dy, dx);
  let delta = Math.abs(((point.headingRadians - motion + Math.PI) % (2 * Math.PI)) - Math.PI);
  delta = Math.abs(delta);
  return (delta * 180) / Math.PI;
}

describe("ego heading follows the road it is actually on", () => {
  it("matches the sampled path tangent on a real Chicago road, in both directions", () => {
    const road = model.city.roads.find((entry) => entry.length > 400);
    expect(road).toBeDefined();
    if (road === undefined) return;

    for (const progress of [0, road.length * 0.25, road.length * 0.5, road.length * 0.9]) {
      const previous = snapshot(road.id, Math.max(0, progress - 40));
      const current = snapshot(road.id, progress);
      const point = interpolateVehicles(indexes, previous, current, 1, options())[0];
      const index = indexes[road.id];
      expect(index).toBeDefined();
      // The rendered nose must agree with the authoritative polyline tangent at
      // the rendered position.
      const expected = samplePathIndex(index!, progress).heading;
      const delta = Math.abs(
        ((point.headingRadians - expected + Math.PI) % (2 * Math.PI)) - Math.PI,
      );
      expect(delta).toBeLessThan(0.05);
    }
  });

  it("never crabs sideways while driving a straight stretch", () => {
    const road = model.city.roads.find((entry) => entry.length > 400);
    expect(road).toBeDefined();
    if (road === undefined) return;
    const previous = snapshot(road.id, 100);
    const current = snapshot(road.id, road.length - 100);
    let last = interpolateVehicles(indexes, previous, current, 0, options())[0];
    let worst = 0;
    for (let step = 1; step <= 60; step += 1) {
      const point = interpolateVehicles(indexes, previous, current, step / 60, options())[0];
      worst = Math.max(worst, bodyVsMotion(last, point));
      last = point;
    }
    // A car on a straight road points where it is going. Anything near 90 would
    // be the sideways artefact.
    expect(worst).toBeLessThan(25);
  });

  it("keeps a turn inside the junction window: bounded per frame, done by the node", () => {
    const pairs: Array<{ from: (typeof model.city.roads)[number]; to: (typeof model.city.roads)[number] }> = [];
    for (const road of model.city.roads.slice(0, 400)) {
      const next = model.city.roads.find((other) => other.from === road.to && other.id !== road.id);
      if (next !== undefined) {
        pairs.push({ from: road, to: next });
      }
      if (pairs.length >= 12) {
        break;
      }
    }
    expect(pairs.length).toBeGreaterThan(4);
    for (const pair of pairs) {
      const previous = snapshot(pair.from.id, Math.max(0, pair.from.length - 40));
      const current = snapshot(pair.to.id, Math.min(40, pair.to.length));
      let last = interpolateVehicles(indexes, previous, current, 0, options())[0];
      let maxTurnDeg = 0;
      for (let step = 1; step <= 80; step += 1) {
        const point = interpolateVehicles(indexes, previous, current, step / 80, options())[0];
        let delta = Math.abs(point.headingRadians - last.headingRadians);
        delta = Math.min(delta, Math.abs(delta - Math.PI * 2));
        maxTurnDeg = Math.max(maxTurnDeg, (delta * 180) / Math.PI);
        last = point;
      }
      // The window is a few metres wide, so even a right angle is spread over
      // many frames rather than snapping in one.
      expect(maxTurnDeg).toBeLessThan(45);
    }
  });
});
