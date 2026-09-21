/**
 * Deterministic demand generation (Task 08, PRD §5 + §15.1).
 *
 * A demand level is a per-size target of ACTIVE vehicles. Because a vehicle
 * stays active for roughly one average trip, the spawn rate that sustains the
 * target is `targetActive / estimatedTripMs`; the estimator routes a small,
 * deterministic sample of OD pairs with free-flow A* costs, so the whole
 * generator is a pure function of (city, level, seed, durationMs).
 *
 * Under congestion trips take longer than the free-flow estimate, so active
 * counts drift above the target — that is intended: higher levels load the
 * network harder and congestion compounds, which is exactly what makes the
 * three levels feel different at equal city size.
 *
 * Randomness is split into independent named streams under the run seed's
 * `traffic` fork (PRD architecture: each subsystem owns a fork, and `rng.ts`
 * derives forks from the root seed + label alone):
 * - `calibration` is consumed only by the free-flow trip estimator;
 * - `od` is consumed only by the generated origin/destination pairs;
 * - `classes` is consumed only by vehicle-type selection.
 * Because the streams never share a cursor, adding or changing draws in one
 * subsystem can never desynchronize another (spawn timing is pure interval
 * math and consumes no randomness at all). Spawn times are exact interval
 * multiples and may fall between ticks (dense rush demand needs several
 * vehicles per 100 ms tick at large sizes): the engine's documented
 * snap-forward semantics place each vehicle on the first tick whose time
 * reaches it, preserving schedule order. Origin/destination are uniformly
 * sampled and never equal; the class mix per level is defined in config
 * (TRAFFIC_LEVEL_TYPE_MIX).
 *
 * Asymmetric OD flows (PRD §15.3 rush-hour scenarios) are a benchmark concern
 * for later tasks — V1 demand is uniform.
 */
import { findRoute } from "./astar";
import { TRAFFIC_LEVEL_TARGETS, TRAFFIC_LEVEL_TYPE_MIX } from "./config";
import { createRng, type Rng } from "./rng";
import { DEMAND_SHAPES, SHAPE_TOURNAMENT, demandShape, shapeContext, type DemandShapeName } from "./demand-shape";
import type { ScheduledSpawn } from "./engine";
import type { City, TrafficLevel, VehicleType } from "./types";

export interface DemandOptions {
  readonly city: City;
  readonly level: TrafficLevel;
  /** Run seed; demand derives its own deterministic stream from it. */
  readonly seed: number;
  /** Demand horizon in simulated milliseconds. */
  readonly durationMs: number;
  /**
   * Volume multiplier on the level's active-vehicle target (default 1). Scaling
   * the target shortens the spawn interval, so a larger multiplier is a strict
   * SUPERSET of the smaller one's schedule: the same vehicles in the same order,
   * with more of them. That makes calibration sweeps comparable at the sample
   * level rather than only in aggregate.
   */
  readonly multiplier?: number;
  /**
   * Deterministic OD shape (default "uniform", which is the original single-draw
   * path byte for byte). See sim/demand-shape.ts for what each shape stresses.
   */
  readonly shape?: DemandShapeName;
}

/** OD pairs sampled to estimate the average trip duration (free-flow). */
const OD_SAMPLE_COUNT = 16;

/** Fallback estimate when no sampled pair is routable. */
const FALLBACK_TRIP_MS = 30_000;

function estimateAverageTripMs(city: City, rng: Rng): number {
  const count = city.intersections.length;
  let totalMs = 0;
  let found = 0;
  for (let i = 0; i < OD_SAMPLE_COUNT; i += 1) {
    const from = rng.nextInt(0, count - 1);
    const to = rng.nextInt(0, count - 1);
    if (from === to) {
      continue;
    }
    const route = findRoute(city, from, to);
    if (!route.found) {
      continue;
    }
    let seconds = 0;
    for (const roadId of route.roadIds) {
      const road = city.roads[roadId];
      seconds += road.length / road.speedLimit;
    }
    totalMs += seconds * 1000;
    found += 1;
  }
  return found > 0 ? totalMs / found : FALLBACK_TRIP_MS;
}

function pickType(rng: Rng, level: TrafficLevel): VehicleType {
  const mix = TRAFFIC_LEVEL_TYPE_MIX[level];
  const roll = rng.nextFloat();
  if (roll < mix.car) {
    return "car";
  }
  if (roll < mix.car + mix.truck) {
    return "truck";
  }
  return "bicycle";
}

/** Builds the full deterministic spawn schedule for a run. */
export function generateDemand(options: DemandOptions): ScheduledSpawn[] {
  const { city, level, seed, durationMs } = options;
  const multiplier = options.multiplier ?? 1;
  const shapeName = options.shape ?? "uniform";
  if (!Number.isFinite(multiplier) || multiplier <= 0) {
    throw new RangeError(`multiplier must be finite and positive, received ${String(multiplier)}`);
  }
  if (!DEMAND_SHAPES.includes(shapeName)) {
    throw new RangeError(`unknown demand shape "${String(shapeName)}"`);
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError(`durationMs must be finite and positive, received ${durationMs}`);
  }
  if (city.intersections.length < 2) {
    throw new RangeError("demand requires a city with at least two intersections");
  }
  const trafficRng = createRng(seed).fork("traffic");
  const calibrationRng = trafficRng.fork("calibration");
  const odRng = trafficRng.fork("od");
  const classRng = trafficRng.fork("classes");
  const targets = TRAFFIC_LEVEL_TARGETS[city.size][level];
  const baseTarget = (targets.min + targets.max) / 2;
  const targetActive = Math.max(1, Math.round(baseTarget * multiplier));
  const estimatedTripMs = estimateAverageTripMs(city, calibrationRng);
  // Raw interval: dense (rush, large) demand may schedule several vehicles
  // per 100 ms tick; the engine snaps each spawn forward to its tick.
  const intervalMs = Math.max(1, Math.round(estimatedTripMs / targetActive));
  const count = city.intersections.length;
  const shape = shapeName === "uniform" ? null : demandShape(shapeName);
  const context = shape === null ? null : shapeContext(city);
  const spawns: ScheduledSpawn[] = [];
  for (let timeMs = 0; timeMs < durationMs; timeMs += intervalMs) {
    const type = pickType(classRng, level);
    let origin: number;
    let destination: number;
    if (shape === null || context === null) {
      origin = odRng.nextInt(0, count - 1);
      destination = odRng.nextInt(0, count - 1);
    } else {
      // Weighted tournament: a fixed number of candidates per spawn, heaviest
      // wins, ties broken by draw order. Constant draws, no rejection loop, and
      // entirely determined by the `od` stream.
      origin = odRng.nextInt(0, count - 1);
      destination = odRng.nextInt(0, count - 1);
      let best = shape.weight(origin, destination, context);
      for (let candidate = 1; candidate < SHAPE_TOURNAMENT; candidate += 1) {
        const nextOrigin = odRng.nextInt(0, count - 1);
        const nextDestination = odRng.nextInt(0, count - 1);
        const weight = shape.weight(nextOrigin, nextDestination, context);
        if (weight > best) {
          best = weight;
          origin = nextOrigin;
          destination = nextDestination;
        }
      }
    }
    while (destination === origin) {
      destination = odRng.nextInt(0, count - 1);
    }
    spawns.push({ timeMs, type, origin, destination });
  }
  return spawns;
}
