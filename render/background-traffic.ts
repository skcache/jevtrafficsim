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
 *  - background positions are presentation, not hidden simulation truth: queued
 *    sprites pack behind the stop line and moving slots advance deterministically
 *    using the road's authoritative speed factor. Every sprite remains on-path,
 *    in a stable lane, with the road tangent as its heading.
 *  - the car being watched is never covered: its own road draws one sprite fewer,
 *    and the display pass additionally drops whichever sprite sits closest to it.
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
 * Stable presentation trajectory for a moving aggregate sprite.
 *
 * Counts are simulation truth, but snapshots intentionally do not ship every
 * background vehicle's exact progress. The old renderer compensated by spacing
 * sprites at `(slot + 1) / (moving + 1)`, which made the entire fleet STATIC
 * while the count stayed constant and made every existing car jump whenever the
 * count changed. That is the worst possible fake traffic: parked cars that
 * teleport when another car enters the road.
 *
 * Instead each slot gets a deterministic phase and advances forward using the
 * road's real speed limit scaled by the simulation's authoritative road
 * `speedFactor`. Changing the count only adds/removes slots; it never relocates
 * the slots that already existed.
 */
function movingProgress(
  roadLength: number,
  start: number,
  end: number,
  timeMs: number,
  speedMps: number,
  roadId: number,
  slot: number,
): number {
  const lo = Math.max(0, Math.min(roadLength, start));
  const hi = Math.max(lo, Math.min(roadLength, end));
  const span = hi - lo;
  if (span <= 1e-6) {
    return lo;
  }
  const phase = hashToUnit(roadId + 101, slot + 211) * span;
  const travelled = Math.max(0, timeMs) * Math.max(0, speedMps) / 1000;
  return lo + ((phase + travelled) % span);
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
        laneOffset: vehicleLaneOffsetMetres(city, laneOffsets, key, traffic.roadId),
        queueRank: slot,
      });
      cursor = centre - length / 2 - QUEUE_GAP_M;
    }

    // Moving traffic uses a stable phase per slot and advances with the road's
    // simulated speed factor. Keep it out of the packed queue at the downstream
    // end; if the queue grows, that simply shortens the moving presentation span.
    const movingStart = Math.min(6, road.length * 0.08);
    const movingEnd = Math.max(
      movingStart,
      Math.min(road.length, cursor - STOP_LINE_CLEARANCE_M),
    );
    const presentationSpeedMps =
      Math.max(0.05, Math.min(1, traffic.speedFactor)) * Math.max(0, road.speedLimit);
    for (let slot = 0; slot < moving; slot += 1) {
      const type = typeFor(traffic.roadId, slot + SLOTS_PER_KIND);
      const key = traffic.roadId * KEY_STRIDE + SLOTS_PER_KIND + slot;
      sprites.push({
        key,
        roadId: traffic.roadId,
        type,
        progress: movingProgress(
          road.length,
          movingStart,
          movingEnd,
          snapshot.timeMs,
          presentationSpeedMps,
          traffic.roadId,
          slot,
        ),
        laneOffset: vehicleLaneOffsetMetres(city, laneOffsets, key, traffic.roadId),
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
 *
 * The hero's spot is reserved here rather than in the synthesis: the followed car
 * is not queue-packed (its position is the simulation's own), so the nearest
 * sprite on its road is dropped at draw time to keep the map from parking a car
 * on top of the car being watched. Doing it at display rate keeps the synthesis
 * cacheable, which one moving progress value would otherwise destroy.
 */
export function renderBackgroundVehicles(
  previous: readonly SyntheticVehicle[],
  current: readonly SyntheticVehicle[],
  alpha: number,
  options: {
    readonly indexes: DirectedPathIndexes;
    readonly egoRoadId?: RoadId | null;
    readonly egoProgress?: number | null;
  },
): RenderedVehicle[] {
  if (current.length === 0) {
    return [];
  }
  const t = Math.min(1, Math.max(0, alpha));
  const before = new Map<number, SyntheticVehicle>();
  for (const sprite of previous) {
    before.set(sprite.key, sprite);
  }

  let reservedKey: number | null = null;
  if (options.egoRoadId != null && options.egoProgress != null) {
    let best = Infinity;
    for (const sprite of current) {
      if (sprite.roadId !== options.egoRoadId) {
        continue;
      }
      const distance = Math.abs(sprite.progress - options.egoProgress);
      if (distance < best) {
        best = distance;
        reservedKey = sprite.key;
      }
    }
  }

  const rendered: RenderedVehicle[] = [];
  for (const sprite of current) {
    if (sprite.key === reservedKey) {
      continue;
    }
    const index = options.indexes[sprite.roadId];
    if (!index) {
      continue;
    }
    const earlier = before.get(sprite.key);
    // A moving slot wraps from the end of its road back to the beginning when
    // its deterministic presentation trajectory completes a lap. Never lerp
    // across that discontinuity: doing so draws a car driving backwards through
    // the entire block for one frame. Treat the wrapped slot as a fresh visual
    // sample at the road entrance instead.
    const wrappedForward =
      earlier !== undefined &&
      earlier.queueRank < 0 &&
      sprite.queueRank < 0 &&
      earlier.progress > sprite.progress &&
      earlier.progress - sprite.progress > index.total * 0.5;
    const progress =
      earlier === undefined || wrappedForward
        ? sprite.progress
        : earlier.progress + (sprite.progress - earlier.progress) * t;
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
