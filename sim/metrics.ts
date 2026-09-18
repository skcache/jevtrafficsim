/**
 * Core metrics (PRD §14) — accumulated from explicit simulation ticks.
 *
 * Definitions (fixed once, used consistently):
 * - TRIP performance uses the COMPLETED population: every arrival is recorded
 *   exactly once at the moment it happens, so trip statistics are stable for
 *   any run length.
 * - WAIT pressure uses the ENTIRE successfully spawned population (pending,
 *   moving, queued and arrived vehicles currently in TrafficState): each
 *   vehicle's current waitTimeMs feeds average/P95/max, so a badly starved
 *   vehicle that has not arrived yet still shows up. Failed route requests
 *   that never became vehicles do not belong to the wait population.
 * - P95 wait uses the nearest-rank definition: sort the waits, take index
 *   ceil(0.95 * n) - 1. Empty population -> 0.
 * - Throughput = completed trips / (simulated time in minutes).
 * - Gridlock ratio is VEHICLE-TIME weighted:
 *       totalBlockedVehicleTime / totalActiveVehicleTime
 *   where each post-step sample adds activeCount * dtMs to the active total
 *   and blockedCount * dtMs to the blocked total ("blocked" = queued or
 *   pending at tick end; "active" = spawned and not yet arrived). This weights
 *   ticks by how many vehicles were actually exposed to conditions. No active
 *   vehicle time at all -> 0. Per-tick ratios are never averaged.
 * - averageRoadOccupancy = per-tick total occupancy units divided by the
 *   number of directed roads, averaged over ticks; maxRoadOccupancy is the
 *   peak units seen on any single directed road.
 * - maxApproachWaitMs = peak over the run of the maximum queue wait on any
 *   single approach (directed incoming road) — the approach-level starvation
 *   watch of PRD §11.4, and the policy input later controllers consume.
 * - signalPhaseChanges counts stage/group transitions across all signals.
 */
import type { City, IntersectionId, RoadId, VehicleId } from "./types";
import type { TrafficState } from "./traffic";

export interface ArrivalRecord {
  readonly vehicleId: VehicleId;
  readonly tripTimeMs: number;
  readonly waitTimeMs: number;
  readonly routeDistance: number;
}

export interface SimulationMetrics {
  readonly simulatedTimeMs: number;
  readonly completedTrips: number;
  readonly averageTripTimeMs: number;
  readonly averageWaitTimeMs: number;
  readonly p95WaitTimeMs: number;
  readonly maxWaitTimeMs: number;
  readonly throughputPerMinute: number;
  readonly gridlockRatio: number;
  readonly averageRoadOccupancy: number;
  readonly maxRoadOccupancy: number;
  readonly averageRouteDistance: number;
  /** Peak over the run of the max queue wait on any single approach (ms). */
  readonly maxApproachWaitMs: number;
  readonly signalPhaseChanges: number;
  readonly failedSpawns: number;
}

export interface MetricsAccumulator {
  arrivals: ArrivalRecord[];
  recordedArrivalIds: Set<VehicleId>;
  ticks: number;
  /** Σ activeCount * dtMs over all samples (vehicle-time exposure). */
  activeVehicleMs: number;
  /** Σ blockedCount * dtMs over all samples (vehicle-time blocked). */
  blockedVehicleMs: number;
  occupancyPerTickSum: number;
  maxRoadOccupancy: number;
  maxApproachWaitMs: number;
  roadCount: number;
  signalPhaseChanges: number;
  previousSignals: Map<IntersectionId, string>;
  failedSpawns: number;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const value of values) {
    sum += value;
  }
  return sum / values.length;
}

/** Nearest-rank percentile: sorts a copy, index ceil(fraction * n) - 1. */
export function percentile(values: readonly number[], fraction: number): number {
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1) {
    throw new RangeError(`percentile fraction must be within [0, 1], received ${fraction}`);
  }
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[rank];
}

export function throughputPerMinute(completedTrips: number, simulatedTimeMs: number): number {
  if (simulatedTimeMs <= 0) {
    return 0;
  }
  return completedTrips / (simulatedTimeMs / 60_000);
}

export function createMetricsAccumulator(): MetricsAccumulator {
  return {
    arrivals: [],
    recordedArrivalIds: new Set(),
    ticks: 0,
    activeVehicleMs: 0,
    blockedVehicleMs: 0,
    occupancyPerTickSum: 0,
    maxRoadOccupancy: 0,
    maxApproachWaitMs: 0,
    roadCount: 0,
    signalPhaseChanges: 0,
    previousSignals: new Map(),
    failedSpawns: 0,
  };
}

/** Records one arrival exactly once (idempotent per vehicle id). */
export function recordArrival(accumulator: MetricsAccumulator, record: ArrivalRecord): void {
  if (accumulator.recordedArrivalIds.has(record.vehicleId)) {
    return;
  }
  accumulator.recordedArrivalIds.add(record.vehicleId);
  accumulator.arrivals.push(record);
}

/**
 * Samples congestion, occupancy and signal transitions at the end of a tick.
 * The step duration is explicit: vehicle-time exposure is accumulated as
 * count * dtMs per sample.
 */
export function recordTick(
  accumulator: MetricsAccumulator,
  city: City,
  state: TrafficState,
  dtMs: number,
): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    throw new RangeError(`dtMs must be a finite positive number, received ${dtMs}`);
  }
  accumulator.ticks += 1;
  accumulator.roadCount = city.roads.length;
  let active = 0;
  let blocked = 0;
  const approachWaits = new Map<RoadId, number>();
  for (const vehicle of state.vehicles) {
    if (vehicle.state === "arrived") {
      continue;
    }
    active += 1;
    if (vehicle.state === "queued" || vehicle.state === "pending") {
      blocked += 1;
    }
    if (vehicle.state === "queued" && vehicle.roadId !== null) {
      const previous = approachWaits.get(vehicle.roadId) ?? 0;
      if (vehicle.waitTimeMs > previous) {
        approachWaits.set(vehicle.roadId, vehicle.waitTimeMs);
      }
    }
  }
  accumulator.activeVehicleMs += active * dtMs;
  accumulator.blockedVehicleMs += blocked * dtMs;
  for (const wait of approachWaits.values()) {
    if (wait > accumulator.maxApproachWaitMs) {
      accumulator.maxApproachWaitMs = wait;
    }
  }
  let units = 0;
  for (const value of state.occupancy.values()) {
    units += value;
    if (value > accumulator.maxRoadOccupancy) {
      accumulator.maxRoadOccupancy = value;
    }
  }
  accumulator.occupancyPerTickSum += units;
  for (const [intersectionId, signal] of state.signals) {
    const marker = `${signal.stage}|${signal.phaseIndex}`;
    const previous = accumulator.previousSignals.get(intersectionId);
    if (previous !== undefined && previous !== marker) {
      accumulator.signalPhaseChanges += 1;
    }
    accumulator.previousSignals.set(intersectionId, marker);
  }
}

/** Finalizes the accumulator into a reportable metrics object. */
export function computeMetrics(
  accumulator: MetricsAccumulator,
  state: TrafficState,
): SimulationMetrics {
  const tripTimes = accumulator.arrivals.map((arrival) => arrival.tripTimeMs);
  // Wait pressure covers the whole spawned population, not only arrivals.
  const waits = state.vehicles.map((vehicle) => vehicle.waitTimeMs);
  const distances = accumulator.arrivals.map((arrival) => arrival.routeDistance);
  let maxWaitTimeMs = 0;
  for (const wait of waits) {
    if (wait > maxWaitTimeMs) {
      maxWaitTimeMs = wait;
    }
  }
  return {
    simulatedTimeMs: state.timeMs,
    completedTrips: accumulator.arrivals.length,
    averageTripTimeMs: mean(tripTimes),
    averageWaitTimeMs: mean(waits),
    p95WaitTimeMs: percentile(waits, 0.95),
    maxWaitTimeMs,
    throughputPerMinute: throughputPerMinute(accumulator.arrivals.length, state.timeMs),
    gridlockRatio:
      accumulator.activeVehicleMs > 0
        ? accumulator.blockedVehicleMs / accumulator.activeVehicleMs
        : 0,
    averageRoadOccupancy:
      accumulator.ticks > 0 && accumulator.roadCount > 0
        ? accumulator.occupancyPerTickSum / accumulator.ticks / accumulator.roadCount
        : 0,
    maxRoadOccupancy: accumulator.maxRoadOccupancy,
    averageRouteDistance: mean(distances),
    maxApproachWaitMs: accumulator.maxApproachWaitMs,
    signalPhaseChanges: accumulator.signalPhaseChanges,
    failedSpawns: accumulator.failedSpawns,
  };
}
