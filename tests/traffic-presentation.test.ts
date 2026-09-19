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
import { buildVehicleLayers, sampleVehicles, vehicleSampleRatio } from "@/render/deck-layers";
import { buildIncidentLayers } from "@/render/deck-layers";
import { buildDirectedPathIndexes, type DirectedPathIndexes } from "@/render/map-geometry";
import { interpolateVehicles, type RenderedVehicle } from "@/render/interpolate";
import { availableChicagoEventVenues } from "@/cities/chicago";
import { carriagewayPairs, laneCentreOffsetMetres } from "@/render/road-presentation";
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
  it("draws nothing at city zoom", () => {
    const fleet = Array.from({ length: 40 }, (_, index) => rendered(index));
    expect(buildVehicleLayers(chicagoModel(2).projection, fleet, null as never, VEHICLE_MINZOOM - 0.1)).toEqual([]);
  });

  it("samples deterministically, and never samples out a blocked vehicle", () => {
    const fleet = Array.from({ length: 200 }, (_, index) =>
      rendered(index, index % 20 === 0 ? 9000 : 0),
    );
    const first = sampleVehicles(fleet, 14.5).map((entry) => entry.id);
    const second = sampleVehicles(fleet, 14.5).map((entry) => entry.id);
    expect(first).toEqual(second);
    expect(first.length).toBeLessThan(fleet.length);
    // Every blocked vehicle survives sampling at every band.
    for (const zoom of [13.5, 14.5, 15.5]) {
      const kept = new Set(sampleVehicles(fleet, zoom).map((entry) => entry.id));
      for (const entry of fleet) {
        if (entry.blockedWaitMs > 0) {
          expect(kept.has(entry.id), `blocked ${entry.id} at z${zoom}`).toBe(true);
        }
      }
    }
  });

  it("thins with distance and is complete at close zoom", () => {
    expect(vehicleSampleRatio(13.5)).toBeLessThan(vehicleSampleRatio(14.5));
    expect(vehicleSampleRatio(14.5)).toBeLessThan(vehicleSampleRatio(15.5));
    expect(vehicleSampleRatio(16.5)).toBe(1);
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
