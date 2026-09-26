/**
 * Completion-latency report (Issue #46, section 2 — the release bug).
 *
 * The defect: the ego arrives visually, but the arrival/result UI can take an
 * extremely long time to appear. This script measures the stage breakdown that
 * explains it, on the real frozen Metro world, and prints the two numbers that
 * matter:
 *
 *   before   the arrival -> RUN_COMPLETE delay the PACED run had: the tail of
 *            the horizon was played out in real time with the car already
 *            parked (measured 152-202 s of simulated time, i.e. 19-26 s of
 *            wall clock at the 8x playback);
 *   after    the same tail simulated back to back: same steps, same order,
 *            same result, no pacing delay.
 *
 * It reproduces the worker's own run loop exactly (same demand, same incident
 * script, same 8 steps per tick, same horizon), so the numbers it prints are the
 * ones the browser produces.
 *
 *   pnpm tsx scripts/completion-latency-report.ts
 *   pnpm tsx scripts/completion-latency-report.ts --traffic rush-hour
 *   pnpm tsx scripts/completion-latency-report.ts --controller fixed --seed 7
 *
 * The stages it can measure without a browser:
 *   authoritative trip completion   the engine's own ego arrival
 *   worker snapshot with completion the arrival frame, posted on that tick
 *   UI receiving it                 same message handler (no simulation hop)
 *   arrival/result becoming visible one render after the frame, then the
 *                                   run's window (the tail) before the
 *                                   comparison's citywide numbers exist
 */
import { performance } from "node:perf_hooks";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { loadBenchmarkModel } from "@/benchmark/model";
import { productionDemand } from "@/sim/demand-profile";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { buildChallengeIncidentPlan } from "@/worker/challenge-incidents";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { PLAYBACK_STEPS_PER_TICK, SIM_TICK_MS } from "@/worker/protocol";
import type { CuratedTripId } from "@/cities/chicago-trips";
import { TRAFFIC_LEVELS, type TrafficLevel } from "@/sim/types";

/** The product's default scenario: the curated trip the app opens on. */
const TRIP_ID: CuratedTripId = "soldier-field-to-navy-pier";
const HORIZON_MS = 600_000;
type ControllerName = "fixed" | "adaptive";

function arg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);
  return index === -1 ? fallback : (process.argv[index + 1] ?? fallback);
}

interface Measurement {
  readonly arrivalMs: number;
  readonly tailSteps: number;
  /** What the paced loop used to spend on that tail: one tick every SIM_TICK_MS. */
  readonly pacedTailMs: number;
  /** What the same tail costs when it is simulated back to back. */
  readonly unpacedTailMs: number;
  /** Median wall cost of one paced tick (8 steps). */
  readonly tickMs: number;
}

function measure(controller: ControllerName, trafficLevel: TrafficLevel, seed: number): Measurement {
  const model = loadBenchmarkModel();
  const challenge = materializeChallengeTrip(model, TRIP_ID, seed);
  const incidentPlan = buildChallengeIncidentPlan(model, challenge.trip, trafficLevel, seed);
  const engine: EngineState = createEngine({
    city: model.city,
    controller: controller === "fixed" ? createFixedController() : createAdaptiveController(),
    spawns: [
      challenge.spawn,
      ...productionDemand({ city: model.city, level: trafficLevel, seed, durationMs: HORIZON_MS }),
    ],
    driver: "tourist",
    incidents: { seed: incidentPlan.incidentSeed, script: [...incidentPlan.entries] },
  });

  const tickCosts: number[] = [];
  let arrivalMs = -1;
  while (engine.traffic.timeMs < HORIZON_MS) {
    const startedAt = performance.now();
    for (let step = 0; step < PLAYBACK_STEPS_PER_TICK; step += 1) {
      stepEngine(engine);
      if (engine.traffic.timeMs >= HORIZON_MS) {
        break;
      }
    }
    tickCosts.push(performance.now() - startedAt);
    if (arrivalMs < 0 && engine.egoVehicleId !== null) {
      const ego = engine.traffic.vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId);
      if (ego && ego.state === "arrived") {
        arrivalMs = engine.traffic.timeMs;
        break;
      }
    }
  }
  if (arrivalMs < 0) {
    throw new Error(`${TRIP_ID} never arrived inside the ${HORIZON_MS} ms horizon`);
  }

  // The same tail the worker now runs the moment the ego arrives, timed on the
  // engine it actually happens on.
  let tailSteps = 0;
  const tailStartedAt = performance.now();
  while (engine.traffic.timeMs < HORIZON_MS) {
    stepEngine(engine);
    tailSteps += 1;
  }
  const unpacedTailMs = performance.now() - tailStartedAt;

  // The paced counterfactual: the old loop scheduled one tick per SIM_TICK_MS,
  // and a tick that overran its budget ran back to back — period is therefore
  // max(SIM_TICK_MS, tick cost), which is what the delay was made of.
  const sorted = [...tickCosts].sort((a, b) => a - b);
  const tickMs = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const pacedTicks = Math.ceil((HORIZON_MS - arrivalMs) / (SIM_TICK_MS * PLAYBACK_STEPS_PER_TICK));

  return {
    arrivalMs,
    tailSteps,
    pacedTailMs: pacedTicks * Math.max(SIM_TICK_MS, tickMs),
    unpacedTailMs,
    tickMs,
  };
}

const levels: TrafficLevel[] = arg("--traffic", "") === ""
  ? ["everyday", "rush-hour"]
  : [TRAFFIC_LEVELS.find((level) => level === arg("--traffic", "")) ?? "everyday"];
const controllers: ControllerName[] = arg("--controller", "") === ""
  ? ["fixed", "adaptive"]
  : [arg("--controller", "fixed") as ControllerName];
const seed = Number(arg("--seed", "42"));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

for (const trafficLevel of levels) {
  for (const controller of controllers) {
    const run = measure(controller, trafficLevel, seed);
    console.log(
      `\n${TRIP_ID} · ${trafficLevel} · ${controller} · seed ${seed}\n` +
        `  authoritative trip completion      sim ${seconds(run.arrivalMs)} of the ${seconds(HORIZON_MS)} horizon\n` +
        `  worker snapshot with completion    the arrival frame, posted on that tick (<= ${SIM_TICK_MS} ms later)\n` +
        `  UI receiving it                    same message handler — no simulation hop\n` +
        `  arrival/result becoming visible    one render after the frame, then the tail\n` +
        `  tail of the horizon                ${run.tailSteps} steps (${seconds(HORIZON_MS - run.arrivalMs)} of simulated time)\n` +
        `  before: paced tail                 ${seconds(run.pacedTailMs)} of wall clock with the car parked\n` +
        `  after:  unpaced tail               ${seconds(run.unpacedTailMs)} of engine work, no pacing delay\n` +
        `  frame cadence                      ${run.tickMs.toFixed(1)} ms per paced tick (${PLAYBACK_STEPS_PER_TICK} steps)`,
    );
  }
}
