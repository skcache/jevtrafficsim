/**
 * Presentation motion: lane placement, path-aware turns, spawn fades and queue
 * packing. These are the physical claims the renderer makes, so they are tested
 * against hand-built geometry rather than a screenshot.
 */
import { describe, expect, it } from "vitest";
import {
  angleDelta,
  frameAlpha,
  interpolateVehicles,
  lerpAngle,
  positionForRoad,
} from "@/render/interpolate";
import { clampVehiclesAtSignals, packQueues } from "@/render/queue-packing";
import {
  LANE_WIDTH_M,
  QUEUE_GAP_M,
  STOP_LINE_CLEARANCE_M,
  VEHICLE_LENGTH_M,
  stopLineSetbackMetres,
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
    governance: { modified: false, manualIncidents: 0 },
    policy: null,
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

  it("rounds the junction: the nose follows the motion, the path stays in the box", () => {
    // Vehicle crosses intersection 1 from road 0 onto road 2 (a right turn).
    const previous = snapshot(0, [{ id: 7, roadId: 0, progress: 90 }]);
    const current = snapshot(100, [{ id: 7, roadId: 2, progress: 5 }]);
    // Remaining 10 m on road 0, then 5 m into road 2 = 15 m of path.
    //
    // The turn is one rounded corner through the shared node, so the sprite is
    // never rotated toward a road it is not yet on: at every sample the heading
    // IS the direction the car is moving. That is the property the old
    // road-locked-with-early-rotation version failed, and it is why the car
    // visibly crabbed through every turn.
    let last = interpolateVehicles(indexes, previous, current, 0, options(city, laneOffsets))[0];
    let worstBodyMotion = 0;
    for (let step = 1; step <= 20; step += 1) {
      const point = interpolateVehicles(indexes, previous, current, step / 20, options(city, laneOffsets))[0];
      const motion = Math.atan2(point.y - last.y, point.x - last.x);
      let delta = Math.abs(motion - point.headingRadians);
      delta = Math.min(delta, Math.abs(delta - Math.PI * 2));
      worstBodyMotion = Math.max(worstBodyMotion, (delta * 180) / Math.PI);
      // The corner is local AND the car is on its road. A car that is waiting
      // sits ON the painted stop line, which is up to (setback + body/2 +
      // clearance) upstream of the graph node the simulation parks it at -
      // measured 9.6 m on this fixture (issue #56). The box therefore allows the
      // stop-line residual before the junction, and nothing past the junction's
      // own extent.
      expect(Math.abs(point.x - 100)).toBeLessThanOrEqual(20);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(11);
      last = point;
    }
    // The chord between two samples differs from the curve's tangent by a few
    // degrees at 20 samples per crossing; the point is that it never approaches
    // the old sideways behaviour, which measured tens of degrees.
    expect(worstBodyMotion).toBeLessThan(8);
    // The turn is complete at the far side: the last sample is on the new road.
    const end = interpolateVehicles(indexes, previous, current, 1, options(city, laneOffsets))[0];
    expect(end.x).toBeCloseTo(100, 6);
    expect(end.y).toBeCloseTo(5, 6);
  });

  it("releases from the rendered stop line instead of jumping to the junction", () => {
    const previous = {
      ...snapshot(0, [{ id: 7, roadId: 0, progress: 99, speed: 0 }]),
      routeControls: [{ intersectionId: 1, phaseIndex: 0, stage: "all-red" as const }],
    };
    const current = snapshot(100, [{ id: 7, roadId: 2, progress: 2, speed: 4 }]);
    const halfway = interpolateVehicles(
      indexes,
      previous,
      current,
      0.5,
      options(city, laneOffsets),
    )[0];

    const stop =
      100 -
      stopLineSetbackMetres(city.roads[0].lanes) -
      VEHICLE_LENGTH_M.car / 2 -
      STOP_LINE_CLEARANCE_M;

    // The transition's distance calculation and its sampled starting progress
    // must use the same presentation-space stop-line position. Mixing the raw
    // 99 m simulation progress with a remaining distance measured from ~90 m
    // clamps the car to x=100 immediately, which looks like a launch/jump.
    // Halfway through the release the car is between the two: it has left the
    // line and it has not launched to the node.
    expect(halfway.x).toBeGreaterThan(stop);
    expect(halfway.x).toBeLessThan(100);
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
    // Within a centimetre of the stop line's own geometry: the approach warp
    // shifts progress, not the road, so the sample still lands where the road
    // says (issue #56).
    expect(mid.x).toBeCloseTo(45, 1);
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
    // The same invariant as the right turn: whatever the turn direction, the
    // nose is the tangent of the path being travelled, and the path stays inside
    // the junction while it rounds the corner.
    let last = interpolateVehicles(leftIndexes, previous, current, 0, options(leftCity, offsets))[0];
    let worstBodyMotion = 0;
    for (let step = 1; step <= 20; step += 1) {
      const point = interpolateVehicles(leftIndexes, previous, current, step / 20, options(leftCity, offsets))[0];
      const motion = Math.atan2(point.y - last.y, point.x - last.x);
      let delta = Math.abs(motion - point.headingRadians);
      delta = Math.min(delta, Math.abs(delta - Math.PI * 2));
      worstBodyMotion = Math.max(worstBodyMotion, (delta * 180) / Math.PI);
      expect(Math.abs(point.x - 100)).toBeLessThanOrEqual(20);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(11);
      last = point;
    }
    // The chord between two samples differs from the curve's tangent by a few
    // degrees at 20 samples per crossing; the point is that it never approaches
    // the old sideways behaviour, which measured tens of degrees.
    // The old sideways behaviour measured tens of degrees. A car pulling away
    // from a FULL STOP carries the stop-line residual through its corner, which
    // widens the chord slightly: measured 10.3 degrees on this fixture since
    // issue #56 - still a margin of ~9x against the 90-degree crab it guards.
    expect(worstBodyMotion).toBeLessThan(12);
    // Left turn: the car ends on road 3, which runs north.
    const end = interpolateVehicles(leftIndexes, previous, current, 1, options(leftCity, offsets))[0];
    expect(end.x).toBeCloseTo(100, 6);
    expect(end.y).toBeCloseTo(-4, 6);
    expect(Math.abs(end.headingRadians + Math.PI / 2)).toBeLessThan(0.01);
  });

  it("snaps on a reroute instead of gliding the car across the map", () => {
    // A reroute moves the ego to a different road with its progress reset. The
    // distance between the two is most of a block, and animating it drew the car
    // sliding sideways across the city (measured: 75 m in one interpolation
    // window). Presentation snaps instead: the car is simply where the
    // simulation now says it is.
    const previous = snapshot(0, [{ id: 7, roadId: 0, progress: 12 }]);
    const current = snapshot(100, [{ id: 7, roadId: 2, progress: 55 }]);
    const mid = interpolateVehicles(indexes, previous, current, 0.5, options(city, laneOffsets))[0];
    // Placed on the CURRENT road at its own projected position, not halfway
    // between two unrelated places.
    // On the CURRENT road, at the position the current road implies - not
    // halfway between two unrelated places, and not left behind on the old one.
    expect(mid.roadId).toBe(2);
    expect(Math.abs(mid.x - 100)).toBeLessThan(6);
    expect(Math.abs(mid.y - 55)).toBeLessThan(6);
  });

  it("interpolates across the real arrival gap instead of freezing on it", () => {
    // Frames are posted once per worker tick and a slow tick delivers late:
    // measured mean 109 ms, p95 178 ms, max 256 ms against a 100 ms nominal. The
    // alpha window must be the REAL gap. With the fixed 100 ms window alpha
    // pinned at 1 on every late frame, so the render clock reached the current
    // frame and stopped until the next one arrived - measured in the live app as
    // alpha pinned on 100% of sampled frames, i.e. the car froze and then jumped
    // once per tick. That is the jitter.
    const arrival = 1000;
    const gap = 256; // the measured worst case
    // With the real gap as the window, the clock is still moving right up to the
    // next arrival...
    for (const t of [gap * 0.25, gap * 0.5, gap * 0.9]) {
      expect(frameAlpha(arrival + t, arrival, gap)).toBeLessThan(1);
    }
    expect(frameAlpha(arrival + gap, arrival, gap)).toBeCloseTo(1, 6);
    // ...whereas the fixed nominal window saturates almost immediately and then
    // holds, which is the freeze.
    expect(frameAlpha(arrival + gap * 0.5, arrival, 100)).toBe(1);
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

describe("display phase", () => {
  it("is linear in wall time since the arrival, and reaches the newest frame at the cadence", () => {
    expect(frameAlpha(1000, 1000, 100)).toBe(0);
    expect(frameAlpha(1050, 1000, 100)).toBeCloseTo(0.5, 6);
    expect(frameAlpha(1100, 1000, 100)).toBe(1);
  });

  it("clamps in both directions", () => {
    // Nothing moves before the frame that carries the position arrived...
    expect(frameAlpha(990, 1000, 100)).toBe(0);
    // ...and the phase never runs past the newest snapshot.
    expect(frameAlpha(1400, 1000, 100)).toBe(1);
    expect(frameAlpha(1000, 1000, 0)).toBe(1);
  });

  it("never freezes the display for a whole window at 60 fps", () => {
    // The regression this pins (issue #46, measured on the rendered car): a
    // low-pass of the FRAME CLOCK lags a ramp by `rate x tau`, and the rate is
    // the playback compression — at 8x the clock sat ~560 simulated ms behind
    // an 800 ms window, so alpha was exactly 0 on 56% of display frames (the
    // car held the previous snapshot) and then jumped 7-9 m at each arrival.
    // The fix: the window follows the measured cadence, the phase inside it is
    // wall time divided by that cadence, and nothing smooths the phase.
    const cadenceMs = 100;
    const frameMs = 1000 / 60;
    // Measured arrival jitter at 8x playback (p5 83 / p50 100 / p95 133).
    const gaps = [83, 100, 133, 100, 116, 100, 100, 150, 100, 83];
    let nextArrival = 5000 + gaps[0];
    let gapIndex = 0;
    let windowStart = 5000;
    let zeroRun = 0;
    let windowZeroRunMax = 0;
    let windowMax = 0;
    let midWindow = 0;
    const windowMaxima: number[] = [];
    const windowBounds: number[] = [];
    const midWindowValues: number[] = [];
    for (let frame = 0; frame < 600; frame += 1) {
      const now = 5000 + frame * frameMs;
      if (now >= nextArrival) {
        windowMaxima.push(windowMax);
        windowBounds.push(
          Math.min(1, (nextArrival - windowStart - frameMs - 1) / cadenceMs),
        );
        midWindowValues.push(midWindow);
        windowZeroRunMax = Math.max(windowZeroRunMax, zeroRun);
        windowStart = nextArrival;
        gapIndex += 1;
        nextArrival = windowStart + gaps[gapIndex % gaps.length];
        windowMax = 0;
        midWindow = 0;
        zeroRun = 0;
      }
      const phase = frameAlpha(now, windowStart, cadenceMs);
      if (phase < 0.05) zeroRun += 1;
      else zeroRun = 0;
      windowMax = Math.max(windowMax, phase);
      if (now - windowStart >= cadenceMs / 2 && midWindow === 0) midWindow = phase;
    }
    // At most the single frame that lands exactly on the arrival may show zero.
    expect(windowZeroRunMax).toBeLessThanOrEqual(1);
    // The phase must reach what the arithmetic allows: the last display frame
    // before the next arrival sits one frame short of the window's end, so its
    // phase is (gap - one frame) / cadence at worst. A phase that lags — the old
    // smoothed clock peaked at 0.35 of the window — cannot satisfy this.
    for (let index = 0; index < windowMaxima.length; index += 1) {
      expect(windowMaxima[index]).toBeGreaterThanOrEqual(windowBounds[index] - 0.02);
    }
    // Halfway through a window the car is halfway between the snapshots.
    expect(Math.min(...midWindowValues)).toBeGreaterThan(0.4);
  });
});
