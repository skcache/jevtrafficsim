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
 * Cadence: one presentation frame and one metrics sample per real tick, so the
 * renderer can interpolate between consecutive frames over SIM_TICK_MS.
 */
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { createJevController } from "@/controllers/jev";
import { createRelayJevClient } from "@/jev/client";
import { CHICAGO_SCALE_LABELS } from "@/cities/chicago";
import { METRO_SCALE_INDEX } from "@/cities/chicago-trips";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import {
  buildChallengeScenario,
  scenarioFingerprint,
  type ChallengeScenario,
} from "@/worker/challenge-scenario";
import { buildChallengeResult } from "@/worker/challenge-result";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
import { fingerprintForRun } from "@/worker/challenge-scenario";
import { runComparison } from "@/worker/challenge-compare";
import type { MaterializedCuratedTrip } from "@/cities/chicago-trips";
import { loadChicagoCity } from "@/cities/chicago-assets";
import type { MapModel } from "@/cities/map-model";
import { generateDemand } from "@/sim/demand";
import { TRAFFIC_LEVELS } from "@/sim/types";
import type { IncidentKind } from "@/sim/incidents";
import {
  createEngine,
  queueIncident,
  setEngineController,
  injectSpawns,
  stepEngine,
  type EngineState,
  type ScheduledSpawn,
} from "@/sim/engine";
import {
  buildPresentationMetrics,
  buildPresentationSnapshot,
} from "./presentation-snapshot";
import {
  buildChallengeIncidentPlan,
  challengeIncidentFingerprintInput,
  incidentCapabilities,
  resolveManualChallengeIncident,
  type ChallengeIncidentPlan,
  type ManualChallengeIncidentInput,
  type ResolvedChallengeIncident,
} from "./challenge-incidents";
import { vehicleById } from "@/sim/traffic";
import {
  LIVE_RUN_HORIZON_MS,
  nextSeed,
  parseWorkerCommand,
  PLAYBACK_STEPS_PER_TICK,
  SIM_TICK_MS,
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
  /** The curated trip this run materialised; null before the first build. */
  trip: MaterializedCuratedTrip | null;
  scaleIndex: number;
  incidentSeed: number;
  running: boolean;
  complete: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  snapshotSequence: number;
  /** Active frozen Chicago presentation model; needed for route-relevant manual targeting. */
  model: MapModel | null;
  /** Controller-neutral automatic challenge plan resolved before the engine starts. */
  incidentPlan: ChallengeIncidentPlan | null;
  /** Exact automatic + manual resolved entries, ready for Issue #28 replay. */
  incidentHistory: ResolvedChallengeIncident[];
  /** Stable sequence for manual resolution streams. */
  manualIncidentSequence: number;
  /** The controller-neutral scenario this run realises (issue #28). */
  scenario: ChallengeScenario | null;
  /** Human-fired incidents during this run; > 0 makes the result non-comparable. */
  manualIncidents: number;
  /** A live command changed the scenario mid-run (see ChallengeResult.modified). */
  modified: boolean;
  /** Guards against overlapping async builds (fast scale switching). */
  buildToken: number;
}

const state: WorkerState = {
  config: null,
  engine: null,
  trip: null,
  scaleIndex: 2,
  incidentSeed: 0,
  running: false,
  complete: false,
  timer: null,
  snapshotSequence: 0,
  model: null,
  incidentPlan: null,
  incidentHistory: [],
  manualIncidentSequence: 0,
  scenario: null,
  manualIncidents: 0,
  modified: false,
  buildToken: 0,
};

function post(event: WorkerEvent): void {
  scope.postMessage(event);
}

function makeController(choice: ControllerChoice, identity: string) {
  if (choice === "jev") {
    // Browser path: the relay client asks our own route, which is the only
    // place the service credential lives. Nothing secret reaches this worker.
    return createJevController({
      client: createRelayJevClient(),
      scenarioFingerprint: identity,
    });
  }
  return choice === "adaptive" ? createAdaptiveController() : createFixedController();
}

/**
 * Who is really deciding the signals right now.
 *
 * A policy controller knows how much of the run its own policy governed and how
 * much the safety fallback had to cover. That distinction is the product's, not
 * an implementation detail: a run that spent meaningful time on the fallback may
 * never be presented as pure live Jev. Controllers without an external policy
 * (Fixed, Adaptive) report nothing.
 */
function policyProvenance(): PresentationPolicy | null {
  const controller = state.engine?.controller as
    | { meta?: () => PresentationPolicy & { kind?: string } }
    | undefined;
  if (!controller || typeof controller.meta !== "function") {
    return null;
  }
  try {
    const meta = controller.meta();
    return {
      source: meta.source,
      liveMs: meta.liveMs,
      replayMs: meta.replayMs,
      fallbackMs: meta.fallbackMs,
      accepted: meta.accepted,
      rejected: meta.rejected,
    };
  } catch {
    return null;
  }
}

/**
 * The input a manual incident click would use RIGHT NOW (Issue #39). Kept in one
 * place so the instrument's availability probe and the click itself cannot
 * drift apart — the probe is literally the same question.
 */
function manualIncidentInput(
  kind: IncidentKind,
  sequence: number,
): ManualChallengeIncidentInput | null {
  const engine = state.engine;
  const model = state.model;
  if (!engine || !model) {
    return null;
  }
  const ego =
    engine.egoVehicleId === null
      ? null
      : vehicleById(engine.traffic, engine.egoVehicleId);
  if (!ego) {
    return null;
  }
  return {
    model,
    city: engine.city,
    kind,
    atMs: engine.traffic.timeMs,
    seed: state.incidentSeed,
    sequence,
    routeRoadIds: ego.route,
    routeIndex: ego.routeIndex,
    egoRoadId: ego.roadId,
    destinationIntersectionId: ego.destination,
  };
}

/**
 * Tell the UI which instruments can do anything in THIS world (Issue #39), so an
 * unusable button is disabled with the reason shown instead of looking live and
 * answering "not available" after a click. Re-posted whenever the world's
 * capacity for chaos can have changed: a new run, or a queued incident.
 */
function postIncidentCapabilities(): void {
  const probe = manualIncidentInput("crash", state.manualIncidentSequence);
  if (probe === null) {
    return;
  }
  const probeContext: Omit<ManualChallengeIncidentInput, "kind"> = {
    model: probe.model,
    city: probe.city,
    atMs: probe.atMs,
    seed: probe.seed,
    sequence: probe.sequence,
    routeRoadIds: probe.routeRoadIds,
    routeIndex: probe.routeIndex,
    egoRoadId: probe.egoRoadId,
    destinationIntersectionId: probe.destinationIntersectionId,
  };
  const engine = state.engine;
  if (engine) {
    capabilitySignature = engine.incidents.records
      .map((record) => `${record.id}:${record.kind}:${record.status}`)
      .join("|");
  }
  post({ type: "INCIDENT_CAPABILITIES", capabilities: incidentCapabilities(probeContext) });
}

/** Signature of the incident set the last capability probe was taken against. */
let capabilitySignature: string | null = null;

/**
 * Re-probe only when the world's incident set actually changed.
 *
 * Cost matters here: one full probe measures ~86 ms on the Metro model (five
 * resolver calls, and the closure kinds run a reachability check), against
 * ~0.6 ms for a simulation tick. Running it every tick would spend the whole
 * frame budget, so it runs when the answer can have changed and not otherwise.
 */
function refreshIncidentCapabilitiesIfStale(): void {
  const engine = state.engine;
  if (!engine) {
    return;
  }
  const signature = engine.incidents.records
    .map((record) => `${record.id}:${record.kind}:${record.status}`)
    .join("|");
  if (signature === capabilitySignature) {
    return;
  }
  capabilitySignature = signature;
  postIncidentCapabilities();
}

function postSnapshot(): void {
  if (!state.engine) {
    return;
  }
  post({
    type: "SNAPSHOT",
    snapshot: buildPresentationSnapshot(
      state.engine,
      state.snapshotSequence,
      state.config?.tripId ?? null,
      policyProvenance(),
      { modified: state.modified, manualIncidents: state.manualIncidents },
    ),
  });
  state.snapshotSequence += 1;
}

function postMetrics(): void {
  if (!state.engine) {
    return;
  }
  post({ type: "METRICS", metrics: buildPresentationMetrics(state.engine) });
  // The automatic script closes roads on its own schedule, so an instrument's
  // availability can change without any click. The signature check is free; the
  // probe itself only runs when the incident set actually moved.
  refreshIncidentCapabilitiesIfStale();
}

function clearTimer(): void {
  if (state.timer !== null) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

/**
 * Full (re)build from a run config: fresh city, demand, engine, render model.
 *
 * The browser demo runs the frozen Chicago showcase geography (committed
 * artifacts, fetched from the same origin). The procedural generator stays
 * untouched for tests and the headless benchmark (Task 12).
 */
async function buildRun(config: RunConfig): Promise<void> {
  clearTimer();
  state.running = false;
  state.complete = false;
  // The curated challenge IS a trip across real Chicago, and the trips are
  // defined against the Metro graph: every run loads Metro.
  const scaleIndex = METRO_SCALE_INDEX;
  const token = (state.buildToken += 1);
  let model: MapModel;
  try {
    model = await loadChicagoCity(scaleIndex);
  } catch (error) {
    post({
      type: "ERROR",
      message: `failed to load the Chicago map data: ${String((error as Error)?.message ?? error)}`,
    });
    return;
  }
  if (token !== state.buildToken) {
    return; // a newer build superseded this one
  }
  const city = model.city;
  // Background demand is exactly what it always was: the whole city stays alive.
  const background = generateDemand({
    city,
    level: config.trafficLevel,
    seed: config.seed,
    durationMs: config.durationMs,
  });
  // The selected curated trip becomes ONE ordinary car at t=0. Materialisation
  // resolves the trip's anchors to graph nodes through the Issue #23 contract;
  // the vehicle's own route is still A*'s, computed at spawn like everyone
  // else's, so presentation identity never buys it a different road.
  let challenge;
  try {
    challenge = materializeChallengeTrip(model, config.tripId, config.seed);
  } catch (error) {
    post({
      type: "ERROR",
      message: `curated trip ${config.tripId} unavailable: ${String((error as Error)?.message ?? error)}`,
    });
    return;
  }
  const trip = challenge.trip;
  const spawns: ScheduledSpawn[] = [challenge.spawn, ...background];

  // Resolve the ENTIRE automatic challenge before a controller executes.
  // The planner sees only frozen geography + canonical trip + traffic + seed,
  // so Fixed/Adaptive/Jev receive byte-identical adversity.
  const incidentPlan = buildChallengeIncidentPlan(
    model,
    trip,
    config.trafficLevel,
    config.seed,
  );
  // The scenario is everything about the WORLD: trip, traffic, driver, seed,
  // duration. Controller identity is deliberately absent from it.
  const scenario = buildChallengeScenario({
    tripId: config.tripId,
    trafficLevel: config.trafficLevel,
    driver: config.driver,
    seed: config.seed,
    durationMs: config.durationMs,
  });
  const engine = createEngine({
    city,
    // Bound to the real identity of the scenario built just above.
    controller: makeController(config.controller, fingerprintForRun(config)),
    spawns,
    driver: config.driver,
    incidents: {
      seed: incidentPlan.incidentSeed,
      script: [...incidentPlan.entries],
    },
  });
  state.scenario = scenario;
  state.manualIncidents = 0;
  state.modified = false;
  state.config = config;
  state.engine = engine;
  state.trip = trip;
  state.model = model;
  state.scaleIndex = scaleIndex;
  state.incidentSeed = incidentPlan.incidentSeed;
  state.incidentPlan = incidentPlan;
  state.incidentHistory = incidentPlan.entries.map((entry, id) => ({
    id,
    source: "automatic" as const,
    entry,
  }));
  state.manualIncidentSequence = 0;
  state.snapshotSequence = 0;
  capabilitySignature = null;
  postIncidentCapabilities();
  post({
    type: "READY",
    config,
    scenarioFingerprint: scenarioFingerprint(
      state.scenario ??
        buildChallengeScenario({
          tripId: config.tripId,
          trafficLevel: config.trafficLevel,
          driver: config.driver,
          seed: config.seed,
          durationMs: config.durationMs,
        }),
    ),
    scaleIndex,
    scaleLabel: CHICAGO_SCALE_LABELS[scaleIndex] ?? "Medium",
    timeMs: engine.traffic.timeMs,
    incidentSeed: incidentPlan.incidentSeed,
    incidentPlan,
    incidentHistory: state.incidentHistory.map((incident) => ({
      ...incident,
      entry: { ...incident.entry },
    })),
    incidentFingerprint: challengeIncidentFingerprintInput(
      incidentPlan,
      state.incidentHistory,
    ),
  });
  postSnapshot();
  postMetrics();
  start(); // initial state: automatically running (documented behavior)
}

/**
 * Schedule the next real tick on a FIXED cadence.
 *
 * `setTimeout(runTick, SIM_TICK_MS)` after the work makes every period
 * SIM_TICK_MS + the cost of the tick itself — measured ~125 ms per 800 ms of
 * simulated time on the Metro run, so the designed 8x playback arrived at
 * 6.0-6.4x. Subtracting the tick's own cost holds the period at SIM_TICK_MS
 * whenever the tick fits inside it, and runs back to back (no artificial delay)
 * when it does not. Scheduling only: the engine's steps — and therefore every
 * simulated result — are untouched.
 */
function scheduleNextTick(tickCostMs = 0): void {
  state.timer = setTimeout(runTick, Math.max(0, SIM_TICK_MS - tickCostMs));
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
  const startedAt = performance.now();
  const engine = state.engine;
  const config = state.config;
  if (!engine || !config || !state.running) {
    return;
  }
  try {
    for (let step = 0; step < PLAYBACK_STEPS_PER_TICK; step += 1) {
      stepEngine(engine);
      if (engine.traffic.timeMs >= config.durationMs) {
        break;
      }
    }
  } catch (error) {
    handleError(error);
    return;
  }
  // ONE frame per real tick, never one per simulated step. The renderer
  // interpolates between consecutive frames over EXPECTED_FRAME_INTERVAL_MS,
  // so the cadence has to be the real tick — posting per step floods the buffer
  // and makes the interpolation window a fraction of the frame interval, which
  // is exactly what made the car stutter.
  postSnapshot();
  postMetrics();
  if (engine.traffic.timeMs >= config.durationMs) {
    state.running = false;
    state.complete = true;
    postSnapshot();
    postMetrics();
    post({
      type: "RUN_COMPLETE",
      timeMs: engine.traffic.timeMs,
      policy: policyProvenance(),
      result: buildChallengeResult(
        engine,
        state.scenario ??
          buildChallengeScenario({
            tripId: config.tripId,
            trafficLevel: config.trafficLevel,
            driver: config.driver,
            seed: config.seed,
            durationMs: config.durationMs,
          }),
        config.controller,
        state.manualIncidents,
        state.modified,
      ),
    });
    return;
  }
  scheduleNextTick(performance.now() - startedAt);
}

function handleCommand(command: WorkerCommand): void {
  switch (command.type) {
    case "INIT": {
      buildRun({
        citySize: command.citySize,
        trafficLevel: command.trafficLevel,
        tripId: command.tripId,
        controller: command.controller,
        driver: command.driver,
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
      // are untouched; policy changes from the next tick. Switching controller
      // mid-run must not change the scenario identity: the new Jev controller is
      // bound to the run that is already in progress.
      const runningConfig = state.config;
      // Half the run under one controller and half under another is not a run
      // of either: the result stays visible but is marked non-comparable.
      state.modified = true;
      setEngineController(
        state.engine,
        makeController(command.controller, fingerprintForRun(runningConfig)),
      );
      state.config = { ...runningConfig, controller: command.controller };
      postSnapshot(); // controller id visible immediately
      return;
    }
    case "COMPARE": {
      // Headless: one scenario, two controllers, both results. Never touches
      // the live run's state — a comparison cannot disturb the city on screen.
      const model = state.model;
      if (!model) {
        post({ type: "ERROR", message: "cannot COMPARE before the city is loaded" });
        return;
      }
      try {
        const outcome = runComparison(model, {
          tripId: command.tripId,
          trafficLevel: command.trafficLevel,
          driver: command.driver,
          seed: command.seed,
          durationMs: command.durationMs ?? LIVE_RUN_HORIZON_MS,
        });
        post({
          type: "COMPARE_RESULT",
          fingerprint: outcome.fingerprint,
          driver: outcome.driver,
          tripId: outcome.tripId,
          trafficLevel: outcome.trafficLevel,
          fixed: outcome.fixed,
          adaptive: outcome.adaptive,
          verdict: outcome.verdict,
          incidentEntries: outcome.incidentEntries,
        });
      } catch (error) {
        post({ type: "ERROR", message: `comparison failed: ${String((error as Error)?.message ?? error)}` });
      }
      return;
    }
    case "SET_TRAFFIC": {
      const engine = state.engine;
      const config = state.config;
      if (!engine || !config || config.trafficLevel === command.trafficLevel) {
        break;
      }
      // Live change: the run, its clock, its trip and the ego stay exactly as
      // they are. Only NEW demand appears, generated for the new level over the
      // remaining horizon with a seed derived from (run seed, new level, now) —
      // so the same change at the same simulated time always adds the same cars.
      const nowMs = engine.traffic.timeMs;
      const horizonMs = Math.max(0, config.durationMs - nowMs);
      if (horizonMs > 0) {
        const levelIndex = Math.max(0, TRAFFIC_LEVELS.indexOf(command.trafficLevel));
        const derivedSeed = (config.seed + 0x9e37 + levelIndex * 7919 + Math.floor(nowMs / 1000)) >>> 0;
        const extra = generateDemand({
          city: engine.baseCity,
          level: command.trafficLevel,
          seed: derivedSeed,
          durationMs: horizonMs,
        })
          .filter((spawn) => spawn.timeMs > 0)
          .map((spawn) => ({ ...spawn, timeMs: spawn.timeMs + nowMs }));
        injectSpawns(engine, extra);
      }
      state.config = { ...config, trafficLevel: command.trafficLevel };
      // The scenario this run started as is no longer the scenario it is
      // playing, so its outcome cannot sit beside a clean baseline run.
      state.modified = true;
      postSnapshot();
      break;
    }
    case "INCIDENT": {
      const engine = state.engine;
      const model = state.model;
      const plan = state.incidentPlan;
      if (!engine || !model || !plan) {
        post({ type: "ERROR", message: "cannot INCIDENT before INIT" });
        return;
      }

      if (manualIncidentInput(command.kind, state.manualIncidentSequence) === null) {
        post({
          type: "INCIDENT_RESOLVED",
          kind: command.kind,
          queued: false,
          label: "Trip vehicle is not ready yet",
          incident: null,
          incidentHistory: state.incidentHistory.map((incident) => ({
            ...incident,
            entry: { ...incident.entry },
          })),
          incidentFingerprint: challengeIncidentFingerprintInput(plan, state.incidentHistory),
        });
        return;
      }

      // Manual chaos is allowed to follow the LIVE route because the human
      // asked for adversity in this exact run. Crucially, we immediately record
      // the concrete target + simulation timestamp so Issue #28 can replay this
      // exact click under another controller.
      // The exact input the applicability probe asked about: same helper, so
      // what the dock showed is what the click does.
      const resolution = resolveManualChallengeIncident(
        manualIncidentInput(command.kind, state.manualIncidentSequence) as ManualChallengeIncidentInput,
      );
      state.manualIncidentSequence += 1;

      if (!resolution.entry) {
        post({
          type: "INCIDENT_RESOLVED",
          kind: command.kind,
          queued: false,
          label: resolution.label,
          incident: null,
          incidentHistory: state.incidentHistory.map((incident) => ({
            ...incident,
            entry: { ...incident.entry },
          })),
          incidentFingerprint: challengeIncidentFingerprintInput(plan, state.incidentHistory),
        });
        return;
      }

      const id = queueIncident(engine, resolution.entry);
      const resolved: ResolvedChallengeIncident = {
        id,
        source: "manual",
        entry: resolution.entry,
      };
      state.incidentHistory.push(resolved);
      // A human touched this run: its result is no longer comparable to a clean
      // run of the same scenario.
      state.manualIncidents += 1;
      // A closure takes options away from the next click, so ask again.
      postIncidentCapabilities();
      post({
        type: "INCIDENT_RESOLVED",
        kind: command.kind,
        queued: true,
        label: resolution.label,
        incident: resolved,
        incidentHistory: state.incidentHistory.map((incident) => ({
          ...incident,
          entry: { ...incident.entry },
        })),
        incidentFingerprint: challengeIncidentFingerprintInput(plan, state.incidentHistory),
      });
      postSnapshot();
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
