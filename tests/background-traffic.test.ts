/**
 * Background traffic: the map must show the city the simulation is running.
 *
 * The bug this file exists for: the frame carried only the followed car, so a
 * rush hour with thousands of vehicles in view rendered as an empty street grid
 * with a few amber stripes. These tests pin the replacement — sprites synthesised
 * from the simulation's own per-road counts — and, just as importantly, pin the
 * rules that keep it honest:
 *
 *   - the count comes from the simulation, never from a constant
 *   - every sprite sits ON its road, in a lane, nose along the tangent
 *   - a queue is packed behind the stop line, front first
 *   - the ego is not drawn twice
 *   - identical input → identical sprites, and motion is interpolated, not snapped
 *   - the real Chicago rush hour actually produces a populated map
 */
import { describe, expect, it } from "vitest";
import { chicagoModel } from "./chicago-support";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createEngine, runEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import { productionDemand } from "@/sim/demand-profile";
import { buildPresentationSnapshot, type PresentationSnapshot } from "@/worker/presentation-snapshot";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { buildDirectedPathIndexes, sampleDirectedRoad } from "@/render/map-geometry";
import { laneCentreOffsetMetres, carriagewayPairs, stopLineSetbackMetres } from "@/render/road-presentation";
import {
  MAX_SPRITES_PER_ROAD,
  renderBackgroundVehicles,
  synthesizeRoadTraffic,
  synthesizeRoadTrafficCached,
} from "@/render/background-traffic";
import type { CuratedTripId } from "@/cities/chicago-trips";

const model = chicagoModel(4);
const indexes = buildDirectedPathIndexes(model);
const laneOffsets = model.city.roads.map((road) =>
  laneCentreOffsetMetres(model, road.id, carriagewayPairs(model)),
);

/** A snapshot carrying exactly the road counts a test wants to see. */
function snapshotWith(
  rows: readonly { roadId: number; vehicleCount: number; queuedCount: number; speedFactor?: number }[],
  timeMs = 0,
): PresentationSnapshot {
  return {
    sequence: 0,
    timeMs,
    controller: "adaptive",
    governance: { modified: false, manualIncidents: 0 },
    policy: null,
    ego: null,
    roadTraffic: rows.map((row) => ({
      roadId: row.roadId,
      occupancy: row.vehicleCount * 10,
      capacity: 10,
      vehicleCount: row.vehicleCount,
      queuedCount: row.queuedCount,
      maxBlockedWaitMs: 0,
      speedFactor: row.speedFactor ?? 1,
      severity: "free" as const,
    })),
    routeControls: [],
    trip: null,
    roadConditions: [],
    incidents: [],
  } as unknown as PresentationSnapshot;
}

function someRoad(minLength = 200) {
  const road = model.city.roads.find((entry) => entry.length > minLength && entry.lanes >= 2);
  expect(road).toBeDefined();
  return road!;
}

describe("background traffic: the count is the simulation's", () => {
  it("draws exactly as many sprites as the frame reports vehicles", () => {
    const road = someRoad();
    for (const count of [1, 3, 7, 12]) {
      const sprites = synthesizeRoadTraffic(
        snapshotWith([{ roadId: road.id, vehicleCount: count, queuedCount: 0 }]),
        { city: model.city, laneOffsets, egoRoadId: null },
      );
      expect(sprites).toHaveLength(count);
    }
  });

  it("draws nothing for a road with no vehicles, and nothing at all for no frame", () => {
    const road = someRoad();
    expect(
      synthesizeRoadTraffic(snapshotWith([{ roadId: road.id, vehicleCount: 0, queuedCount: 0 }]), {
        city: model.city,
        laneOffsets,
        egoRoadId: null,
      }),
    ).toHaveLength(0);
    expect(
      synthesizeRoadTraffic(null, { city: model.city, laneOffsets, egoRoadId: null }),
    ).toHaveLength(0);
  });

  it("does not draw the followed car twice on its own road", () => {
    const road = someRoad();
    const frame = snapshotWith([{ roadId: road.id, vehicleCount: 6, queuedCount: 2 }]);
    const withEgoSubtracted = synthesizeRoadTraffic(frame, {
      city: model.city,
      laneOffsets,
      egoRoadId: road.id,
    });
    const withoutSubtraction = synthesizeRoadTraffic(frame, {
      city: model.city,
      laneOffsets,
      egoRoadId: null,
    });
    expect(withoutSubtraction).toHaveLength(6);
    expect(withEgoSubtracted).toHaveLength(5);
  });

  it("caps a single road rather than drawing an unbounded column", () => {
    const road = someRoad();
    const sprites = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 5_000, queuedCount: 0 }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    // Moving traffic is capped at its own slot space; a road can only reach
    // MAX_SPRITES_PER_ROAD when both queue and moving traffic are saturated.
    expect(sprites.length).toBeLessThanOrEqual(MAX_SPRITES_PER_ROAD);
    expect(sprites.length).toBe(24);
  });

  it("is deterministic: the same frame is always the same sprites", () => {
    const road = someRoad();
    const frame = snapshotWith([{ roadId: road.id, vehicleCount: 14, queuedCount: 5 }]);
    const first = synthesizeRoadTraffic(frame, { city: model.city, laneOffsets, egoRoadId: null });
    const second = synthesizeRoadTraffic(frame, { city: model.city, laneOffsets, egoRoadId: null });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("caches per frame but never serves a stale ego road", () => {
    const road = someRoad();
    const frame = snapshotWith([{ roadId: road.id, vehicleCount: 4, queuedCount: 0 }]);
    const a = synthesizeRoadTrafficCached(frame, {
      city: model.city,
      laneOffsets,
      egoRoadId: null,
    });
    const cachedAgain = synthesizeRoadTrafficCached(frame, {
      city: model.city,
      laneOffsets,
      egoRoadId: null,
    });
    expect(cachedAgain).toBe(a);
    const withEgo = synthesizeRoadTrafficCached(frame, {
      city: model.city,
      laneOffsets,
      egoRoadId: road.id,
    });
    expect(withEgo).not.toBe(a);
    expect(withEgo).toHaveLength(3);
  });
});

describe("background traffic: sprites obey the road, not the open map", () => {
  it("sits on its road's path in a lane, nose along the tangent", () => {
    const road = someRoad(300);
    const frame = snapshotWith([{ roadId: road.id, vehicleCount: 16, queuedCount: 6 }]);
    const sprites = synthesizeRoadTraffic(frame, { city: model.city, laneOffsets, egoRoadId: null });
    const rendered = renderBackgroundVehicles([], sprites, 1, { indexes });
    expect(rendered).toHaveLength(sprites.length);
    for (const sprite of rendered) {
      const source = sprites.find((entry) => entry.key === sprite.id)!;
      const onPath = sampleDirectedRoad(indexes, road.id, source.progress)!;
      // Distance from the road centreline is exactly the lane offset — never a
      // free-space position.
      const distance = Math.hypot(sprite.x - onPath.x, sprite.y - onPath.y);
      expect(Math.abs(distance - Math.abs(source.laneOffset))).toBeLessThan(0.05);
      // And the nose is the road tangent, the same rule the ego follows.
      const delta = Math.abs(
        ((sprite.headingRadians - onPath.heading + Math.PI) % (2 * Math.PI)) - Math.PI,
      );
      expect(delta).toBeLessThan(1e-6);
    }
  });

  it("keeps every sprite inside the road's own extent", () => {
    const road = someRoad(150);
    const sprites = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 40, queuedCount: 20 }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    for (const sprite of sprites) {
      expect(sprite.progress).toBeGreaterThanOrEqual(0);
      expect(sprite.progress).toBeLessThanOrEqual(road.length);
    }
  });

  it("packs a queue behind the stop line, front first, bumper to bumper", () => {
    const road = someRoad(400);
    const queued = 5;
    const sprites = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: queued, queuedCount: queued }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    const queue = sprites.filter((sprite) => sprite.queueRank >= 0).sort((a, b) => a.queueRank - b.queueRank);
    expect(queue).toHaveLength(queued);
    // Rank 0 is the front: closest to the stop line, which is the road's end.
    const stopLine = road.length - stopLineSetbackMetres(road.lanes);
    expect(queue[0].progress).toBeLessThanOrEqual(stopLine);
    expect(queue[0].progress).toBeGreaterThan(stopLine - 6);
    for (let index = 1; index < queue.length; index += 1) {
      const gap = queue[index - 1].progress - queue[index].progress;
      // A car plus the queue gap, never overlapping and never floating away.
      expect(gap).toBeGreaterThan(4);
      expect(gap).toBeLessThan(11);
    }
  });

  it("spreads moving traffic between the junctions, not onto the stop line", () => {
    const road = someRoad(400);
    const sprites = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 6, queuedCount: 0 }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    for (const sprite of sprites) {
      expect(sprite.queueRank).toBe(-1);
      expect(sprite.progress).toBeGreaterThan(0);
      expect(sprite.progress).toBeLessThan(road.length);
    }
    // Stable per-slot phases intentionally do not sort by slot number: changing
    // the road's count must not re-space every existing car. They only need to
    // occupy distinct valid positions on the road.
    const positions = sprites.map((sprite) => sprite.progress.toFixed(3));
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe("background traffic: aggregate sprites have stable forward motion", () => {
  it("does not relocate existing moving slots when the road count changes", () => {
    const road = someRoad(400);
    const four = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 4, queuedCount: 0 }], 12_000),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    const five = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 5, queuedCount: 0 }], 12_000),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    const fiveByKey = new Map(five.map((sprite) => [sprite.key, sprite]));
    for (const sprite of four) {
      const same = fiveByKey.get(sprite.key);
      expect(same).toBeDefined();
      expect(same!.progress).toBeCloseTo(sprite.progress, 9);
      expect(same!.laneOffset).toBeCloseTo(sprite.laneOffset, 9);
    }
  });

  it("actually moves when simulation time advances even if the count is unchanged", () => {
    const road = someRoad(400);
    const atZero = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 6, queuedCount: 0, speedFactor: 0.7 }], 0),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    const later = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 6, queuedCount: 0, speedFactor: 0.7 }], 1_000),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    const laterByKey = new Map(later.map((sprite) => [sprite.key, sprite]));
    const moved = atZero.filter((sprite) => {
      const next = laterByKey.get(sprite.key);
      return next !== undefined && Math.abs(next.progress - sprite.progress) > 0.1;
    });
    expect(moved.length).toBeGreaterThanOrEqual(4);
  });

  it("does not animate a wrapped moving slot backwards across the whole road", () => {
    const road = someRoad(400);
    const base = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 1, queuedCount: 0 }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    )[0];
    expect(base).toBeDefined();
    const previous = [{ ...base!, progress: road.length - 2 }];
    const current = [{ ...base!, progress: 2 }];
    const halfway = renderBackgroundVehicles(previous, current, 0.5, { indexes });
    const atEnd = renderBackgroundVehicles([], current, 1, { indexes });
    expect(halfway).toHaveLength(1);
    expect(atEnd).toHaveLength(1);
    expect(halfway[0].x).toBeCloseTo(atEnd[0].x, 9);
    expect(halfway[0].y).toBeCloseTo(atEnd[0].y, 9);
  });
});

describe("background traffic: motion is interpolated, never snapped", () => {
  it("walks a sprite from its old position to its new one across the frame", () => {
    const road = someRoad(400);
    const previous = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 4, queuedCount: 0 }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    // Same sprites, further along the road: the sim advanced one frame.
    const moved = previous.map((sprite) => ({ ...sprite, progress: sprite.progress + 25 }));
    const atStart = renderBackgroundVehicles(previous, moved, 0, { indexes });
    const atEnd = renderBackgroundVehicles(previous, moved, 1, { indexes });
    const halfway = renderBackgroundVehicles(previous, moved, 0.5, { indexes });
    for (let index = 0; index < previous.length; index += 1) {
      const start = Math.hypot(atStart[index].x - atEnd[index].x, atStart[index].y - atEnd[index].y);
      const half = Math.hypot(halfway[index].x - atEnd[index].x, halfway[index].y - atEnd[index].y);
      // Halfway is half of the way, not a jump: positions come from the path, so
      // this is measured along the road itself.
      expect(half).toBeLessThan(start * 0.75);
      expect(half).toBeGreaterThan(start * 0.25);
    }
  });

  it("drops a sprite that has left the road and adds one that appeared", () => {
    const road = someRoad(300);
    const previous = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 3, queuedCount: 0 }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    const current = synthesizeRoadTraffic(
      snapshotWith([{ roadId: road.id, vehicleCount: 5, queuedCount: 0 }]),
      { city: model.city, laneOffsets, egoRoadId: null },
    );
    const rendered = renderBackgroundVehicles(previous, current, 1, { indexes });
    expect(rendered).toHaveLength(5);
  });
});

describe("background traffic: the real rush hour looks populated", () => {
  it("draws thousands of vehicles in view, on real Chicago roads", () => {
    const challenge = materializeChallengeTrip(model, "soldier-field-to-navy-pier" as CuratedTripId, 42);
    const scenario = buildChallengeScenario({
      tripId: "soldier-field-to-navy-pier" as CuratedTripId,
      trafficLevel: "rush-hour",
      driver: "tourist",
      seed: 42,
      durationMs: 420_000,
    });
    const world = resolveScenarioWorld(model, challenge.trip, scenario);
    const spawns: ScheduledSpawn[] = [
      challenge.spawn,
      ...productionDemand({
        city: model.city,
        level: "rush-hour",
        seed: world.demandSeed,
        durationMs: 420_000,
      }),
    ];
    const engine: EngineState = createEngine({
      city: model.city,
      controller: createAdaptiveController(),
      spawns,
      driver: "tourist",
    });
    runEngine(engine, 300_000);
    const snapshot = buildPresentationSnapshot(engine, 0);
    const sprites = synthesizeRoadTraffic(snapshot, {
      city: model.city,
      laneOffsets,
      egoRoadId: snapshot.ego?.roadId ?? null,
    });
    // The frame's own numbers must add up: one sprite per vehicle on occupied
    // roads, minus the ego, up to the per-road cap that keeps one pathological
    // road from eating the frame budget.
    const expected =
      snapshot.roadTraffic.reduce((sum, road) => sum + road.vehicleCount, 0) -
      (snapshot.ego ? 1 : 0);
    expect(sprites.length).toBeLessThanOrEqual(expected);
    expect(sprites.length).toBeGreaterThan(expected * 0.95);
    expect(sprites.length).toBeGreaterThan(2_000);
    // And a real Chicago road must carry a real queue, not a token one.
    const busiest = [...snapshot.roadTraffic].sort((a, b) => b.vehicleCount - a.vehicleCount)[0];
    expect(busiest.vehicleCount).toBeGreaterThan(3);
    const rendered = renderBackgroundVehicles([], sprites, 1, { indexes });
    expect(rendered.every((vehicle) => Number.isFinite(vehicle.x) && Number.isFinite(vehicle.y))).toBe(
      true,
    );

    // This runs at display rate, so it has to be cheap. The bound is deliberately
    // loose (a regression that made it O(roads x vehicles), or re-sampled the
    // paths per sprite per frame, would blow through it by an order of magnitude).
    const startedAt = performance.now();
    for (let frame = 0; frame < 60; frame += 1) {
      renderBackgroundVehicles(sprites, sprites, frame / 60, { indexes });
    }
    const perFrameMs = (performance.now() - startedAt) / 60;
    expect(perFrameMs).toBeLessThan(25);
  }, 300_000);
});
