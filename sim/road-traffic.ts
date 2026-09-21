/**
 * Authoritative road traffic dynamics (architectural realism pass).
 *
 * ONE state describes how traffic is actually flowing on each road, and
 * EVERYTHING consumes it: vehicle speed, the citywide congestion overlay, the
 * route's traffic colours, and the traffic-aware routing / Local-driver
 * decisions. Before this module each of those re-derived "congestion" from
 * occupancy with its own thresholds, so a road could be painted red while cars
 * crossed it at free-flow speed and the router priced it as empty.
 *
 * The state is a per-road speed factor in [MIN_SPEED_FACTOR, 1]:
 *
 *   1.0  free flow — the road carries traffic at its speed limit
 *   0.5  slower    — queues forming, movement visibly degraded
 *   0.12 severe    — jammed; traffic creeps
 *
 * It evolves in SIMULATION time, and asymmetrically: congestion builds on a
 * short time constant and clears on a much longer one, which is both what real
 * traffic does and what keeps a road from flashing between colours as a single
 * car crosses an intersection. Severity is a pure function of the factor, so
 * presentation and physics can never disagree about what "red" means.
 *
 * Determinism: a pure function of (occupancy, queued vehicles, blocked waits)
 * and the previous factor. No randomness, no wall-clock, no iteration-order
 * dependence (roads are visited in ascending id order).
 */
import type { City, RoadId } from "./types";
import type { TrafficState } from "./traffic";

export type TrafficSeverity = "free" | "slower" | "severe";

/** One place where the meaning of "slow" is defined. */
export const ROAD_TRAFFIC = {
  /** A fully jammed road still creeps; it never becomes a wall. */
  minSpeedFactor: 0.12,
  /** Occupancy ratio below which traffic is free. */
  freeOccupancyRatio: 0.45,
  /** Occupancy ratio at which traffic is treated as fully jammed. */
  severeOccupancyRatio: 0.95,
  /** Queued vehicles (as a share of capacity) that count as jammed. */
  severeQueueShare: 0.6,
  /** Longest blocked wait that counts as jammed. */
  severeWaitMs: 25_000,
  /** Congestion builds quickly... */
  buildTauMs: 5_000,
  /** ...and clears slowly: recovery lag is the anti-flash hysteresis. */
  recoverTauMs: 30_000,
  /** Severity boundaries on the speed factor (single source for all colours). */
  slowerFactor: 0.72,
  severeFactor: 0.42,
} as const;

/**
 * Road traffic state: a SPARSE map of roads that are not free. A road missing
 * from the map is free flow — the same "absent means free" contract the
 * presentation layer already uses.
 */
export interface RoadTraffic {
  readonly factor: Map<RoadId, number>;
}

export function createRoadTraffic(): RoadTraffic {
  return { factor: new Map() };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Target speed factor for a road, from the pressure on it.
 *
 * Pressure is the strongest of three signals: how full the road is, how many
 * vehicles are queued at its end, and how long the worst of them has waited.
 * Occupancy alone misses a road that is technically half-empty but has a
 * blocked queue at its end, which is exactly the road a driver experiences as
 * jammed.
 */
export function targetSpeedFactor(
  occupancyRatio: number,
  queued: number,
  capacity: number,
  maxBlockedWaitMs: number,
): number {
  const ratio = clamp01(occupancyRatio);
  const ratioTerm = clamp01(
    (ratio - ROAD_TRAFFIC.freeOccupancyRatio) /
      (ROAD_TRAFFIC.severeOccupancyRatio - ROAD_TRAFFIC.freeOccupancyRatio),
  );
  const queueTerm =
    capacity > 0 ? clamp01(queued / (capacity * ROAD_TRAFFIC.severeQueueShare)) : 0;
  const waitTerm = clamp01(maxBlockedWaitMs / ROAD_TRAFFIC.severeWaitMs);
  const pressure = Math.max(ratioTerm, queueTerm, waitTerm);
  return 1 - pressure * (1 - ROAD_TRAFFIC.minSpeedFactor);
}

/** Severity of a speed factor. The ONLY mapping from flow to colour. */
export function severityForFactor(factor: number): TrafficSeverity {
  if (factor <= ROAD_TRAFFIC.severeFactor) {
    return "severe";
  }
  if (factor <= ROAD_TRAFFIC.slowerFactor) {
    return "slower";
  }
  return "free";
}

/** Speed factor of a road; a road with no entry is free flow. */
export function roadSpeedFactor(traffic: RoadTraffic, roadId: RoadId): number {
  return traffic.factor.get(roadId) ?? 1;
}

export function roadSeverity(traffic: RoadTraffic, roadId: RoadId): TrafficSeverity {
  return severityForFactor(roadSpeedFactor(traffic, roadId));
}

/**
 * Advance every non-free road one tick toward its target factor.
 *
 * Roads are visited in ascending id order and the easing is exponential, so the
 * result is a pure function of the previous state and this tick's pressure.
 * Entries that have fully recovered are dropped, keeping the map sparse.
 */
export function stepRoadTraffic(state: TrafficState, city: City, dtMs: number): void {
  const { occupancy, vehicles } = state;
  const traffic = state.roadTraffic;

  // One pass over vehicles for the queue signals; O(V) like the metrics pass.
  const queued = new Map<RoadId, number>();
  const worstWait = new Map<RoadId, number>();
  for (const vehicle of vehicles) {
    if (vehicle.roadId === null) {
      continue;
    }
    if (vehicle.state !== "queued") {
      continue;
    }
    queued.set(vehicle.roadId, (queued.get(vehicle.roadId) ?? 0) + 1);
    const since = vehicle.queuedSinceMs;
    if (since !== null) {
      const waited = state.timeMs - since;
      if (waited > (worstWait.get(vehicle.roadId) ?? 0)) {
        worstWait.set(vehicle.roadId, waited);
      }
    }
  }

  // Candidates: roads that are loaded now, plus roads still recovering.
  const candidates = new Set<RoadId>(traffic.factor.keys());
  for (const [roadId, units] of occupancy) {
    if (units > 0) {
      candidates.add(roadId);
    }
  }

  const ids = [...candidates].sort((a, b) => a - b);
  for (const roadId of ids) {
    const road = city.roads[roadId];
    if (!road) {
      continue;
    }
    const units = occupancy.get(roadId) ?? 0;
    const ratio = road.capacity > 0 ? units / road.capacity : 0;
    const target = targetSpeedFactor(
      ratio,
      queued.get(roadId) ?? 0,
      road.capacity,
      worstWait.get(roadId) ?? 0,
    );
    const current = traffic.factor.get(roadId) ?? 1;
    const tau = target < current ? ROAD_TRAFFIC.buildTauMs : ROAD_TRAFFIC.recoverTauMs;
    const k = tau > 0 ? 1 - Math.exp(-Math.max(0, dtMs) / tau) : 1;
    const next = current + (target - current) * k;
    if (next >= 0.999 && target >= 0.999) {
      traffic.factor.delete(roadId);
    } else {
      traffic.factor.set(roadId, next);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Longitudinal motion                                                 */
/* ------------------------------------------------------------------ */

/** Comfortable acceleration and braking, in m/s^2. */
export const ACCEL_MPS2 = 2.2;
export const DECEL_MPS2 = 3.6;

/**
 * Highest speed from which a vehicle can still stop within `distanceM`.
 *
 * This is the whole braking model: instead of teleporting from free-flow to
 * parked at the stop line, a vehicle's target speed is capped by what its
 * brakes can actually achieve over the distance that is left.
 */
export function brakingLimitSpeed(distanceM: number, decelMps2 = DECEL_MPS2): number {
  if (!(distanceM > 0)) {
    return 0;
  }
  return Math.sqrt(2 * decelMps2 * distanceM);
}

/** Approach a target speed with bounded acceleration and braking. */
export function approachSpeed(
  currentMps: number,
  targetMps: number,
  dtSeconds: number,
  accelMps2 = ACCEL_MPS2,
  decelMps2 = DECEL_MPS2,
): number {
  const dt = Math.max(0, dtSeconds);
  const desired = Math.max(0, targetMps);
  if (desired > currentMps) {
    return Math.min(desired, currentMps + accelMps2 * dt);
  }
  return Math.max(desired, currentMps - decelMps2 * dt);
}
