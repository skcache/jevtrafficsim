/**
 * Simulation worker (Task 11): owns ALL simulation state — city generation,
 * demand, controller, engine, incidents, stepping, resets and the bounded
 * presentation frames. The main thread only sends commands and renders.
 *
 * Pacing: a recursive setTimeout chain, ONE fixed simulation step per
 * scheduled iteration. Browser timing APIs are used ONLY to pace execution;
 * no wall-clock value ever enters simulation state or policy. If a tick takes
 * longer than the real-time budget, the run simply advances slower than wall
 * time — ticks are never queued in an unbounded catch-up spiral.
 *
 * Cadence: snapshots every SNAPSHOT_EVERY_TICKS (5 Hz), metrics every
 * METRICS_EVERY_TICKS (2 Hz) — both centralized in worker/protocol.ts.
 */
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { showcaseCity, showcaseScaleForSize } from "@/cities/showcase-city";
import { SHOWCASE_SCALE_LABELS } from "@/cities/showcase-city-data";
import { generateDemand } from "@/sim/demand";
import {
  createEngine,
  queueIncident,
  setEngineController,
  stepEngine,
  type EngineState,
} from "@/sim/engine";
import { createRng } from "@/sim/rng";
import {
  buildPresentationMetrics,
  buildPresentationSnapshot,
} from "./presentation-snapshot";
import {
  LIVE_RUN_HORIZON_MS,
  METRICS_EVERY_TICKS,
  nextSeed,
  parseWorkerCommand,
  SIM_TICK_MS,
  SNAPSHOT_EVERY_TICKS,
  type ControllerChoice,
  type RunConfig,
  type WorkerCommand,
  type WorkerEvent,
} from "./protocol";

/** Minimal worker scope shape: no webworker lib juggling required. */
interface WorkerScope {
  postMessage(message: unknown): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

const scope = self as unknown as WorkerScope;

interface WorkerState {
  config: RunConfig | null;
  engine: EngineState | null;
  scaleIndex: number;
  incidentSeed: number;
  running: boolean;
  complete: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  snapshotSequence: number;
}

const state: WorkerState = {
  config: null,
  engine: null,
  scaleIndex: 2,
  incidentSeed: 0,
  running: false,
  complete: false,
  timer: null,
  snapshotSequence: 0,
};

function post(event: WorkerEvent): void {
  scope.postMessage(event);
}

function makeController(choice: ControllerChoice) {
  return choice === "adaptive" ? createAdaptiveController() : createFixedController();
}

function postSnapshot(): void {
  if (!state.engine) {
    return;
  }
  post({
    type: "SNAPSHOT",
    snapshot: buildPresentationSnapshot(state.engine, state.snapshotSequence),
  });
  state.snapshotSequence += 1;
}

function postMetrics(): void {
  if (!state.engine) {
    return;
  }
  post({ type: "METRICS", metrics: buildPresentationMetrics(state.engine) });
}

function clearTimer(): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/** Full (re)build from a run config: fresh city, demand, engine, render model. */
function buildRun(config: RunConfig): void {
  clearTimer();
  state.running = false;
  state.complete = false;
  // The browser demo runs the handcrafted showcase city; the procedural
  // generator stays for tests and the headless benchmark (Task 12).
  const scaleIndex = showcaseScaleForSize(config.citySize);
  const model = showcaseCity(scaleIndex);
  const city = model.city;
  const spawns = generateDemand({
    city,
    level: config.trafficLevel,
    seed: config.seed,
    durationMs: config.durationMs,
  });
  // Deterministic incident root derived from the run seed: interactive
  // incidents resolve from it through the engine's existing machinery.
  const incidentSeed = createRng(config.seed).fork("incidents").seed;
  const engine = createEngine({
    city,
    controller: makeController(config.controller),
    spawns,
    incidents: { seed: incidentSeed, script: [] },
  });
  state.config = config;
  state.engine = engine;
  state.scaleIndex = scaleIndex;
  state.incidentSeed = incidentSeed;
  state.snapshotSequence = 0;
  post({
    type: "READY",
    config,
    scaleIndex,
    scaleLabel: SHOWCASE_SCALE_LABELS[scaleIndex],
    timeMs: engine.traffic.timeMs,
    incidentSeed,
  });
  postSnapshot();
  postMetrics();
  start(); // initial state: automatically running (documented behavior)
}

function scheduleNextTick(): void {
  state.timer = setTimeout(runTick, SIM_TICK_MS);
}

function start(): void {
  if (!state.engine || state.running || state.complete) {
    return;
  }
  state.running = true;
  scheduleNextTick();
}

function pause(): void {
  state.running = false;
  clearTimer();
  postSnapshot(); // freeze frame + final metrics for the paused state
  postMetrics();
}

function handleError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  state.running = false;
  clearTimer();
  // Developer detail in the worker console; the UI gets the message only.
  console.error("[simulation-worker]", error);
  post({ type: "ERROR", message });
}

function runTick(): void {
  state.timer = null;
  const engine = state.engine;
  const config = state.config;
  if (!engine || !config || !state.running) {
    return;
  }
  try {
    stepEngine(engine);
  } catch (error) {
    handleError(error);
    return;
  }
  if (engine.ticks % SNAPSHOT_EVERY_TICKS === 0) {
    postSnapshot();
  }
  if (engine.ticks % METRICS_EVERY_TICKS === 0) {
    postMetrics();
  }
  if (engine.traffic.timeMs >= config.durationMs) {
    state.running = false;
    state.complete = true;
    postSnapshot();
    postMetrics();
    post({ type: "RUN_COMPLETE", timeMs: engine.traffic.timeMs });
    return;
  }
  scheduleNextTick();
}

function handleCommand(command: WorkerCommand): void {
  switch (command.type) {
    case "INIT": {
      buildRun({
        citySize: command.citySize,
        trafficLevel: command.trafficLevel,
        controller: command.controller,
        seed: command.seed,
        durationMs: command.durationMs ?? LIVE_RUN_HORIZON_MS,
      });
      return;
    }
    case "START": {
      if (!state.engine) {
        post({ type: "ERROR", message: "cannot START before INIT" });
        return;
      }
      start();
      return;
    }
    case "PAUSE": {
      pause();
      return;
    }
    case "RESET": {
      if (!state.config) {
        post({ type: "ERROR", message: "cannot RESET before INIT" });
        return;
      }
      const seed = command.mode === "new-seed" ? nextSeed(state.config.seed) : state.config.seed;
      buildRun({ ...state.config, seed });
      return;
    }
    case "SET_CONTROLLER": {
      if (!state.engine || !state.config) {
        post({ type: "ERROR", message: "cannot SET_CONTROLLER before INIT" });
        return;
      }
      // In-place switch: traffic, incidents, metrics, seed and simulation time
      // are untouched; policy changes from the next tick.
      setEngineController(state.engine, makeController(command.controller));
      state.config = { ...state.config, controller: command.controller };
      postSnapshot(); // controller id visible immediately
      return;
    }
    case "INCIDENT": {
      if (!state.engine) {
        post({ type: "ERROR", message: "cannot INCIDENT before INIT" });
        return;
      }
      // Interactive injection through the Task-10 seam: atMs defaults to the
      // current simulation time; it activates on the next incident phase.
      queueIncident(state.engine, { kind: command.kind });
      postSnapshot(); // immediate feedback frame (pending marker)
      return;
    }
  }
}

scope.onmessage = (event: MessageEvent) => {
  let command: WorkerCommand;
  try {
    command = parseWorkerCommand(event.data);
  } catch (error) {
    handleError(error);
    return;
  }
  try {
    handleCommand(command);
  } catch (error) {
    handleError(error);
  }
};
