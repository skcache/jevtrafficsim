import { describe, expect, it } from "vitest";
import { chicagoModel } from "./chicago-support";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createEngine, runEngine } from "@/sim/engine";
import { productionDemand } from "@/sim/demand-profile";
import { buildPresentationSnapshot, type PresentationSnapshot } from "@/worker/presentation-snapshot";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { laneCentreOffsetMetres, carriagewayPairs } from "@/render/road-presentation";
import {
  createBackgroundTrafficTracker, renderBackgroundVehicles,
  KEY_STRIDE, MAX_SPRITES_PER_ROAD, SPRITE_SPACING_M, type SyntheticVehicle,
} from "@/render/background-traffic";

const model = chicagoModel(4); // frozen production Metro geography
const indexes = buildDirectedPathIndexes(model);
const laneOffsets = model.city.roads.map((road) =>
  laneCentreOffsetMetres(model, road.id, carriagewayPairs(model)));
const options = { city: model.city, laneOffsets, egoRoadId: null };
const longRoad = model.city.roads.find((road) => road.length > 400 && road.lanes >= 2)!;

function snapshot(roadId: number, count: number, queued: number, speed: number, timeMs: number): PresentationSnapshot {
  return {
    sequence: timeMs, timeMs, controller: "adaptive",
    governance: { modified: false, manualIncidents: 0 }, policy: null, ego: null,
    roadTraffic: [{
      roadId, occupancy: count * 10, capacity: 100, vehicleCount: count,
      queuedCount: queued, maxBlockedWaitMs: 0, speedFactor: speed,
      severity: "free",
    }],
    routeControls: [], trip: null, roadConditions: [], incidents: [],
  } as unknown as PresentationSnapshot;
}

function samePositions(before: readonly SyntheticVehicle[], after: readonly SyntheticVehicle[]): void {
  const byKey = new Map(after.map((sprite) => [sprite.key, sprite]));
  for (const sprite of before) {
    const next = byKey.get(sprite.key);
    if (next) {
      expect(next.progress, `key ${sprite.key} moved`).toBeCloseTo(sprite.progress, 8);
      expect(next.laneOffset).toBe(sprite.laneOffset);
    }
  }
}

describe("aggregate background presentation continuity", () => {
  it.each([[1, 0.8], [0.8, 0.2], [0.2, 1], [0.5, 0.51]])(
    "never retroactively rewrites positions on speed %s -> %s", (beforeSpeed, afterSpeed) => {
      const tracker = createBackgroundTrafficTracker();
      tracker.update(snapshot(longRoad.id, 6, 0, beforeSpeed, 1_000), options);
      const before = tracker.update(snapshot(longRoad.id, 6, 0, beforeSpeed, 2_000), options).current;
      const after = tracker.update(snapshot(longRoad.id, 6, 0, afterSpeed, 2_000), options).current;
      samePositions(before, after);
      const later = tracker.update(snapshot(longRoad.id, 6, 0, afterSpeed, 2_100), options).current;
      expect(later.some((sprite, index) => sprite.progress > after[index].progress)).toBe(true);
    },
  );

  it.each([1, 2, 8])("queue growth to %s does not respread moving survivors", (queued) => {
    const tracker = createBackgroundTrafficTracker();
    const before = tracker.update(snapshot(longRoad.id, 12, queued === 1 ? 0 : queued - 1, 0.6, 1_000), options).current;
    const after = tracker.update(snapshot(longRoad.id, 12, queued, 0.6, 1_000), options).current;
    samePositions(before, after);
    expect(new Set(after.map((sprite) => sprite.key)).size).toBe(after.length);
  });

  it.each([3, 0])("queue release to %s preserves keys and does not drive backwards", (queued) => {
    const tracker = createBackgroundTrafficTracker();
    const before = tracker.update(snapshot(longRoad.id, 8, 4, 0.4, 1_000), options).current;
    const after = tracker.update(snapshot(longRoad.id, 8, queued, 0.4, 1_000), options).current;
    samePositions(before, after);
    const rendered = renderBackgroundVehicles(before, after, 0.5, { indexes });
    expect(rendered).toHaveLength(8);
    expect(after.some((sprite, index) => sprite.queueRank !== before[index].queueRank)).toBe(true);
  });

  it("births and deaths keep survivor positions and fade only changed slots", () => {
    const tracker = createBackgroundTrafficTracker();
    const three = tracker.update(snapshot(longRoad.id, 3, 0, 0.4, 1_000), options).current;
    const growth = tracker.update(snapshot(longRoad.id, 5, 0, 0.4, 1_000), options);
    samePositions(three, growth.current);
    const birthFrame = renderBackgroundVehicles(growth.previous, growth.current, 0.5, { indexes });
    expect(birthFrame.filter((vehicle) => vehicle.fade === 0.5)).toHaveLength(2);
    const shrink = tracker.update(snapshot(longRoad.id, 2, 0, 0.4, 1_000), options);
    samePositions(shrink.previous.slice(0, 2), shrink.current);
    const deathFrame = renderBackgroundVehicles(shrink.previous, shrink.current, 0.5, { indexes });
    expect(deathFrame.filter((vehicle) => vehicle.fade === 0.5)).toHaveLength(3);
  });

  it("moving/queued transitions keep identities on road and out of stop-line stacks", () => {
    const tracker = createBackgroundTrafficTracker();
    const moving = tracker.update(snapshot(longRoad.id, 6, 0, 0.5, 1_000), options).current;
    const queued = tracker.update(snapshot(longRoad.id, 6, 2, 0.5, 1_000), options).current;
    samePositions(moving, queued);
    expect(queued.filter((sprite) => sprite.queueRank >= 0)).toHaveLength(2);
    const released = tracker.update(snapshot(longRoad.id, 6, 0, 0.5, 1_000), options).current;
    samePositions(queued, released);
    expect(released.every((sprite) => sprite.queueRank < 0)).toBe(true);
    expect(new Set(queued.map((sprite) => sprite.progress.toFixed(3))).size).toBe(queued.length);
  });

  it("shortened-span wrap crossfades at its two ends, never interpolates backwards", () => {
    const tracker = createBackgroundTrafficTracker();
    tracker.update(snapshot(longRoad.id, 4, 1, 1, 0), options);
    let pair = tracker.update(snapshot(longRoad.id, 4, 1, 1, 10_000), options);
    for (let time = 20_000; !pair.current.some((sprite) => sprite.wrapped) && time <= 120_000; time += 10_000) {
      pair = tracker.update(snapshot(longRoad.id, 4, 1, 1, time), options);
    }
    const wrapped = pair.current.find((sprite) => sprite.wrapped);
    expect(wrapped).toBeDefined();
    const halfway = renderBackgroundVehicles(pair.previous, pair.current, 0.5, { indexes });
    const ends = halfway.filter((vehicle) => vehicle.id === wrapped!.key || vehicle.id === wrapped!.key + 1_000_000_000);
    expect(ends).toHaveLength(2);
    expect(ends.every((vehicle) => vehicle.fade === 0.5)).toBe(true);
  });

  it("holds a moving sprite when a one-lane queue leaves no usable segment", () => {
    // Frozen Metro road 273 is 35.41 m long. With two queued cars, the one
    // survivor starts exactly one display spacing behind the queue tail.
    const road = model.city.roads[273];
    expect(road.lanes).toBe(1);
    const tracker = createBackgroundTrafficTracker();
    const initial = tracker.update(snapshot(road.id, 3, 0, 1, 0), options).current;
    const queued = tracker.update(snapshot(road.id, 3, 2, 1, 1_000), options).current;
    const held = tracker.update(snapshot(road.id, 3, 2, 1, 2_000), options).current;
    const moving = initial.find((sprite) => sprite.key === road.id * KEY_STRIDE)!;
    const survivor = queued.find((sprite) => sprite.key === moving.key)!;
    const next = held.find((sprite) => sprite.key === moving.key)!;
    const queueTail = Math.min(...held.filter((sprite) => sprite.queueRank >= 0).map((sprite) => sprite.progress));
    expect(survivor.progress).toBe(moving.progress);
    expect(next.progress).toBe(moving.progress);
    expect(survivor.wrapped).toBe(false);
    expect(next.wrapped).toBe(false);
    expect(queueTail - next.progress).toBeGreaterThanOrEqual(SPRITE_SPACING_M);
  });

  it("caps physical density on real sub-metre and 4-5m Chicago roads", () => {
    const examples = [
      model.city.roads.find((road) => road.length > 0 && road.length < 1),
      model.city.roads.find((road) => road.length >= 4 && road.length <= 5),
    ];
    expect(examples.every(Boolean)).toBe(true);
    for (const road of examples) {
      const sprites = createBackgroundTrafficTracker().update(snapshot(road!.id, 20, 0, 1, 1_000), options).current;
      expect(sprites.length).toBeLessThanOrEqual(1);
    }
  });

  it("excludes ego, resets on scenario restart, and is deterministic for ordered sequences", () => {
    const frames = [snapshot(longRoad.id, 5, 0, 1, 0), snapshot(longRoad.id, 5, 2, 0.5, 1_000)];
    const run = () => {
      const tracker = createBackgroundTrafficTracker();
      const values = frames.map((frame) => tracker.update(frame, { ...options, egoRoadId: longRoad.id }).current);
      expect(values[0]).toHaveLength(4);
      expect(tracker.trackedRoads).toBe(1);
      tracker.reset();
      expect(tracker.trackedRoads).toBe(0);
      return values;
    };
    expect(JSON.stringify(run())).toBe(JSON.stringify(run()));
  });
});

describe("dense production geography", () => {
  it("keeps a real Metro rush-hour snapshot finite, on-road and bounded", () => {
    const engine = createEngine({
      city: model.city, controller: createAdaptiveController(),
      spawns: productionDemand({ city: model.city, level: "rush-hour", seed: 42, durationMs: 300_000 }),
    });
    runEngine(engine, 300_000);
    const frame = buildPresentationSnapshot(engine, 0);
    const sprites = createBackgroundTrafficTracker().update(frame, options).current;
    expect(sprites.length).toBeGreaterThan(500);
    expect(sprites.length).toBeLessThanOrEqual(frame.roadTraffic.length * MAX_SPRITES_PER_ROAD);
    const perRoad = new Map<number, SyntheticVehicle[]>();
    for (const sprite of sprites) {
      expect(Number.isFinite(sprite.progress)).toBe(true);
      expect(sprite.progress).toBeGreaterThanOrEqual(0);
      expect(sprite.progress).toBeLessThanOrEqual(model.city.roads[sprite.roadId].length);
      perRoad.set(sprite.roadId, [...(perRoad.get(sprite.roadId) ?? []), sprite]);
    }
    for (const road of perRoad.values()) {
      const positions = road.map((sprite) => sprite.progress.toFixed(3));
      expect(new Set(positions).size).toBe(positions.length);
    }
    const rendered = renderBackgroundVehicles([], sprites, 1, { indexes });
    expect(rendered.every((sprite) => Number.isFinite(sprite.x) && Number.isFinite(sprite.y))).toBe(true);
    expect(SPRITE_SPACING_M).toBeGreaterThan(0);
  }, 300_000);
});
