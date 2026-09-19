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
