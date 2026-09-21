/**
 * Simulation profiler (Issue #40, Phase 1).
 *
 * Runs the real frozen Metro Chicago path — rush-hour, curated trip, 600 s of
 * simulated time in the engine's own 100 ms timestep — and reports where the
 * time goes. Nothing here is a benchmark harness: it exists to prove where the
 * cost is before anything is changed, and to be run again afterwards.
 *
 *   pnpm tsx scripts/profile-simulation.ts                 # adaptive, 6000 ticks
 *   pnpm tsx scripts/profile-simulation.ts --controller fixed
 *   pnpm tsx scripts/profile-simulation.ts --warm            # same, plus JIT warmup run first
 *
 * Sections:
 *   step cost    per-window median/p95 of a single stepEngine call
 *   populations  spawned / active / arrived over simulated time
 *   side costs   presentation snapshot, metrics and transport cloning, measured
 *                apart from the engine so they cannot hide inside its number
 */
import { performance } from "node:perf_hooks";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { loadBenchmarkModel } from "@/benchmark/model";
import { generateDemand } from "@/sim/demand";
import {
  createEngine,
  stepEngine,
  type EngineState,
  type ScheduledSpawn,
} from "@/sim/engine";
import { buildPresentationMetrics, buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { buildChallengeScenario, resolveScenarioWorld, scenarioFingerprint } from "@/worker/challenge-scenario";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { TRAFFIC_LEVELS, type TrafficLevel } from "@/sim/types";

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}
import type { CuratedTripId } from "@/cities/chicago-trips";

const TIMESTEP_MS = 100;
const HORIZON_MS = Number(arg("--horizon", "600")) * 1000;
const TICKS = HORIZON_MS / TIMESTEP_MS;
const TRIP_ID: CuratedTripId = "soldier-field-to-navy-pier";

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round(fraction * (sorted.length - 1))));
  return sorted[index];
}

function summarize(samples: readonly number[]): { median: number; p95: number; mean: number; max: number } {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((sum, value) => sum + value, 0) / Math.max(1, samples.length);
  return {
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean,
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function buildRun(controllerName: string, trafficLevel: TrafficLevel, seed: number) {
  const model = loadBenchmarkModel();
  const challenge = materializeChallengeTrip(model, TRIP_ID, seed);
  const scenario = buildChallengeScenario({
    tripId: TRIP_ID,
    trafficLevel,
    driver: "tourist",
    seed,
    durationMs: HORIZON_MS,
  });
  const world = resolveScenarioWorld(model, challenge.trip, scenario);
  const spawns: ScheduledSpawn[] = [
    challenge.spawn,
    ...generateDemand({ city: model.city, level: trafficLevel, seed: world.demandSeed, durationMs: HORIZON_MS }),
  ];
  const engine = createEngine({
    city: model.city,
    controller: controllerName === "fixed" ? createFixedController() : createAdaptiveController(),
    spawns,
    driver: "tourist",
    incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
  });
  return { model, engine, scenario, world };
}

function population(engine: EngineState): { spawned: number; active: number; arrived: number; pending: number } {
  let active = 0;
  let arrived = 0;
  let pending = 0;
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state === "arrived") arrived += 1;
    else if (vehicle.state === "pending") pending += 1;
    else active += 1;
  }
  return { spawned: engine.traffic.vehicles.length, active, arrived, pending };
}

function main(): void {
  const controllerName = arg("--controller", "adaptive");
  const trafficLevel = arg("--traffic", "rush-hour") as TrafficLevel;
  if (!TRAFFIC_LEVELS.includes(trafficLevel)) {
    throw new Error(`unknown traffic level ${trafficLevel}`);
  }
  const seed = Number(arg("--seed", "42"));

  if (process.argv.includes("--warm")) {
    // One short run so the JIT has seen every hot function before measuring.
    const warm = buildRun(controllerName, trafficLevel, seed);
    for (let tick = 0; tick < 600; tick += 1) {
      stepEngine(warm.engine);
    }
  }

  const { model, engine, scenario, world } = buildRun(controllerName, trafficLevel, seed);
  console.log(
    `scenario ${TRIP_ID} · ${trafficLevel} · ${controllerName} · seed ${seed} · ` +
      `${TICKS} ticks (${HORIZON_MS / 1000}s) · city ${model.city.roads.length} roads`,
  );

  const third = Math.floor(TICKS / 3);
  const windows = [
    { name: "early", from: 0, to: Math.min(1_000, third) },
    { name: "mid", from: third, to: third + Math.min(1_000, third) },
    { name: "late", from: TICKS - Math.min(1_000, third), to: TICKS },
  ] as const;
  // Extra windows where the LIVE population has already plateaued but history
  // keeps growing: this is what separates "more traffic" from "more history".
  // In sweep mode the windows are disjoint from the headline three, so the two
  // views never steal samples from each other. Each window records the LIVE and
  // total population at its end, which is what separates "more traffic" from
  // "more history" as the cause of any growth.
  const sweeping = process.argv.includes("--sweep");
  const sweep = sweeping
    ? ([
        { name: "s1", from: 3_800, to: 4_300 },
        { name: "s2", from: 4_300, to: 4_800 },
        { name: "s3", from: 5_300, to: 5_600 },
        { name: "s4", from: 5_700, to: 6_000 },
      ] as const)
    : [];
  const populations: Record<string, { active: number; spawned: number }> = {};
  const samples: Record<string, number[]> = { early: [], mid: [], late: [] };
  const snapshots: Record<string, number[]> = { early: [], mid: [], late: [] };
  const metricsSamples: Record<string, number[]> = { early: [], mid: [], late: [] };
  const clones: Record<string, number[]> = { early: [], mid: [], late: [] };
  const marks: Array<{ tick: number; spawned: number; active: number; arrived: number; pending: number }> = [];

  const totalStart = performance.now();
  for (let tick = 0; tick < TICKS; tick += 1) {
    const stepStart = performance.now();
    stepEngine(engine);
    const stepMs = performance.now() - stepStart;

    // Headline windows always fill; sweep windows are disjoint extras, so both
    // views are available in one run.
    const window =
      sweep.find((candidate) => tick >= candidate.from && tick < candidate.to) ??
      windows.find((candidate) => tick >= candidate.from && tick < candidate.to);
    if (window) {
      (samples[window.name] ??= []).push(stepMs);

      const snapshotStart = performance.now();
      const snapshot = buildPresentationSnapshot(engine, tick, TRIP_ID, null);
      (snapshots[window.name] ??= []).push(performance.now() - snapshotStart);

      const metricsStart = performance.now();
      buildPresentationMetrics(engine);
      (metricsSamples[window.name] ??= []).push(performance.now() - metricsStart);

      // What actually crosses the worker boundary: a structured clone of the
      // frame. JSON is measured alongside it as a stable, comparable size proxy.
      const cloneStart = performance.now();
      structuredClone({ snapshot });
      (clones[window.name] ??= []).push(performance.now() - cloneStart);
    }

    if (window && tick === window.to - 1) {
      const counts = population(engine);
      populations[window.name] = { active: counts.active + counts.pending, spawned: counts.spawned };
    }

    if (tick % 500 === 0) {
      marks.push({ tick, ...population(engine) });
    }
  }
  const totalMs = performance.now() - totalStart;

  console.log("\nstep cost (ms per stepEngine)");
  for (const window of windows) {
    const stats = summarize(samples[window.name]);
    console.log(
      `  ${window.name.padEnd(5)} ticks ${String(window.from).padStart(4)}-${String(window.to).padStart(4)}  ` +
        `median ${stats.median.toFixed(3)}  p95 ${stats.p95.toFixed(3)}  mean ${stats.mean.toFixed(3)}  max ${stats.max.toFixed(3)}`,
    );
  }

  console.log("\nside costs (ms per call, same windows)");
  for (const window of windows) {
    const snapshot = summarize(snapshots[window.name]);
    const metrics = summarize(metricsSamples[window.name]);
    const clone = summarize(clones[window.name]);
    console.log(
      `  ${window.name.padEnd(5)} snapshot median ${snapshot.median.toFixed(3)} p95 ${snapshot.p95.toFixed(3)}  |  ` +
        `metrics median ${metrics.median.toFixed(3)}  |  clone median ${clone.median.toFixed(3)}`,
    );
  }

  if (sweeping) {
    console.log("\nplateau sweep: live vs history (ms per step, and per live vehicle)");
    for (const window of sweep) {
      const stats = summarize(samples[window.name] ?? []);
      const pop = populations[window.name];
      const perLive = pop === undefined || pop.active === 0 ? 0 : (stats.median * 1000) / pop.active;
      console.log(
        `  ticks ${window.from}-${window.to}  median ${stats.median.toFixed(3)}  p95 ${stats.p95.toFixed(3)}  ` +
          (pop === undefined
            ? "(no sample)"
            : `live ${pop.active}  history ${pop.spawned}  median ${perLive.toFixed(1)} µs per live vehicle`),
      );
    }
  }

  console.log("\npopulations (spawned / active / arrived / pending)");
  for (const mark of marks) {
    console.log(
      `  t=${String(mark.tick * TIMESTEP_MS).padStart(6)}ms  spawned ${String(mark.spawned).padStart(5)}  ` +
        `active ${String(mark.active).padStart(5)}  arrived ${String(mark.arrived).padStart(5)}  pending ${String(mark.pending).padStart(4)}`,
    );
  }

  const final = population(engine);
  const early = summarize(samples.early);
  const late = summarize(samples.late);
  console.log(
    `\ntotals: ${final.spawned} spawned, ${final.arrived} arrived, ` +
      `${(totalMs / 1000).toFixed(1)}s wall for ${TICKS} ticks (${(totalMs / TICKS).toFixed(3)} ms/step average)`,
  );
  console.log(
    `late/early median ratio ${(late.median / Math.max(1e-6, early.median)).toFixed(2)}×, ` +
      `p95 ratio ${(late.p95 / Math.max(1e-6, early.p95)).toFixed(2)}×`,
  );
  console.log(
    `frame payload: ${JSON.stringify(buildPresentationSnapshot(engine, TICKS, TRIP_ID, null)).length} bytes; ` +
      `scenario ${scenarioFingerprint(scenario)} · plan ${world.incidentPlan.entries.length} incident entries`,
  );
}

main();
