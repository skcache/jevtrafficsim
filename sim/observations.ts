/**
 * Deterministic observations (Task 09, PRD §12.3-§12.4): the read-only view of
 * the world that policy controllers consume through the engine-owned
 * controller context. Framework-free, timer-free, RNG-free.
 *
 * ## Approach-arrival events
 *
 * An "approach arrival" is one MOVING vehicle reaching the end of its current
 * road while its route continues: the moment that vehicle presents demand to
 * that road end. It is recorded exactly once per (vehicle, road end, passage):
 *
 * - a vehicle that sails through on green records one event;
 * - a vehicle that must queue records one event (the same one);
 * - queued retries inside the queue phase are NOT new arrivals and never
 *   report again;
 * - the final trip arrival (no next road) is not signal demand and records
 *   nothing;
 * - a vehicle crossing several road ends inside one timestep (leftover
 *   distance) records one legitimate event per road end.
 *
 * The traffic layer reports events through the optional per-step callback
 * `TrafficStepOptions.onApproachArrival`; the ENGINE owns the rolling history
 * (window `APPROACH_ARRIVAL_WINDOW_MS`, default 5 simulated seconds) and no
 * controller ever keeps private timing state.
 *
 * `arrivalRatePerSecond = eventsInWindow / windowSeconds`, where the window
 * is `(now - windowMs, now]` in simulated time. Early in a run the window is
 * naturally truncated but the divisor stays the full window width — rates
 * ramp up honestly instead of being scaled by an unknown run prefix.
 *
 * ## Observation shapes
 *
 * The per-approach shape is the reusable primitive for Adaptive (today) and
 * Jev (later): queue depth, CONTINUOUS queue wait (Task 08 semantics — never
 * the vehicle's lifetime wait), rolling arrival rate, the approach road's own
 * occupancy ratio, and the worst intended-downstream occupancy ratio.
 *
 * Downstream ratio: for every vehicle moving on or queued at an approach, its
 * intended next road comes from its route (`route[routeIndex + 1]`); the ratio
 * of that next road's occupancy to its capacity is computed per vehicle and
 * the approach reports the MAX over those intentions. Max is the documented
 * aggregation rule: policy cares about the worst exit, because a green feeding
 * one saturated downstream wastes its service no matter how good the average
 * looks. A vehicle without a next road (final leg) contributes nothing.
 *
 * ## Cost
 *
 * `buildObservationFrame` is one O(V) pass over vehicles (queue / wait /
 * downstream intentions), then map lookups: per-approach assembly is
 * O(active approaches) and phase aggregation is O(signals x groups). Nothing
 * scans all vehicles per intersection, and the static region/corridor
 * partition is built once per engine (see sim/regions.ts).
 */
import { currentQueueWaitMs } from "./approach-stats";
import type { SignalStage } from "./signals";
import { roadOccupancy, type TrafficState } from "./traffic";
import type { City, IntersectionId, RoadId } from "./types";

/** Rolling window width for approach arrival rates, in simulated ms. */
export const APPROACH_ARRIVAL_WINDOW_MS = 5_000;

interface ApproachArrivalEvent {
  readonly timeMs: number;
  readonly roadId: RoadId;
}

/**
 * Rolling arrival history owned by the engine. `events` is an append-only log
 * in non-decreasing time order with a moving `head`, so expiry is O(1) per
 * dropped event and `counts` is always the live in-window tally.
 */
export interface ApproachArrivalTracker {
  readonly windowMs: number;
  readonly events: ApproachArrivalEvent[];
  head: number;
  readonly counts: Map<RoadId, number>;
}

export function createApproachArrivalTracker(
  windowMs: number = APPROACH_ARRIVAL_WINDOW_MS,
): ApproachArrivalTracker {
  if (!Number.isFinite(windowMs) || windowMs <= 0) {
    throw new RangeError(`windowMs must be finite and positive, received ${windowMs}`);
  }
  return { windowMs, events: [], head: 0, counts: new Map() };
}

/**
 * Drops events that fell out of the rolling window `(now - windowMs, now]`.
 * An event exactly `windowMs` old is out (window is half-open at the old end).
 */
export function expireApproachArrivals(tracker: ApproachArrivalTracker, nowMs: number): void {
  const cutoff = nowMs - tracker.windowMs;
  while (tracker.head < tracker.events.length && tracker.events[tracker.head].timeMs <= cutoff) {
    const event = tracker.events[tracker.head];
    tracker.head += 1;
    const remaining = (tracker.counts.get(event.roadId) ?? 0) - 1;
    if (remaining > 0) {
      tracker.counts.set(event.roadId, remaining);
    } else {
      tracker.counts.delete(event.roadId);
    }
  }
  if (tracker.head > 4096) {
    tracker.events.splice(0, tracker.head);
    tracker.head = 0;
  }
}

/** Records one approach arrival at `timeMs` (caller = traffic movement phase). */
export function recordApproachArrival(
  tracker: ApproachArrivalTracker,
  timeMs: number,
  roadId: RoadId,
): void {
  if (!Number.isFinite(timeMs)) {
    throw new RangeError(`timeMs must be finite, received ${timeMs}`);
  }
  expireApproachArrivals(tracker, timeMs);
  tracker.events.push({ timeMs, roadId });
  tracker.counts.set(roadId, (tracker.counts.get(roadId) ?? 0) + 1);
}

/** Rolling arrival rate for one approach (events in window / windowSeconds). */
export function approachArrivalRatePerSecond(
  tracker: ApproachArrivalTracker,
  roadId: RoadId,
): number {
  return (tracker.counts.get(roadId) ?? 0) / (tracker.windowMs / 1000);
}

/** Reusable per-approach observation (Adaptive today, Jev later). */
export interface ApproachObservation {
  readonly roadId: RoadId;
  /** Vehicles currently queued at this approach's road end. */
  readonly queuedVehicles: number;
  /** Largest CONTINUOUS queue wait at this approach (ms, Task 08 semantics). */
  readonly maxWaitMs: number;
  /** Rolling arrivals in the observation window, per second. */
  readonly arrivalRatePerSecond: number;
  /** Occupancy ratio (units / capacity) of the approach road itself. */
  readonly approachOccupancyRatio: number;
  /** MAX occupancy ratio among intended next roads of vehicles on this approach. */
  readonly downstreamOccupancyRatio: number;
}

/** Per-phase (ring group) aggregate, derived from approach observations. */
export interface PhaseObservation {
  readonly phaseIndex: number;
  readonly roads: readonly RoadId[];
  /** Sum of member approach queues. */
  readonly queuedVehicles: number;
  /** Max CONTINUOUS queue wait across member approaches (ms). */
  readonly maxWaitMs: number;
  /** Sum of member approach arrival rates (vehicles / s). */
  readonly arrivalRatePerSecond: number;
  /** Max member approach occupancy ratio. */
  readonly occupancyRatio: number;
  /** Max member approach downstream ratio (worst intended exit). */
  readonly downstreamOccupancyRatio: number;
}

export interface IntersectionObservation {
  readonly intersectionId: IntersectionId;
  readonly stage: SignalStage;
  /** Ring index of the phase currently green / clearing. */
  readonly phaseIndex: number;
  /** How long the current stage has run (phase age, ms). */
  readonly stageElapsedMs: number;
  readonly phaseCount: number;
  /** Ring-ordered phase aggregates; index === phase index. */
  readonly phases: readonly PhaseObservation[];
}

/** One deterministic frame of observations for the current traffic state. */
export interface ObservationFrame {
  readonly timeMs: number;
  readonly windowMs: number;
  /** Activity-bearing approaches only (queue, intentions or arrivals). */
  readonly approaches: ReadonlyMap<RoadId, ApproachObservation>;
  /** Every signalized intersection, ascending by id. */
  readonly intersections: ReadonlyMap<IntersectionId, IntersectionObservation>;
}

/**
 * Builds the frame: one vehicle pass, then per-approach assembly and phase
 * aggregation from maps. Deterministic for identical (city, traffic, tracker)
 * inputs; no allocation order leaks into the result (everything ascending).
 */
export function buildObservationFrame(
  city: City,
  traffic: TrafficState,
  tracker: ApproachArrivalTracker,
): ObservationFrame {
  expireApproachArrivals(tracker, traffic.timeMs);

  const queued = new Map<RoadId, number>();
  const waits = new Map<RoadId, number>();
  const downstream = new Map<RoadId, number>();
  const active = new Set<RoadId>();

  for (const vehicle of traffic.vehicles) {
    if (vehicle.state !== "moving" && vehicle.state !== "queued") {
      continue;
    }
    const roadId = vehicle.roadId;
    if (roadId === null) {
      continue;
    }
    active.add(roadId);
    const nextRoadId = vehicle.route[vehicle.routeIndex + 1];
    if (nextRoadId !== undefined) {
      const nextRoad = city.roads[nextRoadId];
      if (nextRoad && nextRoad.capacity > 0) {
        const ratio = roadOccupancy(traffic, nextRoadId) / nextRoad.capacity;
        const previous = downstream.get(roadId);
        if (previous === undefined || ratio > previous) {
          downstream.set(roadId, ratio);
        }
      }
    }
    if (vehicle.state === "queued") {
      queued.set(roadId, (queued.get(roadId) ?? 0) + 1);
      const wait = currentQueueWaitMs(traffic.timeMs, vehicle.queuedSinceMs);
      const previous = waits.get(roadId);
      if (previous === undefined || wait > previous) {
        waits.set(roadId, wait);
      }
    }
  }
  for (const [roadId, count] of tracker.counts) {
    if (count > 0) {
      active.add(roadId);
    }
  }

  const approaches = new Map<RoadId, ApproachObservation>();
  for (const roadId of [...active].sort((a, b) => a - b)) {
    const road = city.roads[roadId];
    approaches.set(roadId, {
      roadId,
      queuedVehicles: queued.get(roadId) ?? 0,
      maxWaitMs: waits.get(roadId) ?? 0,
      arrivalRatePerSecond: approachArrivalRatePerSecond(tracker, roadId),
      approachOccupancyRatio:
        road && road.capacity > 0 ? roadOccupancy(traffic, roadId) / road.capacity : 0,
      downstreamOccupancyRatio: downstream.get(roadId) ?? 0,
    });
  }

  const intersections = new Map<IntersectionId, IntersectionObservation>();
  const signalIds = [...traffic.signals.keys()].sort((a, b) => a - b);
  for (const intersectionId of signalIds) {
    const signal = traffic.signals.get(intersectionId);
    if (!signal) {
      continue;
    }
    const phases: PhaseObservation[] = signal.groups.map((group, phaseIndex) => {
      let queuedVehicles = 0;
      let maxWaitMs = 0;
      let arrivalRatePerSecond = 0;
      let occupancyRatio = 0;
      let downstreamOccupancyRatio = 0;
      for (const roadId of group) {
        const observation = approaches.get(roadId);
        if (!observation) {
          continue;
        }
        queuedVehicles += observation.queuedVehicles;
        maxWaitMs = Math.max(maxWaitMs, observation.maxWaitMs);
        arrivalRatePerSecond += observation.arrivalRatePerSecond;
        occupancyRatio = Math.max(occupancyRatio, observation.approachOccupancyRatio);
        downstreamOccupancyRatio = Math.max(
          downstreamOccupancyRatio,
          observation.downstreamOccupancyRatio,
        );
      }
      return {
        phaseIndex,
        roads: group,
        queuedVehicles,
        maxWaitMs,
        arrivalRatePerSecond,
        occupancyRatio,
        downstreamOccupancyRatio,
      };
    });
    intersections.set(intersectionId, {
      intersectionId,
      stage: signal.stage,
      phaseIndex: signal.phaseIndex,
      stageElapsedMs: signal.stageElapsedMs,
      phaseCount: signal.groups.length,
      phases,
    });
  }

  return { timeMs: traffic.timeMs, windowMs: tracker.windowMs, approaches, intersections };
}
