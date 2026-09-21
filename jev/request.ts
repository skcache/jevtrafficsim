/**
 * Building the request Jev sees (Issue #13).
 *
 * One compact, bounded, citywide document per refresh — never per tick, never
 * per vehicle, never one call per intersection. The frame is the engine's own
 * observation frame (`sim/observations.ts`), so Jev reads exactly the state the
 * Adaptive controller reads, aggregated a level up.
 *
 * ## What is deliberately absent
 *
 * There is no ego vehicle id, no route, no destination, no "prioritize this
 * car" channel — and no vehicle-level field of any kind. Every value here is an
 * aggregate over approaches, corridors, regions or signals, which is why the
 * visible trip cannot be privileged through this adapter even by accident. The
 * trip is measured by the challenge harness, after the fact; it is never an
 * input to the policy.
 *
 * ## Bounds
 *
 * Corridors, regions and hotspots are capped (`JEV_LIMITS`), and the busiest
 * are kept first, so the request stays the same size on a quiet and a jammed
 * city. A policy may only reference ids the request carried.
 */
import type { ObservationFrame } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import type { RoadId } from "@/sim/types";
import {
  JEV_LIMITS,
  JEV_SCHEMA_VERSION,
  type JevCorridorSummary,
  type JevPolicyRequest,
  type JevRegionSummary,
  type JevSignalSummary,
} from "./schema";

export interface JevRequestInput {
  readonly frame: ObservationFrame;
  readonly partition: CityPartition;
  /** Citywide total intersections (signalized or not). */
  readonly intersections: number;
  /** Vehicles currently in the world, as a count — no identities. */
  readonly activeVehicles: number;
}

export interface JevRequestOptions {
  readonly maxCorridors?: number;
  readonly maxRegions?: number;
  readonly maxHotspots?: number;
}

/**
 * Ordering score for the "busiest first" lists. Ordering only: it never enters
 * a request's values and never becomes policy.
 */
function busyScore(queuedVehicles: number, maxWaitMs: number, arrivalRatePerSecond: number): number {
  return queuedVehicles + maxWaitMs / 30_000 + arrivalRatePerSecond * 2;
}

/** A summary without its ordering score (the score is ordering-only). */
function withoutScore<T extends { readonly score: number }>(entry: T): Omit<T, "score"> {
  const copy: Record<string, unknown> = { ...entry };
  delete copy.score;
  return copy as Omit<T, "score">;
}

/** Deterministic rounding, so the request stays compact and diff-stable. */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

interface Totals {
  queuedVehicles: number;
  maxWaitMs: number;
  arrivalRatePerSecond: number;
  occupancyRatio: number;
}

const EMPTY_TOTALS: Totals = {
  queuedVehicles: 0,
  maxWaitMs: 0,
  arrivalRatePerSecond: 0,
  occupancyRatio: 0,
};

function accumulate(totals: Totals, queued: number, waitMs: number, rate: number, occupancy: number): Totals {
  return {
    queuedVehicles: totals.queuedVehicles + queued,
    maxWaitMs: Math.max(totals.maxWaitMs, waitMs),
    arrivalRatePerSecond: totals.arrivalRatePerSecond + rate,
    occupancyRatio: Math.max(totals.occupancyRatio, occupancy),
  };
}

/** Every approach road an intersection serves, in phase order. */
function intersectionApproaches(frame: ObservationFrame): ReadonlyMap<number, readonly RoadId[]> {
  const approaches = new Map<number, RoadId[]>();
  for (const [intersectionId, observation] of frame.intersections) {
    const roads: RoadId[] = [];
    for (const phase of observation.phases) {
      for (const roadId of phase.roads) {
        roads.push(roadId);
      }
    }
    approaches.set(intersectionId, roads);
  }
  return approaches;
}

/** Distinct signalized intersections each corridor serves (approach roads). */
function corridorIntersectionCounts(
  input: JevRequestInput,
  approachRoads: ReadonlyMap<number, readonly RoadId[]>,
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const [, roads] of approachRoads) {
    const corridors = new Set<number>();
    for (const roadId of roads) {
      for (const corridorId of input.partition.roadCorridors.get(roadId) ?? []) {
        corridors.add(corridorId);
      }
    }
    for (const corridorId of corridors) {
      counts.set(corridorId, (counts.get(corridorId) ?? 0) + 1);
    }
  }
  return counts;
}

function summarizeCorridors(
  input: JevRequestInput,
  approachRoads: ReadonlyMap<number, readonly RoadId[]>,
  maxCorridors: number,
): JevCorridorSummary[] {
  const { frame, partition } = input;
  const intersectionCounts = corridorIntersectionCounts(input, approachRoads);
  const summaries: (JevCorridorSummary & { readonly score: number })[] = [];
  for (const corridor of partition.corridors) {
    let totals = EMPTY_TOTALS;
    for (const roadId of corridor.roadIds) {
      const observation = frame.approaches.get(roadId);
      if (!observation) {
        continue;
      }
      totals = accumulate(
        totals,
        observation.queuedVehicles,
        observation.maxWaitMs,
        observation.arrivalRatePerSecond,
        observation.approachOccupancyRatio,
      );
    }
    summaries.push({
      corridorId: corridor.corridorId,
      kind: corridor.kind,
      intersections: intersectionCounts.get(corridor.corridorId) ?? 0,
      queuedVehicles: totals.queuedVehicles,
      maxWaitMs: Math.round(totals.maxWaitMs),
      arrivalRatePerSecond: round(totals.arrivalRatePerSecond, 3),
      occupancyRatio: round(totals.occupancyRatio, 3),
      score: busyScore(totals.queuedVehicles, totals.maxWaitMs, totals.arrivalRatePerSecond),
    });
  }
  return summaries
    .sort((a, b) => b.score - a.score || a.corridorId - b.corridorId)
    .slice(0, maxCorridors)
    .sort((a, b) => a.corridorId - b.corridorId)
    .map(withoutScore);
}

function summarizeRegions(
  input: JevRequestInput,
  approachRoads: ReadonlyMap<number, readonly RoadId[]>,
  maxRegions: number,
): JevRegionSummary[] {
  const { frame, partition } = input;
  const summaries: (JevRegionSummary & { readonly score: number })[] = [];
  for (const region of partition.regions) {
    let totals = EMPTY_TOTALS;
    let signalized = 0;
    for (const intersectionId of region.intersectionIds) {
      const observation = frame.intersections.get(intersectionId);
      if (!observation) {
        continue;
      }
      signalized += 1;
      for (const roadId of approachRoads.get(intersectionId) ?? []) {
        const approach = frame.approaches.get(roadId);
        if (!approach) {
          continue;
        }
        totals = accumulate(
          totals,
          approach.queuedVehicles,
          approach.maxWaitMs,
          approach.arrivalRatePerSecond,
          approach.approachOccupancyRatio,
        );
      }
    }
    summaries.push({
      regionId: region.regionId,
      intersections: region.intersectionIds.length,
      signalizedIntersections: signalized,
      queuedVehicles: totals.queuedVehicles,
      maxWaitMs: Math.round(totals.maxWaitMs),
      arrivalRatePerSecond: round(totals.arrivalRatePerSecond, 3),
      occupancyRatio: round(totals.occupancyRatio, 3),
      score: busyScore(totals.queuedVehicles, totals.maxWaitMs, totals.arrivalRatePerSecond),
    });
  }
  return summaries
    .sort((a, b) => b.score - a.score || a.regionId - b.regionId)
    .slice(0, maxRegions)
    .sort((a, b) => a.regionId - b.regionId)
    .map(withoutScore);
}

function summarizeHotspots(input: JevRequestInput, maxHotspots: number): JevSignalSummary[] {
  const { frame, partition } = input;
  const summaries: (JevSignalSummary & { readonly score: number })[] = [];
  for (const [intersectionId, observation] of frame.intersections) {
    let queuedVehicles = 0;
    let maxWaitMs = 0;
    let arrivalRatePerSecond = 0;
    let occupancyRatio = 0;
    let downstreamOccupancyRatio = 0;
    for (const phase of observation.phases) {
      queuedVehicles += phase.queuedVehicles;
      maxWaitMs = Math.max(maxWaitMs, phase.maxWaitMs);
      arrivalRatePerSecond += phase.arrivalRatePerSecond;
      occupancyRatio = Math.max(occupancyRatio, phase.occupancyRatio);
      downstreamOccupancyRatio = Math.max(downstreamOccupancyRatio, phase.downstreamOccupancyRatio);
    }
    summaries.push({
      intersectionId,
      regionId: partition.intersectionRegion.get(intersectionId) ?? -1,
      stage: observation.stage,
      phaseIndex: observation.phaseIndex,
      phaseCount: observation.phaseCount,
      stageElapsedMs: Math.round(observation.stageElapsedMs),
      queuedVehicles,
      maxWaitMs: Math.round(maxWaitMs),
      arrivalRatePerSecond: round(arrivalRatePerSecond, 3),
      occupancyRatio: round(occupancyRatio, 3),
      downstreamOccupancyRatio: round(downstreamOccupancyRatio, 3),
      score: busyScore(queuedVehicles, maxWaitMs, arrivalRatePerSecond),
    });
  }
  return summaries
    .sort((a, b) => b.score - a.score || a.intersectionId - b.intersectionId)
    .slice(0, maxHotspots)
    .sort((a, b) => a.intersectionId - b.intersectionId)
    .map(withoutScore);
}

/**
 * Build one bounded request. Pure and deterministic: identical inputs produce
 * an identical document, so a recorded request can be replayed against a mock
 * adapter and produce identical policy.
 */
export function buildJevPolicyRequest(
  input: JevRequestInput,
  options: JevRequestOptions = {},
): JevPolicyRequest {
  const approachRoads = intersectionApproaches(input.frame);
  const maxCorridors = options.maxCorridors ?? JEV_LIMITS.REQUEST_CORRIDORS;
  const maxRegions = options.maxRegions ?? JEV_LIMITS.REQUEST_REGIONS;
  const maxHotspots = options.maxHotspots ?? JEV_LIMITS.REQUEST_HOTSPOTS;

  let city = EMPTY_TOTALS;
  for (const [, observation] of input.frame.approaches) {
    city = accumulate(
      city,
      observation.queuedVehicles,
      observation.maxWaitMs,
      observation.arrivalRatePerSecond,
      observation.approachOccupancyRatio,
    );
  }

  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: Math.round(input.frame.timeMs),
    windowMs: input.frame.windowMs,
    city: {
      intersections: input.intersections,
      signalizedIntersections: input.frame.intersections.size,
      activeVehicles: input.activeVehicles,
      queuedVehicles: city.queuedVehicles,
      maxWaitMs: Math.round(city.maxWaitMs),
      arrivalRatePerSecond: round(city.arrivalRatePerSecond, 3),
    },
    corridors: summarizeCorridors(input, approachRoads, maxCorridors),
    regions: summarizeRegions(input, approachRoads, maxRegions),
    hotspots: summarizeHotspots(input, maxHotspots),
  };
}

/** Ids a policy may reference, taken from the request it answers. */
export function jevPolicyContext(request: JevPolicyRequest): {
  corridorIds: number[];
  regionIds: number[];
} {
  return {
    corridorIds: request.corridors.map((corridor) => corridor.corridorId),
    regionIds: request.regions.map((region) => region.regionId),
  };
}
