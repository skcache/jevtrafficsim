/**
 * Background traffic, drawn from the simulation's own counts.
 *
 * The map used to draw exactly one vehicle — the followed car — and left the
 * congestion overlay to speak for the other few thousand. At the follow framing
 * that reads as an empty city: a road only gets painted when it is already
 * hurting, so free-flowing traffic was invisible, and "rush hour" looked like a
 * handful of amber stripes on deserted streets.
 *
 * What this module does is put the missing traffic back on the road without
 * putting vehicle objects back in the frame. The presentation snapshot already
 * carries the simulation's own per-road truth — how many vehicles are on each
 * road and how many of them are queued at its stop line — so the sprites are
 * SYNTHESISED from counts and road geometry, deterministically, on the client.
 *
 * The honesty rules this keeps:
 *
 *  - the COUNT is the simulation's. A road with 12 vehicles draws twelve sprites;
 *    a free road draws none. Nothing is invented that the world does not have.
 *  - positions are geometry, not noise: queued sprites pack bumper to bumper
 *    behind the stop line, moving sprites are spaced along the road, and every
 *    sprite sits on its road's path in a stable lane with the road's own tangent
 *    as its heading (the same rule the ego obeys).
 *  - it is a pure function of (snapshot, city, indexes), so the same frame always
 *    produces the same sprites, and it never feeds anything back into the engine.
 *
 * Cost: O(occupied roads) once per snapshot, then a key-matched lerp per frame —
 * no per-vehicle payload, no worker work, no change to what is simulated.
 */
import type { DirectedPathIndexes } from "@/render/map-geometry";
import { applyLaneOffset } from "@/render/map-geometry";
import { samplePathIndex } from "@/cities/paths";
import type { RenderedVehicle } from "@/render/interpolate";
import {
  QUEUE_GAP_M,
  STOP_LINE_CLEARANCE_M,
  VEHICLE_LENGTH_M,
  laneSlotFor,
  laneKeyFor,
  stopLineSetbackMetres,
  vehicleLaneOffsetMetres,
} from "@/render/road-presentation";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { City, RoadId, VehicleType } from "@/sim/types";

/** Sprite slots per road: 0-23 queue behind the stop line, 24-47 moving. */
const SLOTS_PER_KIND = 24;
/** Key space per road, so a key is `roadId * KEY_STRIDE + slot` and can never
 * collide between roads. Slot count fits comfortably inside one stride. */
export const KEY_STRIDE = 64;
/** Beyond this a road is drawn as fully occupied; the extra cars add no
 * information a viewer can use and cost real frames. */
export const MAX_SPRITES_PER_ROAD = SLOTS_PER_KIND * 2;

export interface SyntheticVehicle {
  /** Stable identity across snapshots: road + slot. */
  readonly key: number;
  readonly roadId: RoadId;
  readonly type: VehicleType;
  /** Metres along the directed road. */
  readonly progress: number;
  /** Right-side lane offset in metres. */
  readonly laneOffset: number;
  /** Rank in its road's queue, or -1 when the sprite is moving. */
  readonly queueRank: number;
}

/** Deterministic 0..1 from two small integers. */
function hashToUnit(a: number, b: number): number {
  let h = (a * 0x1f1f1f1f) ^ (b * 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Mostly cars, some trucks, the occasional bicycle — stable per slot. */
function typeFor(roadId: number, slot: number): VehicleType {
  const roll = hashToUnit(roadId + 7, slot + 13);
  if (roll < 0.07) {
    return "truck";
  }
  if (roll < 0.085) {
    return "bicycle";
  }
  return "car";
}

/**
 * Every background sprite the frame's own numbers justify, in road-id order.
 *
 * The ego is drawn separately by the caller, so it is subtracted from its road's
 * count — otherwise every frame would carry a ghost copy of the car you follow.
 */
export function synthesizeRoadTraffic(
  snapshot: PresentationSnapshot | null,
  options: {
    readonly city: City;
    readonly laneOffsets: readonly number[];
    readonly egoRoadId: RoadId | null;
  },
): readonly SyntheticVehicle[] {
  if (!snapshot || snapshot.roadTraffic.length === 0) {
    return [];
  }
  const { city, laneOffsets, egoRoadId } = options;
  const sprites: SyntheticVehicle[] = [];
  for (const traffic of snapshot.roadTraffic) {
    const road = city.roads[traffic.roadId];
    if (!road || road.length <= 0) {
      continue;
    }
    const count = traffic.vehicleCount - (traffic.roadId === egoRoadId ? 1 : 0);
    if (count <= 0) {
      continue;
    }
    const lanes = Math.max(1, road.lanes);
    const laneKey = laneKeyFor(city, traffic.roadId);
    const queued = Math.min(count, traffic.queuedCount, SLOTS_PER_KIND);
    const moving = Math.min(count - queued, SLOTS_PER_KIND);
    const setback = stopLineSetbackMetres(lanes);

    // Bumper-to-bumper behind the stop line, front first: walk back from the
    // stop line accumulating each vehicle's own length plus the queue gap, so a
    // truck leaves a truck-sized hole and a bicycle does not. Offsets from a
    // single slot index (each multiplied by its own length) would space mixed
    // traffic by arithmetic instead of by geometry.
    let cursor = road.length - setback - STOP_LINE_CLEARANCE_M;
    for (let slot = 0; slot < queued; slot += 1) {
      const type = typeFor(traffic.roadId, slot);
      const key = traffic.roadId * KEY_STRIDE + slot;
      const length = VEHICLE_LENGTH_M[type] ?? VEHICLE_LENGTH_M.car;
      // Sprites are drawn centred on their sample, so the centre sits half a
      // vehicle back from wherever the previous tail ended.
      const centre = cursor - length / 2;
      sprites.push({
        key,
        roadId: traffic.roadId,
        type,
        progress: Math.max(0, centre),
        laneOffset: vehicleLaneOffsetMetres(
          city,
          laneOffsets,
          traffic.roadId * KEY_STRIDE + laneSlotFor(key, laneKey, lanes),
          traffic.roadId,
        ),
        queueRank: slot,
      });
      cursor = centre - length / 2 - QUEUE_GAP_M;
    }

    for (let slot = 0; slot < moving; slot += 1) {
      const type = typeFor(traffic.roadId, slot + SLOTS_PER_KIND);
      const key = traffic.roadId * KEY_STRIDE + SLOTS_PER_KIND + slot;
      // Spaced inside the block, never on the stop line and never off the start:
      // moving traffic belongs between junctions.
      const progress = (road.length * (slot + 1)) / (moving + 1);
      sprites.push({
        key,
        roadId: traffic.roadId,
        type,
        progress,
        laneOffset: vehicleLaneOffsetMetres(
          city,
          laneOffsets,
          traffic.roadId * KEY_STRIDE + laneSlotFor(key, laneKey, lanes),
          traffic.roadId,
        ),
        queueRank: -1,
      });
    }
  }
  return sprites;
}

/**
 * One-entry cache: a frame is rendered many times per snapshot (display rate) but
 * synthesised once. The ego road is part of the key because it is the only input
 * that changes between snapshots.
 */
let lastSnapshot: PresentationSnapshot | null = null;
let lastEgoRoad: RoadId | null = null;
let lastResult: readonly SyntheticVehicle[] = [];

export function synthesizeRoadTrafficCached(
  snapshot: PresentationSnapshot | null,
  options: {
    readonly city: City;
    readonly laneOffsets: readonly number[];
    readonly egoRoadId: RoadId | null;
  },
): readonly SyntheticVehicle[] {
  if (snapshot !== null && snapshot === lastSnapshot && options.egoRoadId === lastEgoRoad) {
    return lastResult;
  }
  lastResult = synthesizeRoadTraffic(snapshot, options);
  lastSnapshot = snapshot;
  lastEgoRoad = options.egoRoadId;
  return lastResult;
}

/**
 * Display-rate frame for the synthesised sprites: a sprite that exists in both
 * snapshots moves smoothly along its own road (progress is interpolated and the
 * path is re-sampled, exactly like the ego), and a sprite that only exists in one
 * of them simply appears or disappears.
 */
export function renderBackgroundVehicles(
  previous: readonly SyntheticVehicle[],
  current: readonly SyntheticVehicle[],
  alpha: number,
  options: { readonly indexes: DirectedPathIndexes },
): RenderedVehicle[] {
  if (current.length === 0) {
    return [];
  }
  const t = Math.min(1, Math.max(0, alpha));
  const before = new Map<number, SyntheticVehicle>();
  for (const sprite of previous) {
    before.set(sprite.key, sprite);
  }
  const rendered: RenderedVehicle[] = [];
  for (const sprite of current) {
    const index = options.indexes[sprite.roadId];
    if (!index) {
      continue;
    }
    const earlier = before.get(sprite.key);
    const progress =
      earlier === undefined ? sprite.progress : earlier.progress + (sprite.progress - earlier.progress) * t;
    const laneOffset =
      earlier === undefined ? sprite.laneOffset : earlier.laneOffset + (sprite.laneOffset - earlier.laneOffset) * t;
    const sample = samplePathIndex(index, progress);
    const placed = applyLaneOffset(sample, laneOffset);
    rendered.push({
      id: sprite.key,
      roadId: sprite.roadId,
      type: sprite.type,
      state: sprite.queueRank >= 0 ? "queued" : "moving",
      x: placed.x,
      y: placed.y,
      // Road tangent, same rule the ego follows: no sprite ever crabs sideways.
      headingRadians: placed.heading,
      blockedWaitMs: 0,
      fade: 1,
      queueRank: sprite.queueRank,
    });
  }
  return rendered;
}
