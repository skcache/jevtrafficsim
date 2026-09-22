/** Bounded, presentation-only witnesses to aggregate road traffic. */
import type { DirectedPathIndexes } from "@/render/map-geometry";
import { applyLaneOffset } from "@/render/map-geometry";
import { samplePathIndex } from "@/cities/paths";
import type { RenderedVehicle } from "@/render/interpolate";
import { stopLineSetbackMetres, vehicleLaneOffsetMetres } from "@/render/road-presentation";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { City, RoadId, VehicleType } from "@/sim/types";

export const KEY_STRIDE = 64;
export const MAX_SPRITES_PER_ROAD = 48;
export const SPRITE_SPACING_M = 6;

export interface SyntheticVehicle {
  readonly key: number;
  readonly roadId: RoadId;
  readonly type: VehicleType;
  readonly progress: number;
  readonly laneOffset: number;
  readonly queueRank: number;
  /** Crossed this road's current usable presentation segment. */
  readonly wrapped: boolean;
}

export interface TrafficPresentationOptions {
  readonly city: City;
  readonly laneOffsets: readonly number[];
  readonly egoRoadId: RoadId | null;
}

export interface TrafficPresentationPair {
  readonly previous: readonly SyntheticVehicle[];
  readonly current: readonly SyntheticVehicle[];
}

function hashToUnit(a: number, b: number): number {
  let h = (a * 0x1f1f1f1f) ^ (b * 0x27d4eb2d);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function typeFor(roadId: number, slot: number): VehicleType {
  const roll = hashToUnit(roadId + 7, slot + 13);
  return roll < 0.07 ? "truck" : roll < 0.085 ? "bicycle" : "car";
}

/** New slots use free, fixed cells. Survivors are never re-spaced. */
function birthProgress(
  roadId: number, slot: number, start: number, end: number,
  existing: readonly SyntheticVehicle[], queued: boolean,
): number | null {
  const cells = Math.floor((end - start) / SPRITE_SPACING_M);
  if (cells <= 0) return null;
  const origin = (Math.floor(hashToUnit(roadId + 31, slot + 97) * cells) + slot) % cells;
  for (let attempt = 0; attempt < cells; attempt += 1) {
    const cell = queued ? cells - 1 - ((origin + attempt) % cells) : (origin + attempt) % cells;
    const progress = start + (cell + 0.5) * SPRITE_SPACING_M;
    if (existing.every((sprite) => Math.abs(sprite.progress - progress) >= SPRITE_SPACING_M * 0.8)) {
      return progress;
    }
  }
  return null;
}

export interface BackgroundTrafficTracker {
  update(snapshot: PresentationSnapshot | null, options: TrafficPresentationOptions): TrafficPresentationPair;
  reset(): void;
  readonly trackedRoads: number;
}

/** One instance per active scenario; never feeds engine or controller state. */
export function createBackgroundTrafficTracker(): BackgroundTrafficTracker {
  let byRoad = new Map<RoadId, SyntheticVehicle[]>();
  let lastSnapshot: PresentationSnapshot | null = null;
  let lastTime = -1;
  let lastEgoRoad: RoadId | null = null;
  let pair: TrafficPresentationPair = { previous: [], current: [] };
  const reset = (): void => {
    byRoad = new Map();
    lastSnapshot = null;
    lastTime = -1;
    lastEgoRoad = null;
    pair = { previous: [], current: [] };
  };

  return {
    reset,
    get trackedRoads() { return byRoad.size; },
    update(snapshot, options) {
      if (snapshot === null) { reset(); return pair; }
      if (snapshot === lastSnapshot && options.egoRoadId === lastEgoRoad) return pair;
      if (snapshot.timeMs < lastTime || (snapshot.timeMs === 0 && lastTime > 0)) reset();

      const previous = pair.current;
      const nextByRoad = new Map<RoadId, SyntheticVehicle[]>();
      const current: SyntheticVehicle[] = [];
      const dtSeconds = lastTime < 0 ? 0 : Math.max(0, snapshot.timeMs - lastTime) / 1000;
      for (const traffic of snapshot.roadTraffic) {
        const road = options.city.roads[traffic.roadId];
        if (!road || !Number.isFinite(road.length) || road.length <= 0) continue;
        const start = Math.min(road.length, SPRITE_SPACING_M * 0.5);
        const stop = Math.max(start, road.length - stopLineSetbackMetres(Math.max(1, road.lanes)));
        const capacity = Math.floor((stop - start) / SPRITE_SPACING_M);
        const count = Math.max(0, traffic.vehicleCount - (traffic.roadId === options.egoRoadId ? 1 : 0));
        const wanted = Math.min(count, MAX_SPRITES_PER_ROAD, capacity);
        if (wanted <= 0) continue;

        const old = byRoad.get(traffic.roadId) ?? [];
        const survivors = old.slice(0, wanted);
        const queueTarget = Math.min(wanted, Math.max(0, traffic.queuedCount));
        const queuedKeys = new Set(
          [...survivors].sort((a, b) => b.progress - a.progress || a.key - b.key)
            .slice(0, queueTarget).map((sprite) => sprite.key),
        );
        const existingQueue = survivors.filter((sprite) => queuedKeys.has(sprite.key));
        const queueTail = existingQueue.length > 0
          ? Math.min(...existingQueue.map((sprite) => sprite.progress)) : stop;
        const usableEnd = Math.max(start, Math.min(stop, queueTail - SPRITE_SPACING_M));
        const speed = Math.max(0, Math.min(1, traffic.speedFactor)) * Math.max(0, road.speedLimit);
        const next: SyntheticVehicle[] = [];
        for (const sprite of survivors) {
          const queued = queuedKeys.has(sprite.key);
          const end = queued ? stop : Math.max(sprite.progress, usableEnd);
          const travelled = queued ? 0 : dtSeconds * speed;
          const wrapped = !queued && travelled > 0 && sprite.progress + travelled > end;
          const progress = wrapped
            ? start + ((sprite.progress + travelled - end) % Math.max(SPRITE_SPACING_M, end - start))
            : Math.min(end, sprite.progress + travelled);
          next.push({ ...sprite, progress: Math.max(0, Math.min(road.length, progress)), queueRank: queued ? 0 : -1, wrapped });
        }
        for (let slot = old.length; slot < wanted; slot += 1) {
          const queued = next.filter((sprite) => sprite.queueRank >= 0).length < queueTarget;
          const progress = birthProgress(traffic.roadId, slot, start, stop, next, queued);
          if (progress === null) continue;
          const key = traffic.roadId * KEY_STRIDE + slot;
          next.push({
            key, roadId: traffic.roadId, type: typeFor(traffic.roadId, slot), progress,
            laneOffset: vehicleLaneOffsetMetres(options.city, options.laneOffsets, key, traffic.roadId),
            queueRank: queued ? 0 : -1, wrapped: false,
          });
        }
        next.sort((a, b) => a.key - b.key);
        const queue = next.filter((sprite) => sprite.queueRank >= 0)
          .sort((a, b) => b.progress - a.progress || a.key - b.key);
        const ranks = new Map(queue.map((sprite, index) => [sprite.key, index]));
        const ranked = next.map((sprite) => ({ ...sprite, queueRank: ranks.get(sprite.key) ?? -1 }));
        nextByRoad.set(traffic.roadId, ranked);
        current.push(...ranked);
      }
      byRoad = nextByRoad;
      lastSnapshot = snapshot;
      lastEgoRoad = options.egoRoadId;
      lastTime = snapshot.timeMs;
      pair = { previous, current };
      return pair;
    },
  };
}

/** Wraps and births/deaths crossfade at on-road positions, never lerp backwards. */
export function renderBackgroundVehicles(
  previous: readonly SyntheticVehicle[], current: readonly SyntheticVehicle[], alpha: number,
  options: { readonly indexes: DirectedPathIndexes; readonly egoRoadId?: RoadId | null; readonly egoProgress?: number | null },
): RenderedVehicle[] {
  const t = Math.min(1, Math.max(0, alpha));
  const before = new Map(previous.map((sprite) => [sprite.key, sprite]));
  const after = new Set(current.map((sprite) => sprite.key));
  let reservedKey: number | null = null;
  if (options.egoRoadId != null && options.egoProgress != null) {
    let best = Infinity;
    for (const sprite of current) {
      if (sprite.roadId !== options.egoRoadId) continue;
      const distance = Math.abs(sprite.progress - options.egoProgress);
      if (distance < best) { best = distance; reservedKey = sprite.key; }
    }
  }
  const rendered: RenderedVehicle[] = [];
  const draw = (sprite: SyntheticVehicle, progress: number, fade: number, id = sprite.key): void => {
    if (fade <= 0 || sprite.key === reservedKey) return;
    const index = options.indexes[sprite.roadId];
    if (!index) return;
    const placed = applyLaneOffset(samplePathIndex(index, progress), sprite.laneOffset);
    rendered.push({
      id, roadId: sprite.roadId, type: sprite.type,
      state: sprite.queueRank >= 0 ? "queued" : "moving",
      x: placed.x, y: placed.y, headingRadians: placed.heading,
      blockedWaitMs: 0, fade, queueRank: sprite.queueRank,
    });
  };
  for (const sprite of current) {
    const earlier = before.get(sprite.key);
    if (!earlier) { draw(sprite, sprite.progress, t); continue; }
    if (sprite.wrapped) {
      draw(earlier, earlier.progress, 1 - t);
      draw(sprite, sprite.progress, t, sprite.key + 1_000_000_000);
      continue;
    }
    const end = Math.max(earlier.progress, sprite.progress);
    draw(sprite, earlier.progress + (end - earlier.progress) * t, 1);
  }
  for (const sprite of previous) {
    if (!after.has(sprite.key)) draw(sprite, sprite.progress, 1 - t);
  }
  return rendered;
}
