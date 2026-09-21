/**
 * Presentation motion: lane placement, path-aware turns, spawn fades and queue
 * packing. These are the physical claims the renderer makes, so they are tested
 * against hand-built geometry rather than a screenshot.
 */
import { describe, expect, it } from "vitest";
import {
  angleDelta,
  interpolateVehicles,
  lerpAngle,
  positionForRoad,
  smoothRenderClock,
} from "@/render/interpolate";
import { clampVehiclesAtSignals, packQueues } from "@/render/queue-packing";
import {
  LANE_WIDTH_M,
  QUEUE_GAP_M,
  STOP_LINE_CLEARANCE_M,
  VEHICLE_LENGTH_M,
  stopLineSetbackMetres,
  vehicleLaneOffsetMetres,
} from "@/render/road-presentation";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import type { MapModel } from "@/cities/map-model";
import type { City, Road } from "@/sim/types";
import type { PresentationSnapshot, PresentationEgoVehicle } from "@/worker/presentation-snapshot";

/** Two-lane eastbound road: straight, 100 m, from intersection 0 to 1. */
function straightModel(): MapModel {
  const roads: Road[] = [
    { id: 0, from: 0, to: 1, length: 100, lanes: 2, speedLimit: 14, capacity: 20, kind: "arterial", closed: false },
    { id: 1, from: 1, to: 2, length: 100, lanes: 2, speedLimit: 14, capacity: 20, kind: "arterial", closed: false },
    // A right turn at intersection 1, heading south.
    { id: 2, from: 1, to: 3, length: 60, lanes: 1, speedLimit: 8, capacity: 12, kind: "local", closed: false },
  ];
  const city: City = {
    size: "medium",
    seed: 0,
    gridWidth: 0,
    gridHeight: 0,
    corridors: [],
    intersections: [
      { id: 0, x: 0, y: 0, incoming: [], outgoing: [0], control: "uncontrolled", regionId: 0 },
      { id: 1, x: 100, y: 0, incoming: [0], outgoing: [1, 2], control: "signal", regionId: 0 },
      { id: 2, x: 200, y: 0, incoming: [1], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 3, x: 100, y: 60, incoming: [2], outgoing: [], control: "uncontrolled", regionId: 0 },
    ],
    roads,
  };
  return {
    scaleIndex: 2,
    size: "medium",
    city,
    streets: [],
    directedPaths: [
      [
        [0, 0],
        [100, 0],
      ],
      [
        [100, 0],
        [200, 0],
      ],
      [
        [100, 0],
        [100, 60],
      ],
    ],
    buildings: [],
    water: [],
    parks: [],
    waterCrossingBridges: [],
    districts: [],
    landmarks: [],
    labels: [],
    bounds: { minX: 0, minY: 0, maxX: 200, maxY: 60 },
    centralCamera: { minX: 0, minY: 0, maxX: 200, maxY: 60 },
    cityCamera: { minX: 0, minY: 0, maxX: 200, maxY: 60 },
    projection: {
      originLon: -87.6375,
      originLat: 41.881,
      metresPerDegreeLon: 83004.9,
      metresPerDegreeLat: 111071,
    },
    stats: { intersections: 4, roads: 3, streets: 3, buildings: 0 },
  } as unknown as MapModel;
}

/**
 * Issue #24 frames carry ONE vehicle. Tests that used to build small fleets
 * now build the ego frame: `vehicles` keeps the familiar call shape, and the
 * first entry becomes the ego.
 */
function snapshot(
  timeMs: number,
  vehicles: Array<Partial<PresentationEgoVehicle> & { id: number; roadId: number | null; progress: number }>,
): PresentationSnapshot {
  const [first] = vehicles;
  return {
    sequence: timeMs,
    timeMs,
    controller: "fixed",
    // Defaults first; the caller's own fields (id, roadId, progress, overrides)
    // land last so nothing is silently overwritten.
    ego: first
      ? {
          type: "car" as const,
          state: "moving" as const,
          blockedWaitMs: 0,
          routeIndex: 0,
          queueRank: null,
          speed: 0,
          ...first,
        }
      : null,
    roadTraffic: [],
    routeControls: [],
    trip: null,
    roadConditions: [],
    incidents: [],
  };
}

const options = (city: City, laneOffsets: number[], nowMs = 1000, receivedAtMs = 1000) => ({
  nowMs,
  receivedAtMs,
  laneOffsets,
  city,
});

describe("ego-only rendering", () => {
  it("renders exactly one vehicle when the frame has an ego, none when it does not", () => {
    const model = straightModel();
    const indexes = buildDirectedPathIndexes(model);
    const withEgo = snapshot(0, [{ id: 3, roadId: 0, progress: 10 }]);
    const withoutEgo = snapshot(0, []);
    const options = { nowMs: 1000, receivedAtMs: 1000, laneOffsets: [0, 0], city: model.city };
    expect(interpolateVehicles(indexes, null, withEgo, 0.5, options).length).toBe(1);
    expect(interpolateVehicles(indexes, null, withoutEgo, 0.5, options).length).toBe(0);
    expect(interpolateVehicles(indexes, null, withEgo, 0.5, options)[0].id).toBe(3);
  });
});

describe("lane placement", () => {
  it("puts a two-lane one-way vehicle at its lane-group centre, not a fixed offset", () => {
    const model = straightModel();
    const indexes = buildDirectedPathIndexes(model);
    const offset = (2 * LANE_WIDTH_M) / 2; // 2 lanes -> group centre 3.4 m right
    const position = positionForRoad(indexes, 0, 0, offset)!;
    expect(position.x).toBeCloseTo(0, 6);
    // Metric frame: +y is north, so the right of an eastbound heading is -y.
    expect(position.y).toBeCloseTo(-offset, 6);
    expect(Math.abs(position.y)).not.toBeCloseTo(3.2, 3);
  });

  it("keeps a one-way carriageway on its own centreline", () => {
    const model = straightModel();
    const indexes = buildDirectedPathIndexes(model);
    const position = positionForRoad(indexes, 0, 50, 0)!;
    expect(position.y).toBeCloseTo(0, 6);
    expect(position.x).toBeCloseTo(50, 6);
  });
});

describe("turn interpolation", () => {
  const city = straightModel().city;
  const indexes = buildDirectedPathIndexes(straightModel());
  const laneOffsets = [0, 0, 0];

  it("walks through the junction instead of cutting the corner", () => {
    // Vehicle crosses intersection 1 from road 0 onto road 2 (a right turn).
    const previous = snapshot(0, [{ id: 7, roadId: 0, progress: 90 }]);
    const current = snapshot(100, [{ id: 7, roadId: 2, progress: 5 }]);
    // Remaining 10 m on road 0, then 5 m into road 2 = 15 m of path.
    const beforeJunction = interpolateVehicles(
      indexes,
      previous,
      current,
      0.5,
      options(city, laneOffsets),
    )[0];
    // t=0.5 -> 7.5 m travelled. Position stays exactly on the old road.
    expect(beforeJunction.x).toBeCloseTo(97.5, 6);
    // Lane offset tapers into the shared junction node, so the path stays
    // continuous. The side of the carriageway comes from the authoritative lane
    // assignment for this vehicle, not a hardcoded sign.
    const laneOffset = vehicleLaneOffsetMetres(city, laneOffsets, 7, 0);
    expect(beforeJunction.y).toBeCloseTo(-laneOffset * (2.5 / 8), 6);
    // t=0.8 -> 12 m travelled: 2 m past the junction, now on road 2.
    const pastJunction = interpolateVehicles(
      indexes,
      previous,
      current,
      0.8,
      options(city, laneOffsets),
    )[0];
    // Once the junction is crossed, position stays exactly on the new road.
    expect(pastJunction.x).toBeCloseTo(100, 6);
    expect(pastJunction.y).toBeCloseTo(2, 6);
  });

  it("rotates the heading the short way around", () => {
    expect(angleDelta(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2, 6);
    expect(angleDelta(Math.PI / 2, 0)).toBeCloseTo(-Math.PI / 2, 6);
    // Wraparound: from just under +pi to just over -pi is a small step.
    const delta = angleDelta(Math.PI - 0.1, -Math.PI + 0.1);
    expect(Math.abs(delta)).toBeCloseTo(0.2, 6);
    expect(lerpAngle(Math.PI - 0.1, -Math.PI + 0.1, 0.5)).toBeCloseTo(Math.PI, 6);
  });

  it("interpolates within one road without jumping", () => {
    const previous = snapshot(0, [{ id: 1, roadId: 0, progress: 20 }]);
    const current = snapshot(100, [{ id: 1, roadId: 0, progress: 30 }]);
    const mid = interpolateVehicles(indexes, previous, current, 0.5, options(city, laneOffsets))[0];
    expect(mid.x).toBeCloseTo(25, 6);
    expect(mid.y).toBeCloseTo(-1.7, 6);
  });

  it("stays on a curved road between snapshots instead of cutting the chord", () => {
    const base = straightModel();
    const elbow = {
      ...base,
      directedPaths: [
        [[0, 0], [50, 0], [50, 50]],
        ...base.directedPaths.slice(1),
      ],
    } as unknown as MapModel;
    const elbowIndexes = buildDirectedPathIndexes(elbow);
    const previous = snapshot(0, [{ id: 1, roadId: 0, progress: 20 }]);
    const current = snapshot(100, [{ id: 1, roadId: 0, progress: 70 }]);
    const mid = interpolateVehicles(
      elbowIndexes,
      previous,
      current,
      0.5,
      options(elbow.city, laneOffsets),
    )[0];
    // Scalar progress=45 stays on the incoming leg. A screen-space chord would
    // cut diagonally through the block.
    expect(mid.x).toBeCloseTo(45, 6);
    expect(mid.y).toBeCloseTo(-1.7, 6);
  });

  it("handles a left turn as well as a right turn", () => {
    // A left turn off intersection 1 (heading north), mirroring the right turn
    // onto road 2 (heading south). One model, so the renderer and the road
    // lookup agree about road 3.
    const base = straightModel();
    const leftCity: City = {
      ...base.city,
      roads: [
        ...base.city.roads,
        { id: 3, from: 1, to: 4, length: 60, lanes: 1, speedLimit: 8, capacity: 12, kind: "local", closed: false },
      ],
      intersections: [
        ...base.city.intersections,
        { id: 4, x: 100, y: -60, incoming: [3], outgoing: [], control: "uncontrolled", regionId: 0 },
      ],
    };
    const leftModel = {
      ...base,
      city: leftCity,
      directedPaths: [
        ...base.directedPaths,
        [
          [100, 0],
          [100, -60],
        ],
      ],
    } as unknown as MapModel;
    const leftIndexes = buildDirectedPathIndexes(leftModel);
    const previous = snapshot(0, [{ id: 11, roadId: 0, progress: 92 }]);
    const current = snapshot(100, [{ id: 11, roadId: 3, progress: 4 }]);
    const offsets = [0, 0, 0, 0];
    const mid = interpolateVehicles(leftIndexes, previous, current, 0.6, options(leftCity, offsets))[0];
    // 8 m remaining, 4 m on the new road: at t=0.6 the vehicle remains
    // exactly on the incoming road.
    expect(mid.x).toBeCloseTo(99.2, 6);
    expect(mid.y).toBeCloseTo(-0.17, 6);
    const after = interpolateVehicles(leftIndexes, previous, current, 0.9, options(leftCity, offsets))[0];
    // t=0.9 -> 10.8 m: 2.8 m onto the outgoing road, still road-locked.
    expect(after.x).toBeCloseTo(100, 6);
    expect(after.y).toBeCloseTo(-2.8, 6);
  });

  it("falls back to the current position when the roads are not joined", () => {
    // Road 2 -> road 0 is not a legal successor pair.
    const previous = snapshot(0, [{ id: 9, roadId: 2, progress: 10 }]);
    const current = snapshot(100, [{ id: 9, roadId: 0, progress: 10 }]);
    const mid = interpolateVehicles(indexes, previous, current, 0.5, options(city, laneOffsets))[0];
    expect(Number.isFinite(mid.x)).toBe(true);
    expect(Number.isFinite(mid.y)).toBe(true);
    expect(mid.x).toBeCloseTo(10, 6);
  });

  it("does not mutate its inputs", () => {
    const previous = snapshot(0, [{ id: 3, roadId: 0, progress: 90 }]);
    const current = snapshot(100, [{ id: 3, roadId: 2, progress: 5 }]);
    const before = JSON.stringify({ previous, current });
    interpolateVehicles(indexes, previous, current, 0.4, options(city, laneOffsets));
    expect(JSON.stringify({ previous, current })).toBe(before);
  });
});

describe("spawn fade", () => {
  const city = straightModel().city;
  const indexes = buildDirectedPathIndexes(straightModel());

  it("fades a newly appeared vehicle in from zero", () => {
    const previous = snapshot(0, []);
    const current = snapshot(100, [{ id: 5, roadId: 0, progress: 10 }]);
    const fresh = interpolateVehicles(indexes, previous, current, 1, options(city, [0, 0, 0], 100, 100))[0];
    expect(fresh.fade).toBe(0);
    const later = interpolateVehicles(indexes, previous, current, 1, options(city, [0, 0, 0], 300, 100))[0];
    expect(later.fade).toBe(1);
  });

  it("keeps an existing vehicle fully opaque", () => {
    const previous = snapshot(0, [{ id: 5, roadId: 0, progress: 5 }]);
    const current = snapshot(100, [{ id: 5, roadId: 0, progress: 10 }]);
    const vehicle = interpolateVehicles(indexes, previous, current, 1, options(city, [0, 0, 0]))[0];
    expect(vehicle.fade).toBe(1);
  });
});

describe("physical stop-line clamping", () => {
  const model = straightModel();
  const city = model.city;
  const indexes = buildDirectedPathIndexes(model);
  const laneOffsets = [0, 0, 0];

  it("never lets a red-light vehicle render inside the intersection", () => {
    const rendered = [{
      id: 1,
      roadId: 0,
      type: "car",
      state: "moving",
      x: 99,
      y: 0,
      headingRadians: 0,
      blockedWaitMs: 0,
      fade: 1,
      queueRank: -1,
    }] as never;
    const progress = new Map([[1, 99]]);

    const stopped = clampVehiclesAtSignals(
      city,
      indexes,
      laneOffsets,
      rendered,
      (id) => progress.get(id) ?? 0,
      [{ intersectionId: 1, phaseIndex: 0, stage: "all-red" }],
    );
    const expected =
      100 -
      stopLineSetbackMetres(city.roads[0].lanes) -
      VEHICLE_LENGTH_M.car / 2 -
      STOP_LINE_CLEARANCE_M;
    expect(stopped[0].x).toBeCloseTo(expected, 6);
    expect(stopped[0].x).toBeLessThan(100 - stopLineSetbackMetres(city.roads[0].lanes));

    const yellow = clampVehiclesAtSignals(
      city,
      indexes,
      laneOffsets,
      rendered,
      (id) => progress.get(id) ?? 0,
      [{ intersectionId: 1, phaseIndex: 0, stage: "yellow" }],
    );
    expect(yellow[0].x).toBeCloseTo(expected, 6);

    const green = clampVehiclesAtSignals(
      city,
      indexes,
      laneOffsets,
      rendered,
      (id) => progress.get(id) ?? 0,
      [{ intersectionId: 1, phaseIndex: 0, stage: "green" }],
    );
    expect(green[0].x).toBe(99);
  });
});

describe("queue packing", () => {
  const model = straightModel();
  const city = model.city;
  const indexes = buildDirectedPathIndexes(model);
  const laneOffsets = [0, 0, 0];



  it("packs a mixed queue into stable physical lanes without overlap", () => {
    const rendered = [
      { id: 1, roadId: 0, type: "car", state: "queued", x: 0, y: 0, headingRadians: 0, blockedWaitMs: 0, fade: 1, queueRank: 0 },
      { id: 2, roadId: 0, type: "truck", state: "queued", x: 0, y: 0, headingRadians: 0, blockedWaitMs: 0, fade: 1, queueRank: 1 },
      { id: 3, roadId: 0, type: "bicycle", state: "queued", x: 0, y: 0, headingRadians: 0, blockedWaitMs: 0, fade: 1, queueRank: 2 },
    ] as never;
    const progress = new Map([
      [1, 95],
      [2, 95],
      [3, 95],
    ]);
    const packed = packQueues(city, indexes, laneOffsets, rendered, (id) => progress.get(id) ?? 0);
    const byId = new Map(packed.map((vehicle) => [vehicle.id, vehicle]));
    const car = byId.get(1)!;
    const truck = byId.get(2)!;
    const bike = byId.get(3)!;

    const expectedCarFront =
      100 -
      stopLineSetbackMetres(city.roads[0].lanes) -
      VEHICLE_LENGTH_M.car / 2 -
      STOP_LINE_CLEARANCE_M;
    expect(car.x).toBeCloseTo(expectedCarFront, 6);

    // Stable id slots put ids 1 and 3 in one lane and id 2 in the other.
    expect(car.y).toBeCloseTo(bike.y, 6);
    expect(truck.y).not.toBeCloseTo(car.y, 6);

    // Only vehicles sharing a lane pack bumper-to-bumper.
    const carToBike =
      VEHICLE_LENGTH_M.car / 2 + QUEUE_GAP_M + VEHICLE_LENGTH_M.bicycle / 2;
    expect(Math.abs(car.x - bike.x)).toBeCloseTo(carToBike, 6);
  });

  it("is deterministic for identical state", () => {
    const make = () =>
      [
        { id: 1, roadId: 0, type: "car", state: "queued", x: 0, y: 0, headingRadians: 0, blockedWaitMs: 900, fade: 1, queueRank: 0 },
        { id: 2, roadId: 0, type: "car", state: "queued", x: 0, y: 0, headingRadians: 0, blockedWaitMs: 900, fade: 1, queueRank: 1 },
      ] as never;
    const progress = new Map([
      [1, 50],
      [2, 40],
    ]);
    const a = packQueues(city, indexes, laneOffsets, make(), (id) => progress.get(id) ?? 0);
    const b = packQueues(city, indexes, laneOffsets, make(), (id) => progress.get(id) ?? 0);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("keeps a queue on the road when it is longer than the road", () => {
    const queue = Array.from({ length: 20 }, (_, index) => ({
      id: index + 1,
      roadId: 0,
      type: "truck" as const,
      state: "queued" as const,
      x: 0,
      y: 0,
      headingRadians: 0,
      blockedWaitMs: 1000,
      fade: 1,
      // Twenty ranks, front first: the queue is longer than the road.
      queueRank: index,
    })) as never;
    const progress = new Map<number, number>(
      Array.from({ length: 20 }, (_, index) => [index + 1, 95] as [number, number]),
    );
    const packed = packQueues(city, indexes, laneOffsets, queue, (id) => progress.get(id) ?? 0);
    for (const vehicle of packed) {
      expect(vehicle.x).toBeGreaterThanOrEqual(0);
      expect(vehicle.x).toBeLessThanOrEqual(100);
    }
    const ys = new Set(packed.map((vehicle) => vehicle.y.toFixed(3)));
    const positions = new Set(
      packed.map((vehicle) => `${vehicle.x.toFixed(3)}:${vehicle.y.toFixed(3)}`),
    );
    expect(ys.size).toBe(2);
    expect(positions.size).toBe(packed.length);
  });

  it("leaves moving vehicles alone", () => {
    const moving = [
      { id: 1, roadId: 0, type: "car", state: "moving", x: 12, y: 3, headingRadians: 0, blockedWaitMs: 0, fade: 1, queueRank: -1 },
    ] as never;
    const packed = packQueues(city, indexes, laneOffsets, moving, () => 40);
    expect(packed[0].x).toBe(12);
    expect(packed[0].queueRank).toBe(-1);
  });
});

describe("smoothed render clock", () => {
  it("eases toward the frame clock instead of snapping to it", () => {
    // The point is to absorb arrival jitter, not to teleport to the target:
    // a 16 ms step must move only part of the way.
    const after16ms = smoothRenderClock(0, 800, 16, 800);
    expect(after16ms).toBeGreaterThan(0);
    expect(after16ms).toBeLessThan(400);
    const after100ms = smoothRenderClock(0, 800, 100, 800);
    expect(after100ms).toBeGreaterThan(after16ms);
    expect(after100ms).toBeLessThan(800);
  });

  it("converges on a steady target", () => {
    let clock = 0;
    for (let i = 0; i < 60; i += 1) {
      clock = smoothRenderClock(clock, 800, 16, 800);
    }
    // ~1.2 s of real time at tau = 70 ms: within a millisecond of the target,
    // and strictly behind it (the clock eases, it never leads the sim).
    expect(clock).toBeGreaterThan(799);
    expect(clock).toBeLessThan(800);
  });

  it("snaps across a discontinuity rather than sweeping through the city", () => {
    // A reset or scale change moves the frame clock further than one interval:
    // easing there would draw the car across the whole map.
    expect(smoothRenderClock(0, 60_000, 16, 800)).toBe(60_000);
    expect(smoothRenderClock(Number.NaN, 1234, 16, 800)).toBe(1234);
  });
});
