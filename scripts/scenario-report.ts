/**
 * Scenario report (traffic calibration + Jev/Adaptive divergence).
 *
 * Runs the frozen Metro Chicago path for a curated trip and reports what the
 * world actually does — and, when asked for both controllers, exactly where Jev's
 * bounded policy produces a different directive than Adaptive's. Two engines run
 * in LOCKSTEP over an identical world (same demand seed, same incident plan, same
 * trip, same driver), so the only difference between them is the controller.
 *
 *   npx tsx scripts/scenario-report.ts --traffic rush-hour
 *   npx tsx scripts/scenario-report.ts --traffic everyday --controller both
 *   npx tsx scripts/scenario-report.ts --traffic rush-hour --controller both --shape downtown-bound
 *   npx tsx scripts/scenario-report.ts --traffic rush-hour --demand 2.4        # volume multiplier
 *
 * Nothing here changes the simulation: it drives the same engine and controllers
 * the product does, and counts. Divergence is measured on the directive maps the
 * ENGINE actually received (each controller is wrapped and recorded), never on a
 * second hand-built call that might apply side effects twice.
 */
import { createAdaptiveController } from "@/controllers/adaptive";
import { createJevController, type JevController as JevControllerLike } from "@/controllers/jev";
import { loadBenchmarkModel } from "@/benchmark/model";
import { createMockJevClient } from "@/jev/client";
import { generateDemand } from "@/sim/demand";
import { createEngine, stepEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import { buildObservationFrame, createApproachArrivalTracker, type ApproachArrivalTracker } from "@/sim/observations";
import { roadOccupancy } from "@/sim/traffic";
import { ADAPTIVE_CONSTANTS } from "@/controllers/adaptive";
import { computeMetrics, throughputPerMinute } from "@/sim/metrics";
import type { SignalDirective } from "@/sim/signals";
import type { TrafficController, TrafficControllerContext } from "@/controllers/contract";
import type { IntersectionId } from "@/sim/types";
import { resolveScenarioWorld, buildChallengeScenario, scenarioFingerprint } from "@/worker/challenge-scenario";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { JEV_LIMITS } from "@/jev/schema";
import { DEMAND_SHAPES, type DemandShapeName } from "@/sim/demand-shape";
import { demandProfileFor, productionDemand } from "@/sim/demand-profile";
import type { CuratedTripId } from "@/cities/chicago-trips";

const TRIP_ID: CuratedTripId = "soldier-field-to-navy-pier";
const SEED = 42;
const TIMESTEP_MS = 100;

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

/**
 * Records the directive map the engine asked for, then delegates untouched, so
 * divergence is measured on what the ENGINE received — no second hand-built call
 * that could apply a policy refresh twice.
 */
interface Recorded {
  readonly controller: TrafficController;
  /** The map the engine received on the most recent tick. */
  last(): ReadonlyMap<IntersectionId, SignalDirective>;
  calls(): number;
}

function recording(inner: TrafficController): Recorded {
  let last: ReadonlyMap<IntersectionId, SignalDirective> = new Map();
  let calls = 0;
  const controller: TrafficController = {
    id: inner.id,
    directives(city, traffic, context?: TrafficControllerContext) {
      const directives = inner.directives(city, traffic, context);
      last = directives;
      calls += 1;
      return directives;
    },
  };
  return { controller, last: () => last, calls: () => calls };
}

interface TickRow {
  tick: number;
  active: number;
  spawned: number;
  arrived: number;
  occupancy: number[];
  queuedRoads: number;
  redShare: number;
  amberShare: number;
  freeShare: number;
  averageWaitMs: number;
  p95WaitMs: number;
  throughputPerMinute: number;
  egoState: string;
  atMinGreen: number;
  atMaxGreen: number;
  starved: number;
}

function summarize(values: readonly number[]): { p50: number; p90: number; max: number; mean: number } {
  if (values.length === 0) return { p50: 0, p90: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (fraction: number): number => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    p50: pick(0.5),
    p90: pick(0.9),
    max: sorted[sorted.length - 1],
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
  };
}

function rowFor(engine: EngineState, tick: number, tracker: ApproachArrivalTracker): TickRow {
  const { traffic } = engine;
  const occupancy: number[] = [];
  let red = 0;
  let amber = 0;
  let free = 0;
  for (const road of engine.city.roads) {
    const ratio = traffic.occupancy.get(road.id) === undefined
      ? 0
      : traffic.occupancy.get(road.id)! / Math.max(1, road.capacity);
    occupancy.push(ratio);
    const factor = traffic.roadTraffic.factor.get(road.id) ?? 1;
    // Red = the road is moving traffic far below its limit (queue-bound), amber =
    // partially degraded, free = unconstrained. Speed factor is the same signal
    // the map colours by, so the shares match what a viewer sees.
    if (factor <= 0.5) red += 1;
    else if (factor < 0.85) amber += 1;
    else free += 1;
  }
  const metrics = computeMetrics(engine.metrics, traffic);
  const frame = buildObservationFrame(engine.city, traffic, tracker);
  let atMinGreen = 0;
  let atMaxGreen = 0;
  let starved = 0;
  for (const [intersectionId, signal] of traffic.signals) {
    const observation = frame.intersections.get(intersectionId);
    if (!observation || signal.groups.length < 2) continue;
    if (signal.stage === "green" && signal.stageElapsedMs < signal.timing.minGreenMs) atMinGreen += 1;
    if (signal.stage === "green" && signal.stageElapsedMs >= signal.timing.maxGreenMs) atMaxGreen += 1;
    const current = observation.phases[signal.phaseIndex];
    if (
      current !== undefined &&
      current.maxWaitMs >= ADAPTIVE_CONSTANTS.STARVATION_THRESHOLD_MS &&
      signal.stageElapsedMs < ADAPTIVE_CONSTANTS.STARVATION_MIN_SERVICE_MS
    ) {
      starved += 1;
    }
  }
  const ego = traffic.vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId);
  const roads = Math.max(1, engine.city.roads.length);
  return {
    tick,
    active: traffic.vehicles.reduce((count, vehicle) => (vehicle.state === "arrived" ? count : count + 1), 0),
    spawned: traffic.vehicles.length,
    arrived: metrics.completedTrips,
    occupancy,
    queuedRoads: [...traffic.occupancy.keys()].length,
    redShare: red / roads,
    amberShare: amber / roads,
    freeShare: free / roads,
    averageWaitMs: metrics.averageWaitTimeMs,
    p95WaitMs: metrics.p95WaitTimeMs,
    throughputPerMinute: throughputPerMinute(metrics.completedTrips, traffic.timeMs),
    egoState: ego === undefined ? "missing" : ego.state,
    atMinGreen,
    atMaxGreen,
    starved,
  };
}

function main(): void {
  const trafficLevel = arg("--traffic", "rush-hour") as "everyday" | "rush-hour";
  const shape = arg("--shape", "uniform") as DemandShapeName;
  const demandMultiplier = Number(arg("--demand", "1"));
  const minutes = Number(arg("--minutes", "10"));
  const both = arg("--controller", "both") === "both";
  const horizonMs = minutes * 60_000;

  const model = loadBenchmarkModel();
  const challenge = materializeChallengeTrip(model, TRIP_ID, SEED);
  const scenario = buildChallengeScenario({
    tripId: TRIP_ID,
    trafficLevel,
    driver: "tourist",
    seed: SEED,
    durationMs: horizonMs,
  });
  const world = resolveScenarioWorld(model, challenge.trip, scenario);
  // --profile runs the SHIPPING demand (sim/demand-profile.ts); the raw flags
  // stay available for calibration sweeps.
  const useProduction = process.argv.includes("--profile");
  const demandOptions = {
    city: model.city,
    level: trafficLevel,
    seed: world.demandSeed,
    durationMs: horizonMs,
    shape,
    multiplier: demandMultiplier,
  };
  const profile = demandProfileFor(trafficLevel);
  const demand = useProduction
    ? productionDemand({ city: model.city, level: trafficLevel, seed: world.demandSeed, durationMs: horizonMs })
    : generateDemand(demandOptions);
  const spawns: ScheduledSpawn[] = [challenge.spawn, ...demand];

  const build = (controller: TrafficController): EngineState =>
    createEngine({
      city: model.city,
      controller,
      spawns,
      driver: "tourist",
      incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
    });

  const adaptiveProxy = recording(createAdaptiveController());
  const jevController = createJevController({
    client: createMockJevClient(),
    scenarioFingerprint: scenarioFingerprint(scenario),
    refreshMs: 5_000,
  });
  const jevProxy = recording(jevController);
  const adaptiveEngine = build(adaptiveProxy.controller);
  const jevEngine = both ? build(jevProxy.controller) : null;

  const adaptiveTracker: ApproachArrivalTracker = createApproachArrivalTracker();
  const jevTracker: ApproachArrivalTracker = createApproachArrivalTracker();

  const ticks = Math.floor(horizonMs / TIMESTEP_MS);
  const rowsAdaptive: TickRow[] = [];
  const rowsJev: TickRow[] = [];
  let comparisons = 0;
  let differing = 0;
  let ticksAllEqual = 0;
  let ticksCompared = 0;
  const touched = new Map<IntersectionId, number>();
  const kinds = { advanceVsHold: 0, holdVsAdvance: 0, advanceVsNothing: 0, nothingVsAdvance: 0 };

  for (let tick = 0; tick < ticks; tick += 1) {
    stepEngine(adaptiveEngine);
    if (jevEngine !== null) stepEngine(jevEngine);

    if (jevEngine !== null && adaptiveProxy.calls() > 0 && jevProxy.calls() > 0) {
      // Same simulated tick in both worlds: compare the maps the engines received.
      const a = adaptiveProxy.last();
      const j = jevProxy.last();
      let comparedHere = 0;
      let differingHere = 0;
      for (const intersectionId of a.keys()) {
        const directiveA = a.get(intersectionId);
        const directiveJ = j.get(intersectionId);
        if (directiveA === undefined && directiveJ === undefined) continue;
        comparedHere += 1;
        comparisons += 1;
        if (directiveA !== directiveJ) {
          differing += 1;
          differingHere += 1;
          touched.set(intersectionId, (touched.get(intersectionId) ?? 0) + 1);
          const pair = `${String(directiveA)}→${String(directiveJ)}`;
          if (pair === "advance→hold") kinds.advanceVsHold += 1;
          else if (pair === "hold→advance") kinds.holdVsAdvance += 1;
          else if (pair === "advance→undefined") kinds.advanceVsNothing += 1;
          else if (pair === "undefined→advance") kinds.nothingVsAdvance += 1;
        }
      }
      for (const intersectionId of j.keys()) {
        if (!a.has(intersectionId) && j.get(intersectionId) !== undefined) {
          comparisons += 1;
          comparedHere += 1;
          differing += 1;
          differingHere += 1;
          kinds.nothingVsAdvance += 1;
          touched.set(intersectionId, (touched.get(intersectionId) ?? 0) + 1);
        }
      }
      if (comparedHere > 0) {
        ticksCompared += 1;
        if (differingHere === 0) ticksAllEqual += 1;
      }
    }

    if (tick % 600 === 599 || tick === ticks - 1) {
      rowsAdaptive.push(rowFor(adaptiveEngine, tick, adaptiveTracker));
      if (jevEngine !== null) rowsJev.push(rowFor(jevEngine, tick, jevTracker));
    }
  }

  const label = useProduction
    ? `${trafficLevel} · PRODUCTION ${profile.label}`
    : `${trafficLevel}${shape === "uniform" ? "" : `/${shape}`}${demandMultiplier === 1 ? "" : `×${demandMultiplier}`}`;
  console.log(`\n=== ${label} · ${TRIP_ID} · ${minutes} min · ${ticks} ticks · ${model.city.roads.length} roads ===`);
  console.log(
    "t(min)  active spawned arrived  occ p50/p90/max   red%  amber%  free%  queued  wait avg/p95   thru/min  ego   minG maxG starv",
  );
  for (const row of rowsAdaptive) {
    const occ = summarize(row.occupancy);
    console.log(
      `${String(Math.round(row.tick / 600)).padStart(6)}  ${String(row.active).padStart(6)} ${String(row.spawned).padStart(7)} ${String(row.arrived).padStart(7)}  ` +
        `${occ.p50.toFixed(2)}/${occ.p90.toFixed(2)}/${occ.max.toFixed(2)}  ` +
        `${(row.redShare * 100).toFixed(1).padStart(5)}  ${(row.amberShare * 100).toFixed(1).padStart(6)}  ${(row.freeShare * 100).toFixed(1).padStart(5)}  ` +
        `${String(row.queuedRoads).padStart(6)}  ${(row.averageWaitMs / 1000).toFixed(1)}/${(row.p95WaitMs / 1000).toFixed(1).padStart(5)}s ` +
        `${row.throughputPerMinute.toFixed(1).padStart(8)}  ${row.egoState.padEnd(7)} ` +
        `${String(row.atMinGreen).padStart(4)} ${String(row.atMaxGreen).padStart(4)} ${String(row.starved).padStart(5)}`,
    );
  }

  if (jevEngine !== null && rowsJev.length > 0) {
    const lastAdaptive = rowsAdaptive[rowsAdaptive.length - 1];
    const lastJev = rowsJev[rowsJev.length - 1];
    console.log(
      `\nfinal: Adaptive active=${lastAdaptive.active} arrived=${lastAdaptive.arrived} ` +
        `wait=${(lastAdaptive.averageWaitMs / 1000).toFixed(1)}s p95=${(lastAdaptive.p95WaitMs / 1000).toFixed(1)}s ` +
        `thru=${lastAdaptive.throughputPerMinute.toFixed(1)}/min ego=${lastAdaptive.egoState}`,
    );
    console.log(
      `final: Jev      active=${lastJev.active} arrived=${lastJev.arrived} ` +
        `wait=${(lastJev.averageWaitMs / 1000).toFixed(1)}s p95=${(lastJev.p95WaitMs / 1000).toFixed(1)}s ` +
        `thru=${lastJev.throughputPerMinute.toFixed(1)}/min ego=${lastJev.egoState}`,
    );
    const policy = describePolicy(jevController);
    console.log(
      `\ndirective divergence over ${ticksCompared} comparable ticks: ` +
        `${differing}/${comparisons} = ${((differing / Math.max(1, comparisons)) * 100).toFixed(2)}% differ · ` +
        `${((ticksAllEqual / Math.max(1, ticksCompared)) * 100).toFixed(2)}% of ticks identical`,
    );
    console.log(
      `  disagreements: advance→hold ${kinds.advanceVsHold}, hold→advance ${kinds.holdVsAdvance}, ` +
        `advance→none ${kinds.advanceVsNothing}, none→advance ${kinds.nothingVsAdvance}`,
    );
    console.log(`  intersections ever differing: ${touched.size}`);
    console.log(`  policy in force at end: ${policy}`);
  }
}

/** The policy in force, for the report: what the model actually asked for. */
function describePolicy(controller: JevControllerLike): string {
  const policy = controller.policy();
  if (policy === null) return "(none in force)";
  const corridors = policy.corridorWeights.map((entry) => `${entry.id}:${entry.weight}`).join(",");
  const regions = policy.regionWeights.map((entry) => `${entry.id}:${entry.weight}`).join(",");
  return (
    `pressureScale=${policy.pressureScale} hint=${policy.hint} ` +
    `corridors=[${corridors}] regions=[${regions}] ` +
    `(bounds pressureScale [${JEV_LIMITS.PRESSURE_SCALE_MIN},${JEV_LIMITS.PRESSURE_SCALE_MAX}])`
  );
}

if (process.argv[1]?.includes("scenario-report") === true) {
  main();
}

export { roadOccupancy, DEMAND_SHAPES };
