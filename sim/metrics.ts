/**
 * Core metrics (PRD §14) — accumulated from explicit simulation ticks.
 *
 * Definitions (fixed once, used consistently):
 * - Trip/wait statistics come from COMPLETED vehicles only: every arrival is
 *   recorded exactly once at the moment it happens, so the numbers are stable
 *   for any run length. Vehicles still en route at run end are excluded.
 * - P95 wait uses the nearest-rank definition: sort the waits, take index
 *   ceil(0.95 * n) - 1. Empty population -> 0.
 * - Throughput = completed trips / (simulated time in minutes).
 * - Gridlock ratio = time-average of blocked/active over every tick that had
 *   at least one active (non-arrived) vehicle, where "blocked" means queued or
 *   pending at tick end (i.e. unable to advance due to signal/capacity/entry
 *   constraints). No active vehicles at all -> 0.
 * - averageRoadOccupancy = per-tick total occupancy units divided by the
 *   number of directed roads, averaged over ticks; maxRoadOccupancy is the
 *   peak units seen on any single directed road.
 * - signalPhaseChanges counts stage/group transitions across all signals.
 */
import type { City, IntersectionId, VehicleId } from "./types";
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
  readonly signalPhaseChanges: number;
  readonly failedSpawns: number;
}

export interface MetricsAccumulator {
  arrivals: ArrivalRecord[];
  recordedArrivalIds: Set<VehicleId>;
  ticks: number;
  congestionSampleTicks: number;
  congestionRatioSum: number;
  occupancyPerTickSum: number;
  maxRoadOccupancy: number;
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
    congestionSampleTicks: 0,
    congestionRatioSum: 0,
    occupancyPerTickSum: 0,
    maxRoadOccupancy: 0,
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

/** Samples congestion, occupancy and signal transitions at the end of a tick. */
export function recordTick(
  accumulator: MetricsAccumulator,
  city: City,
  state: TrafficState,
): void {
  accumulator.ticks += 1;
  accumulator.roadCount = city.roads.length;
  let active = 0;
  let blocked = 0;
  for (const vehicle of state.vehicles) {
    if (vehicle.state === "arrived") {
      continue;
    }
    active += 1;
    if (vehicle.state === "queued" || vehicle.state === "pending") {
      blocked += 1;
    }
  }
  if (active > 0) {
    accumulator.congestionSampleTicks += 1;
    accumulator.congestionRatioSum += blocked / active;
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
  const waits = accumulator.arrivals.map((arrival) => arrival.waitTimeMs);
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
      accumulator.congestionSampleTicks > 0
        ? accumulator.congestionRatioSum / accumulator.congestionSampleTicks
        : 0,
    averageRoadOccupancy:
      accumulator.ticks > 0 && accumulator.roadCount > 0
        ? accumulator.occupancyPerTickSum / accumulator.ticks / accumulator.roadCount
        : 0,
    maxRoadOccupancy: accumulator.maxRoadOccupancy,
    averageRouteDistance: mean(distances),
    signalPhaseChanges: accumulator.signalPhaseChanges,
    failedSpawns: accumulator.failedSpawns,
  };
}
