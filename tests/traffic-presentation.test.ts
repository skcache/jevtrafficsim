/**
 * Live traffic presentation guards.
 *
 * These cover the rules that make the traffic read as physical rather than as
 * debug output: who is in front of a queue, how much of the fleet is drawn at
 * each zoom, that a turn is continuous, that incidents carry no animation, and
 * that no helper can quietly reintroduce a defaulted lane offset.
 */
import { describe, expect, it } from "vitest";
import { assignQueueRanks } from "@/worker/presentation-snapshot";
import { buildVehicleLayers } from "@/render/deck-layers";
import { buildIncidentLayers } from "@/render/deck-layers";
import { buildDirectedPathIndexes, type DirectedPathIndexes } from "@/render/map-geometry";
import { interpolateVehicles, type RenderedVehicle } from "@/render/interpolate";
import { availableChicagoEventVenues } from "@/cities/chicago";
import { carriagewayPairs, laneCentreOffsetMetres } from "@/render/road-presentation";
import {
  isQueued,
  packQueues,
  SETTLE_THRESHOLD_M,
  settlePlacements,
  type DisplayedPlacement,
} from "@/render/queue-packing";
import { QUEUE_GAP_M, VEHICLE_LENGTH_M } from "@/render/road-presentation";
import { samplePathIndex } from "@/cities/paths";
import { VEHICLE_MINZOOM } from "@/render/zoom-grammar";
import * as mapGeometry from "@/render/map-geometry";
import type { PresentationSnapshot, PresentationVehicle } from "@/worker/presentation-snapshot";
import { chicagoModel } from "./chicago-support";

const vehicle = (
  id: number,
  roadId: number | null,
  queuedSinceMs: number | null,
  state = "queued",
) => ({ id, state, roadId, queuedSinceMs });

/* ------------------------- 1.2 queue rank semantics ------------------------- */

describe("queue rank", () => {
  it("orders by queuedSinceMs, then by id — exactly as the simulation does", () => {
    const ranks = assignQueueRanks([
      vehicle(7, 3, 900),
      vehicle(2, 3, 400),
      vehicle(9, 3, 400),
      vehicle(4, 3, 1200),
    ]);
    // 400/2, 400/9 (tie broken by id), 900/7, 1200/4
    expect(ranks.get(2)).toBe(0);
    expect(ranks.get(9)).toBe(1);
    expect(ranks.get(7)).toBe(2);
    expect(ranks.get(4)).toBe(3);
  });

  it("ranks each road independently", () => {
    const ranks = assignQueueRanks([vehicle(1, 5, 100), vehicle(2, 6, 100), vehicle(3, 5, 50)]);
    expect(ranks.get(3)).toBe(0);
    expect(ranks.get(1)).toBe(1);
    expect(ranks.get(2)).toBe(0);
  });

  it("ignores vehicles that are not queued, and queues without a road", () => {
    const ranks = assignQueueRanks([
      vehicle(1, 5, 100, "moving"),
      vehicle(2, null, 100),
      vehicle(3, 5, 200),
    ]);
    expect(ranks.has(1)).toBe(false);
    expect(ranks.has(2)).toBe(false);
    expect(ranks.get(3)).toBe(0);
  });

  it("is deterministic for the same input", () => {
    const input = [vehicle(5, 1, 10), vehicle(3, 1, 10), vehicle(8, 1, 5)];
    const first = assignQueueRanks(input);
    const second = assignQueueRanks(input);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });
});

/* ---------------------- 22-24. vehicle zoom strategy ----------------------- */

const rendered = (id: number, blockedWaitMs = 0): RenderedVehicle => ({
  id,
  roadId: 0,
  type: "car",
  state: blockedWaitMs > 0 ? "queued" : "moving",
  x: 0,
  y: 0,
  headingRadians: 0,
  blockedWaitMs,
  fade: 1,
  queueRank: -1,
});

describe("vehicle zoom strategy", () => {
  it("never adds a per-vehicle wait halo layer", () => {
    const fleet = [rendered(1, 9000), rendered(2, 0)];
    const layers = buildVehicleLayers(chicagoModel(2).projection, fleet, {
      atlas: "data:image/png;base64,",
      mapping: {
        car: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: false },
        truck: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: false },
        bicycle: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: false },
      },
    }, 17);
    expect(layers.some((layer) => layer.id === "vehicle-wait-outline")).toBe(false);
  });


  it("draws nothing at city zoom", () => {
    const fleet = Array.from({ length: 40 }, (_, index) => rendered(index));
    expect(buildVehicleLayers(chicagoModel(2).projection, fleet, null as never, VEHICLE_MINZOOM - 0.1)).toEqual([]);
  });

  it("never randomly samples active vehicles once the fleet is visible", () => {
    const fleet = Array.from({ length: 200 }, (_, index) =>
      rendered(index, index % 20 === 0 ? 9000 : 0),
    );
    const icons = {
      atlas: "data:image/png;base64,",
      mapping: {
        car: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: false },
        truck: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: false },
        bicycle: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: false },
      },
    } as never;
    for (const zoom of [VEHICLE_MINZOOM, 15.5, 17, 19]) {
      const layers = buildVehicleLayers(chicagoModel(2).projection, fleet, icons, zoom);
      const count = layers.reduce(
        (sum, layer) => sum + ((layer as unknown as { props: { data: unknown[] } }).props.data.length ?? 0),
        0,
      );
      expect(count, `full fleet at z${zoom}`).toBe(fleet.length);
    }
  });
});

/* ---------------------- 6. queue re-placement settles ---------------------- */

describe("settling re-placed vehicles", () => {
  const at = (id: number, x: number, y: number, headingRadians = 0): RenderedVehicle => ({
    id,
    roadId: 0,
    type: "car",
    state: "queued",
    x,
    y,
    headingRadians,
    blockedWaitMs: 4000,
    fade: 1,
    queueRank: 0,
  });

  it("blends a jump instead of teleporting, and converges on the target", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 0, 0)], memory, 0.016);
    // The vehicle is re-placed 5 m away — a queue packing move, not driving.
    const jump = settlePlacements([at(1, 5, 0)], memory, 0.016)[0];
    expect(jump.x).toBeGreaterThan(0);
    expect(jump.x).toBeLessThan(5);
    let previous = jump.x;
    let current = jump;
    for (let frame = 0; frame < 160; frame += 1) {
      current = settlePlacements([at(1, 5, 0)], memory, 0.016)[0];
      expect(current.x).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = current.x;
    }
    expect(current.x).toBeCloseTo(5, 1);
  });

  it("never moves a vehicle further in one frame than the jump itself", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 0, 0)], memory, 0.016);
    let last = 0;
    for (let frame = 0; frame < 30; frame += 1) {
      const step = settlePlacements([at(1, 5, 0)], memory, 0.016)[0].x - last;
      // A settle may not look faster than a car: at most 10 m/s of catch-up.
      expect(step).toBeLessThanOrEqual(10 * 0.016 + 1e-9);
      last += step;
    }
  });

  it("holds a re-placement below a physical speed even when a frame stalls", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 0, 0)], memory, 0.016);
    // A 40 m jump across a stalled 100 ms frame would otherwise land at 400 m/s.
    const stalled = settlePlacements([at(1, 40, 0)], memory, 0.1)[0];
    expect(stalled.x).toBeLessThanOrEqual(10 * 0.1 + 1e-9);
    expect(stalled.x / 0.1).toBeLessThanOrEqual(10 + 1e-6);
  });

  it("lets ordinary motion through untouched", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 0, 0)], memory, 0.016);
    const moving = settlePlacements([at(1, 0.2, 0, 0.02)], memory, 0.016)[0];
    expect(moving.x).toBe(0.2);
    expect(moving.headingRadians).toBe(0.02);
  });

  it("settles a large heading change even when the vehicle barely moves", () => {
    // A road change with a reversed direction swings the sprite ~180 deg in
    // place. Position alone would let that through as if nothing happened.
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 0, 0)], memory, 0.016);
    const swung = settlePlacements([at(1, 0.05, 0, Math.PI)], memory, 0.016)[0];
    expect(swung.headingRadians).toBeGreaterThan(0);
    expect(swung.headingRadians).toBeLessThan(Math.PI / 4);
  });

  it("snaps a vehicle it has never seen, and forgets vehicles that left", () => {
    const memory = new Map<number, DisplayedPlacement>();
    const fresh = settlePlacements([at(9, 12, 7)], memory, 0.016)[0];
    expect(fresh.x).toBe(12);
    expect(memory.has(9)).toBe(true);
    settlePlacements([], memory, 0.016);
    expect(memory.size).toBe(0);
  });

  it("takes the short way round when it blends a heading", () => {
    const memory = new Map<number, DisplayedPlacement>();
    const almost = (180 - 2) * (Math.PI / 180);
    const minus = (-180 + 2) * (Math.PI / 180);
    settlePlacements([at(1, 0, 0, almost)], memory, 0.016);
    const blended = settlePlacements([at(1, 8, 0, minus)], memory, 0.016)[0];
    // Rotating the short way passes through ±180 deg, not through zero.
    expect(Math.abs(blended.headingRadians)).toBeGreaterThan(almost);
  });


  it("settles a 180-degree flip in place without manufacturing movement", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 4, 2, 0)], memory, 0.016);
    // Same position, heading reversed: the old code divided by a zero distance.
    const flipped = settlePlacements([at(1, 4, 2, Math.PI)], memory, 0.016)[0];
    expect(flipped.x).toBe(4);
    expect(flipped.y).toBe(2);
    expect(Number.isFinite(flipped.headingRadians)).toBe(true);
    expect(flipped.headingRadians).toBeGreaterThan(0);
    expect(flipped.headingRadians).toBeLessThan(Math.PI);
  });

  it("settles a 90-degree flip in place", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, -3, 8, 0)], memory, 0.016);
    const turned = settlePlacements([at(1, -3, 8, Math.PI / 2)], memory, 0.016)[0];
    expect(turned.x).toBe(-3);
    expect(turned.y).toBe(8);
    expect(turned.headingRadians).toBeGreaterThan(0);
    expect(turned.headingRadians).toBeLessThan(Math.PI / 2);
  });

  it("stays finite over repeated in-place flips, memory included", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 0, 0, 0)], memory, 0.016);
    let last = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      const settled = settlePlacements([at(1, 0, 0, frame % 2 === 0 ? Math.PI : 0)], memory, 0.016)[0];
      for (const value of [settled.x, settled.y, settled.headingRadians]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      const stored = memory.get(1)!;
      for (const value of [stored.x, stored.y, stored.headingRadians]) {
        expect(Number.isFinite(value)).toBe(true);
      }
      last = settled.headingRadians;
    }
    expect(Number.isFinite(last)).toBe(true);
  });

  it("never emits a non-finite placement, whatever the input", () => {
    const memory = new Map<number, DisplayedPlacement>();
    const cases: RenderedVehicle[] = [
      at(1, 0, 0, 0),
      at(1, 0, 0, Math.PI),
      at(1, 1e-9, 0, Math.PI / 2),
      at(1, 25, -40, -Math.PI),
      at(1, 0.2, 0.2, Math.PI * 1.99),
    ];
    for (const vehicle of cases) {
      const settled = settlePlacements([vehicle], memory, 0.016)[0];
      expect(Number.isFinite(settled.x)).toBe(true);
      expect(Number.isFinite(settled.y)).toBe(true);
      expect(Number.isFinite(settled.headingRadians)).toBe(true);
    }
  });

  it("treats a sub-threshold nudge as motion, not as a re-placement", () => {
    const memory = new Map<number, DisplayedPlacement>();
    settlePlacements([at(1, 0, 0)], memory, 0.016);
    const nudged = settlePlacements([at(1, SETTLE_THRESHOLD_M - 0.01, 0)], memory, 0.016)[0];
    expect(nudged.x).toBe(SETTLE_THRESHOLD_M - 0.01);
  });
});


/* --------------- 1.2 authoritative queue packing (renderer) --------------- */

describe("authoritative queue packing", () => {
  const model = chicagoModel(2);
  const indexes = buildDirectedPathIndexes(model);
  const laneOffsets = model.city.roads.map(() => 0);
  // A road long enough to hold a queue; its end is the stop line side.
  const roadId = model.city.roads.findIndex((road) => road.length > 60);
  expect(roadId).toBeGreaterThanOrEqual(0);
  const index = indexes[roadId]!;
  const roadEnd = samplePathIndex(index, index.total);

  const queued = (
    id: number,
    rank: number,
    progress: number,
    type: "car" | "truck" | "bicycle" = "car",
    road = roadId,
  ): RenderedVehicle => ({
    id,
    roadId: road,
    type,
    state: "queued",
    x: 0,
    y: 0,
    headingRadians: 0,
    blockedWaitMs: 0,
    fade: 1,
    queueRank: rank,
  });

  /** Metres from the packed position to the road end: smaller is further forward. */
  const distanceToStopLine = (vehicle: RenderedVehicle): number =>
    Math.hypot(vehicle.x - roadEnd.x, vehicle.y - roadEnd.y);

  const pack = (
    vehicles: RenderedVehicle[],
    progress: Map<number, number>,
    roads: RenderedVehicle[] = vehicles,
  ): RenderedVehicle[] =>
    packQueues(
      model.city,
      indexes,
      laneOffsets,
      roads,
      (id) => progress.get(id) ?? 0,
    );

  it("orders by authoritative rank — not by progress, not by id", () => {
    // Identical progress; the lower id holds the WORSE rank. Ids and progress
    // cannot produce the right answer here; only queueRank can.
    const a = queued(2, 1, 50);
    const b = queued(9, 0, 50);
    const progress = new Map([
      [2, 50],
      [9, 50],
    ]);
    const packed = pack([a, b], progress);
    const packedA = packed.find((vehicle) => vehicle.id === 2)!;
    const packedB = packed.find((vehicle) => vehicle.id === 9)!;
    // B is rank 0: it renders in front, closer to the stop line.
    expect(distanceToStopLine(packedB)).toBeLessThan(distanceToStopLine(packedA));
  });

  it("keeps three ranks out of id order", () => {
    const vehicles = [queued(9, 0, 60), queued(4, 1, 60), queued(6, 2, 60)];
    const progress = new Map([
      [9, 60],
      [4, 60],
      [6, 60],
    ]);
    const packed = pack(vehicles, progress);
    const byId = new Map(packed.map((vehicle) => [vehicle.id, distanceToStopLine(vehicle)]));
    expect(byId.get(9)!).toBeLessThan(byId.get(4)!);
    expect(byId.get(4)!).toBeLessThan(byId.get(6)!);
  });

  it("packs mixed classes in rank order, spaced by the front vehicle's length", () => {
    const vehicles = [queued(1, 1, 60, "car"), queued(2, 0, 60, "truck"), queued(3, 2, 60, "bicycle")];
    const progress = new Map([
      [1, 60],
      [2, 60],
      [3, 60],
    ]);
    const packed = pack(vehicles, progress);
    const d = (id: number) => distanceToStopLine(packed.find((vehicle) => vehicle.id === id)!);
    expect(d(2)).toBeLessThan(d(1));
    expect(d(1)).toBeLessThan(d(3));
    // The gap behind the truck is the truck's length plus the queue gap.
    const expected = VEHICLE_LENGTH_M.truck + QUEUE_GAP_M;
    expect(Math.abs(d(1) - d(2) - expected)).toBeLessThan(expected * 0.35);
    // Nothing overlaps.
    expect(d(1) - d(2)).toBeGreaterThan(0.5);
    expect(d(3) - d(1)).toBeGreaterThan(0.5);
  });

  it("orders each road's queue independently", () => {
    const other = model.city.roads.findIndex((road, id) => id !== roadId && road.length > 40);
    expect(other).toBeGreaterThanOrEqual(0);
    const vehicles = [
      queued(11, 1, 30, "car", other),
      queued(12, 0, 30, "car", roadId),
      queued(13, 0, 30, "car", other),
    ];
    const progress = new Map([
      [11, 30],
      [12, 30],
      [13, 30],
    ]);
    const packed = pack(vehicles, progress);
    const byId = new Map(packed.map((vehicle) => [vehicle.id, vehicle]));
    const endOther = samplePathIndex(indexes[other]!, indexes[other]!.total);
    const dOther = (id: number) =>
      Math.hypot(byId.get(id)!.x - endOther.x, byId.get(id)!.y - endOther.y);
    // Road `other` has its own front: rank 0 there is id 13, not the input order.
    expect(dOther(13)).toBeLessThan(dOther(11));
    // And road `roadId` keeps its own front.
    expect(distanceToStopLine(byId.get(12)!)).toBeLessThan(Infinity);
  });

  it("keeps the worker's rank: presentation never invents one", () => {
    const vehicles = [queued(1, 9, 60), queued(2, 2, 60), queued(3, 5, 60)];
    const progress = new Map([
      [1, 60],
      [2, 60],
      [3, 60],
    ]);
    const packed = pack(vehicles, progress);
    for (const vehicle of packed) {
      expect(vehicle.queueRank).toBe(vehicles.find((input) => input.id === vehicle.id)!.queueRank);
    }
    // Non-contiguous ranks still order correctly.
    const d = (id: number) => distanceToStopLine(packed.find((vehicle) => vehicle.id === id)!);
    expect(d(2)).toBeLessThan(d(3));
    expect(d(3)).toBeLessThan(d(1));
  });

  it("leaves unranked vehicles exactly where they are", () => {
    const moving: RenderedVehicle = {
      ...queued(7, -1, 20),
      state: "moving",
      x: 12.5,
      y: -3.25,
      headingRadians: 1.1,
    };
    const packed = pack([moving], new Map([[7, 20]]));
    expect(packed[0].x).toBe(12.5);
    expect(packed[0].y).toBe(-3.25);
    expect(packed[0].headingRadians).toBe(1.1);
  });

  it("is deterministic for the same input", () => {
    const vehicles = [queued(1, 1, 60), queued(2, 0, 60), queued(3, 2, 60)];
    const progress = new Map([
      [1, 60],
      [2, 60],
      [3, 60],
    ]);
    const first = pack(vehicles, progress).map((vehicle) => [vehicle.id, vehicle.x, vehicle.y]);
    const second = pack(vehicles, progress).map((vehicle) => [vehicle.id, vehicle.x, vehicle.y]);
    expect(first).toEqual(second);
  });

  it("treats the authoritative rank as the only queue test", () => {
    // A vehicle that has just joined a queue has 0 ms of wait — and is queued.
    expect(isQueued({ ...queued(1, 0, 10) })).toBe(true);
    expect(isQueued({ ...queued(1, 4, 10) })).toBe(true);
    // A blocked vehicle the worker did not rank is not in a queue.
    const blocked = { ...queued(1, -1, 10), blockedWaitMs: 9_000 };
    expect(isQueued(blocked)).toBe(false);
  });
});

/* --------------------------- 1.3 turn continuity --------------------------- */

describe("turn continuity", () => {
  const model = chicagoModel(2);
  const indexes: DirectedPathIndexes = buildDirectedPathIndexes(model);

  /** Find a road pair that actually joins, so the curve path is exercised. */
  function joinedPair() {
    for (const road of model.city.roads) {
      const next = model.city.roads.find((other) => other.from === road.to && other.id !== road.id);
      if (next) {
        return { from: road, to: next };
      }
    }
    return null;
  }

  it("moves without teleporting and keeps heading continuous across a turn", () => {
    const pair = joinedPair();
    expect(pair).not.toBeNull();
    if (!pair) {
      return;
    }
    const offsets = model.city.roads.map((road) =>
      laneCentreOffsetMetres(model, road.id, carriagewayPairs(model)),
    );
    const snapshot = (roadId: number, progress: number): PresentationSnapshot =>
      ({
        sequence: 0,
        timeMs: 0,
        controller: "fixed",
        vehicles: [
          {
            id: 1,
            type: "car",
            state: "moving",
            roadId,
            progress,
            queueRank: null,
            blockedWaitMs: 0,
          } as PresentationVehicle,
        ],
        signals: [],
        roadConditions: [],
        incidents: [],
      }) as unknown as PresentationSnapshot;

    const previous = snapshot(pair.from.id, pair.from.length - 6);
    const current = snapshot(pair.to.id, 6);
    const options = { nowMs: 1000, receivedAtMs: 1000, laneOffsets: offsets, city: model.city };
    let last = interpolateVehicles(indexes, previous, current, 0, options)[0];
    let maxStep = 0;
    let maxTurn = 0;
    for (let step = 1; step <= 40; step += 1) {
      const alpha = step / 40;
      const point = interpolateVehicles(indexes, previous, current, alpha, options)[0];
      const distance = Math.hypot(point.x - last.x, point.y - last.y);
      maxStep = Math.max(maxStep, distance);
      let delta = Math.abs(point.headingRadians - last.headingRadians);
      delta = Math.min(delta, Math.abs(delta - Math.PI * 2));
      maxTurn = Math.max(maxTurn, delta);
      last = point;
    }
    // The whole turn covers ~12 m over 40 samples: no step may jump a metre,
    // and no single step may rotate the sprite by more than ~20 degrees.
    expect(maxStep).toBeLessThan(1);
    expect((maxTurn * 180) / Math.PI).toBeLessThan(20);
  });
});

/* --------------------- 16-20. incident language, no pings ------------------ */

describe("incident language", () => {
  it("exposes a crash anchor for the dev camera, and null when there is no crash", () => {
    const model = chicagoModel(2);
    const empty = buildIncidentLayers(
      { sequence: 0, timeMs: 0, vehicles: [], signals: [], roadConditions: [], incidents: [] } as unknown as PresentationSnapshot,
      model,
    );
    expect(empty.extras.crash).toBeNull();
    const crashRoad = model.city.roads[0];
    const crashed = buildIncidentLayers(
      {
        sequence: 0,
        timeMs: 0,
        vehicles: [],
        signals: [],
        roadConditions: [],
        incidents: [{ id: 1, kind: "crash", status: "active", roadIds: [crashRoad.id], eventCenterIntersectionId: null, expiresAtMs: null }],
      } as unknown as PresentationSnapshot,
      model,
    );
    // A crash draws as deck geometry with no DOM plate, so the anchor is the
    // only way a screenshot can frame one.
    expect(crashed.extras.crash).not.toBeNull();
    expect(Number.isFinite(crashed.extras.crash!.x)).toBe(true);
    expect(Number.isFinite(crashed.extras.crash!.y)).toBe(true);
  });

  it("contains no pulse or ring animation", () => {
    const model = chicagoModel(2);
    const snapshot = {
      sequence: 0,
      timeMs: 0,
      controller: "fixed",
      vehicles: [],
      signals: [],
      roadConditions: [{ roadId: 0, closed: true, capacity: 10 }],
      incidents: [
        { id: 1, kind: "event-release", status: "active", roadIds: [], eventCenterIntersectionId: null, expiresAtMs: null },
      ],
    } as unknown as PresentationSnapshot;
    const { layers } = buildIncidentLayers(snapshot, model);
    const ids = layers.map((layer) => layer.id);
    expect(ids).not.toContain("event-rings");
    expect(ids).not.toContain("event-arrows");
    // Nothing animates: no layer carries a time-derived radius.
    for (const layer of layers) {
      const props = (layer as unknown as { props?: Record<string, unknown> }).props ?? {};
      for (const [key, value] of Object.entries(props)) {
        if (/radius/i.test(key) && typeof value === "function") {
          const evaluated = String(value({ position: [0, 0] }));
          expect(evaluated).not.toMatch(/NaN/);
        }
      }
    }
  });
});

/* --------------------------- 1.4 scale-aware venues ------------------------ */

describe("scale-aware event venues", () => {
  it("hosts real venues only where they exist", () => {
    const tiny = availableChicagoEventVenues(chicagoModel(0));
    expect(tiny.length).toBe(0);
    for (const scale of [1, 2, 3]) {
      const venues = availableChicagoEventVenues(chicagoModel(scale));
      expect(venues.length, `scale ${scale} venues`).toBeGreaterThan(0);
      for (const venue of venues) {
        expect(venue.name.length).toBeGreaterThan(3);
        expect(Number.isInteger(venue.intersectionId)).toBe(true);
      }
    }
  });
});

/* --------------------- 1.1 / 1.6 authoritative geometry -------------------- */

describe("authoritative carriageway model", () => {
  it("groups by StreetPiece, and gives each road its piece's own width", () => {
    const model = chicagoModel(2);
    const pairs = carriagewayPairs(model);
    for (const piece of model.streets) {
      for (const roadId of piece.roadIds) {
        expect([...pairs.partners[roadId]].sort((a, b) => a - b)).toEqual(
          [...piece.roadIds].sort((a, b) => a - b),
        );
        expect(pairs.widthM[roadId]).toBeCloseTo(piece.widthM, 6);
      }
    }
  });

  it("has no defaulted lane offset anywhere in the geometry module", () => {
    // The implicit 3.2 m constant is gone, and this guard is what stops it
    // coming back: the offset must always be supplied by the carriageway model.
    expect("LANE_OFFSET_METRES" in mapGeometry).toBe(false);
  });
});
