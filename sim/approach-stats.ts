/**
 * Per-approach queue statistics (Task 08, PRD §11.4 starvation watch).
 *
 * An "approach" is a directed incoming road at an intersection: a vehicle
 * queued at the end of road R is waiting to cross the intersection at R.to,
 * so the directed road id identifies the approach uniquely.
 *
 * Tracked per approach:
 * - CURRENT queue state: how many vehicles are queued at the approach, the
 *   largest wait currently in that queue, and the approach road's occupancy
 *   ratio (spillback pressure input for later controllers);
 * - HISTORICAL peak max-queue-wait: the starvation signal. Later policies
 *   (Adaptive, Jev) consume this so one direction can never be ignored
 *   indefinitely in favor of total throughput.
 *
 * Statistics are sampled from explicit traffic states after a step — no
 * timers, no randomness, fully deterministic.
 */
import type { City, RoadId } from "./types";
import type { TrafficState } from "./traffic";

export interface ApproachQueueStats {
  /** Vehicles currently queued at the end of this approach road. */
  readonly queued: number;
  /** Largest current wait among those vehicles (ms). */
  readonly maxWaitMs: number;
  /** Occupancy of the approach road: units / capacity (spillback pressure). */
  readonly occupancyRatio: number;
}

export interface ApproachStats {
  /** Current queue stats per approach road; approaches without a queue are absent. */
  current: Map<RoadId, ApproachQueueStats>;
  /** Historical peak max-queue-wait per approach road (ms). */
  peakWaitMs: Map<RoadId, number>;
  /** Worst peak ever seen across all approaches (ms). */
  worstPeakWaitMs: number;
  /** The approach that produced worstPeakWaitMs (first to reach it wins ties). */
  worstPeakRoadId: RoadId | null;
}

export function createApproachStats(): ApproachStats {
  return {
    current: new Map(),
    peakWaitMs: new Map(),
    worstPeakWaitMs: 0,
    worstPeakRoadId: null,
  };
}

/**
 * Samples the current queues and folds them into the historical peaks.
 * Pending vehicles have no road yet and therefore no approach; only queued
 * vehicles (blocked at a road end) count as an approach queue.
 */
export function updateApproachStats(
  stats: ApproachStats,
  city: City,
  state: TrafficState,
): void {
  const counts = new Map<RoadId, number>();
  const waits = new Map<RoadId, number>();
  for (const vehicle of state.vehicles) {
    if (vehicle.state !== "queued" || vehicle.roadId === null) {
      continue;
    }
    const roadId = vehicle.roadId;
    counts.set(roadId, (counts.get(roadId) ?? 0) + 1);
    const previous = waits.get(roadId) ?? 0;
    if (vehicle.waitTimeMs > previous) {
      waits.set(roadId, vehicle.waitTimeMs);
    }
  }
  const current = new Map<RoadId, ApproachQueueStats>();
  for (const [roadId, queued] of counts) {
    const maxWaitMs = waits.get(roadId) ?? 0;
    const road = city.roads[roadId];
    const occupancyRatio = road.capacity > 0 ? (state.occupancy.get(roadId) ?? 0) / road.capacity : 0;
    current.set(roadId, { queued, maxWaitMs, occupancyRatio });
    const peak = stats.peakWaitMs.get(roadId) ?? 0;
    if (maxWaitMs > peak) {
      stats.peakWaitMs.set(roadId, maxWaitMs);
    }
    if (maxWaitMs > stats.worstPeakWaitMs) {
      stats.worstPeakWaitMs = maxWaitMs;
      stats.worstPeakRoadId = roadId;
    }
  }
  stats.current = current;
}
