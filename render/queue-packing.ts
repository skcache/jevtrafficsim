/**
 * Deterministic queue packing (presentation only).
 *
 * The simulation keeps its own truth: a queued vehicle's progress is where it
 * stopped. Presentation-wise that makes a queue look like a pile, because
 * several vehicles can share the same stop-line progress and stacked glyphs
 * read as one blob. This pass derives a queue rank per directed road from the
 * actual queue order (front first, by descending progress) and re-places the
 * queued vehicles bumper to bumper behind the front one using class-specific
 * physical lengths.
 *
 * Nothing here feeds back into the simulation: it is a pure function of the
 * rendered frame, the path indexes and the road lengths. It is safe when a road
 * is shorter than its queue — positions clamp to the road, never past its
 * start, so a long queue packs against the road entrance rather than escaping
 * into the block behind it.
 */
import type { DirectedPathIndexes } from "@/render/map-geometry";
import { applyLaneOffset } from "@/render/map-geometry";
import { samplePathIndex } from "@/cities/paths";
import type { RenderedVehicle } from "@/render/interpolate";
import { lerpAngle } from "@/render/interpolate";
import { QUEUE_GAP_M, VEHICLE_LENGTH_M } from "@/render/road-presentation";
import type { City } from "@/sim/types";

/** A vehicle counts as queued when it is blocked at an approach. */
export function isQueued(vehicle: RenderedVehicle): boolean {
  return vehicle.blockedWaitMs > 0;
}

/**
 * Re-place queued vehicles bumper to bumper behind the front of each queue.
 * `progressOf` reads a vehicle's current simulation progress, which is what
 * defines the true queue order.
 */
export function packQueues(
  city: City,
  indexes: DirectedPathIndexes,
  laneOffsets: readonly number[],
  rendered: readonly RenderedVehicle[],
  progressOf: (vehicleId: number) => number,
): RenderedVehicle[] {
  const queues = new Map<number, RenderedVehicle[]>();
  for (const vehicle of rendered) {
    if (!isQueued(vehicle) || vehicle.roadId === null) {
      continue;
    }
    const list = queues.get(vehicle.roadId) ?? [];
    list.push(vehicle);
    queues.set(vehicle.roadId, list);
  }

  const placed = new Map<number, { progress: number; rank: number }>();
  for (const [roadId, queue] of queues) {
    const road = city.roads[roadId];
    const index = indexes[roadId];
    if (!road || !index) {
      continue;
    }
    // Front first: the vehicle closest to the stop line leads the queue.
    queue.sort((a, b) => progressOf(b.id) - progressOf(a.id) || a.id - b.id);
    const frontProgress = Math.min(road.length, Math.max(0, progressOf(queue[0].id)));
    let distance = 0;
    queue.forEach((vehicle, rank) => {
      const progress = Math.max(0, Math.min(road.length, frontProgress - distance));
      placed.set(vehicle.id, { progress, rank });
      const length = VEHICLE_LENGTH_M[vehicle.type] ?? VEHICLE_LENGTH_M.car;
      distance += length + QUEUE_GAP_M;
    });
  }

  return rendered.map((vehicle) => {
    const target = placed.get(vehicle.id);
    if (!target || vehicle.roadId === null) {
      return vehicle;
    }
    const index = indexes[vehicle.roadId];
    if (!index) {
      return vehicle;
    }
    const sample = applyLaneOffset(
      samplePathIndex(index, target.progress),
      laneOffsets[vehicle.roadId] ?? 0,
    );
    return {
      ...vehicle,
      x: sample.x,
      y: sample.y,
      headingRadians: sample.heading,
      queueRank: target.rank,
    };
  });
}

/**
 * A jump larger than this is treated as a re-placement rather than motion.
 * A car at 15 m/s covers 0.25 m per frame, so a quarter metre is the boundary
 * between "drove there" and "was placed there" — about one pixel at street
 * zoom, which is why sub-threshold nudges are allowed through untouched.
 */
export const SETTLE_THRESHOLD_M = 0.25;

/** Time constant for settling a re-placed vehicle, in seconds. */
export const SETTLE_TAU_S = 0.2;

/**
 * Ceilings on how fast a settling vehicle may appear to move and rotate. An
 * exponential blend alone is not enough: one stalled frame lets it cover most
 * of the jump at once, which motion QA measured as 31 m/s. These caps hold the
 * settle below anything a car could plausibly do, whatever the frame timing.
 */
export const SETTLE_MAX_SPEED_MPS = 10;
export const SETTLE_MAX_TURN_RATE_DEG_PER_S = 240;

/**
 * A heading change bigger than this in one frame is a re-orientation, not a
 * turn. The position threshold alone is not enough: a vehicle can swing through
 * a large angle while barely moving — a road change with a reversed direction
 * does exactly that — which motion QA measured as 1,460 deg/s.
 */
export const SETTLE_MAX_TURN_PER_FRAME_RAD = (4 * Math.PI) / 180;

export type DisplayedPlacement = { x: number; y: number; headingRadians: number };

/** Short-way angular distance between two headings, in radians. */
function angleGap(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) {
    delta -= Math.PI * 2;
  }
  if (delta < -Math.PI) {
    delta += Math.PI * 2;
  }
  return Math.abs(delta);
}

/**
 * Settle the frame's placements.
 *
 * Queue packing re-places a queued vehicle from where it stopped to its packed
 * position. Applied raw, that is a teleport: motion QA measured 50 m/s and
 * 1,160 deg/s — vehicles jumping several metres in a single frame. This filter
 * blends only the jumps (a re-placement, or leaving a queue) over ~200 ms and
 * lets ordinary motion through untouched, so driving carries no lag while a
 * queue forming looks like cars closing up rather than snapping into place.
 *
 * `displayed` is the caller's per-frame memory of what was drawn; it is updated
 * in place and pruned to the vehicles still present, so it cannot grow.
 */
export function settlePlacements(
  vehicles: readonly RenderedVehicle[],
  displayed: Map<number, DisplayedPlacement>,
  dtSeconds: number,
): RenderedVehicle[] {
  const dt = Math.min(0.1, Math.max(0.001, dtSeconds));
  const factor = 1 - Math.exp(-dt / SETTLE_TAU_S);
  const present = new Set<number>();
  const settled = vehicles.map((vehicle) => {
    present.add(vehicle.id);
    const before = displayed.get(vehicle.id);
    const target = { x: vehicle.x, y: vehicle.y, headingRadians: vehicle.headingRadians };
    if (!before) {
      displayed.set(vehicle.id, target);
      return vehicle;
    }
    const gap = angleGap(before.headingRadians, target.headingRadians);
    if (
      Math.hypot(target.x - before.x, target.y - before.y) <= SETTLE_THRESHOLD_M &&
      gap <= SETTLE_MAX_TURN_PER_FRAME_RAD
    ) {
      displayed.set(vehicle.id, target);
      return vehicle;
    }
    const dx = target.x - before.x;
    const dy = target.y - before.y;
    const distance = Math.hypot(dx, dy);
    const step = Math.min(distance * factor, SETTLE_MAX_SPEED_MPS * dt);
    const next: DisplayedPlacement = {
      x: before.x + (dx / distance) * step,
      y: before.y + (dy / distance) * step,
      headingRadians: lerpAngle(
        before.headingRadians,
        target.headingRadians,
        Math.min(
          factor,
          ((SETTLE_MAX_TURN_RATE_DEG_PER_S * Math.PI) / 180) * dt / Math.max(1e-6, gap),
        ),
      ),
    };
    displayed.set(vehicle.id, next);
    return { ...vehicle, x: next.x, y: next.y, headingRadians: next.headingRadians };
  });
  for (const id of [...displayed.keys()]) {
    if (!present.has(id)) {
      displayed.delete(id);
    }
  }
  return settled;
}
