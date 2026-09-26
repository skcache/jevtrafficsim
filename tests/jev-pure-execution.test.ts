/**
 * PURE JEV EXECUTION (Issue #61).
 *
 * The contract this file pins, case by case:
 *
 *   A  a delayed first response keeps simulated time at 0 until Jev is ready
 *   B  a first response that fails means the run does NOT start, and no
 *      Adaptive controller ever executes
 *   C  a successful first policy starts the run under Jev
 *   D  a refresh that fails temporarily leaves the last Jev policy in force,
 *      reported as HELD, with fallbackMs still 0
 *   E  Jev unavailable beyond the maximum hold INVALIDATES the run — it stops,
 *      keeps its measurements, and is never continued under anything else
 *   F  a healthy run is 100% fresh-or-held Jev: every simulated millisecond is
 *      accounted to an accepted policy, and the Adaptive zeros are stated
 *   G  a neutral policy still comes from an accepted Jev response
 *   H  the accelerated tail after the ego arrives holds the last policy, asks
 *      for nothing, and creates no coverage gap
 *   I  no code path in a live Jev run can reach an Adaptive decision at all
 *      (proven by an Adaptive module whose constructor and decisions count)
 *
 * Nothing here weakens a signal-safety bound or changes what the simulation
 * does: the engine still owns min green, max green, yellow, all-red and
 * starvation, and the directives are the same ones the earlier suites pin.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createJevController, type JevController } from "@/controllers/jev";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import type { TrafficController } from "@/controllers/contract";
import { JevClientError, createMockJevClient, type JevClient } from "@/jev/client";
import {
  isPromiseLike,
  JEV_RUNTIME_DEFAULTS,
  type JevStartOutcome,
} from "@/jev/runtime";
import { JEV_SCHEMA_VERSION, neutralJevPolicy } from "@/jev/schema";
import {
  controllerObservation,
  finishRunController,
  startRunController,
} from "@/worker/challenge-compare";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { buildObservationFrame } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import { makeCrossroads } from "./traffic-support";

/* ------------------------------- the Adaptive spy -------------------------- */

/**
 * Every construction of, and every decision asked of, an Adaptive controller in
 * this file is COUNTED. The Jev controller must never move either counter: if it
 * ever consults an Adaptive controller — at startup, on a failure, on expiry,
 * anywhere — these tests fail.
 */
const adaptiveCalls = vi.hoisted(() => ({ constructions: 0, decisions: 0 }));

vi.mock("@/controllers/adaptive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/controllers/adaptive")>();
  return {
    ...actual,
    createAdaptiveController: (...args: Parameters<typeof actual.createAdaptiveController>) => {
      adaptiveCalls.constructions += 1;
      const controller = actual.createAdaptiveController(...args);
      return {
        ...controller,
        directives: (...directiveArgs: Parameters<typeof controller.directives>) => {
          adaptiveCalls.decisions += 1;
          return controller.directives(...directiveArgs);
        },
      };
    },
  };
});

/* --------------------------------- fixtures -------------------------------- */

/**
 * One crossroads with the CONTROLLER UNDER TEST inside its engine: the engine is
 * what asks for directives (sim/engine.ts), so the run's controller is the one
 * the engine holds — never a controller the test drives beside it.
 */
function crossroads(controller: TrafficController): { engine: EngineState; partition: CityPartition } {
  const built = makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 120 },
      { angleDeg: 90, length: 120 },
      { angleDeg: 180, length: 120 },
      { angleDeg: 270, length: 120 },
    ],
  });
  return {
    engine: createEngine({ city: built.city, controller, spawns: [] }),
    partition: buildCityPartition(built.city),
  };
}

function policy(scale = 1.2) {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    pressureScale: scale,
    hint: "neutral" as const,
    corridorWeights: [],
    regionWeights: [],
  };
}

/** The gate's answer for a client that answers inline. */
function startedSync(outcome: JevStartOutcome | Promise<JevStartOutcome>): JevStartOutcome {
  if (isPromiseLike<JevStartOutcome>(outcome)) {
    throw new Error("this client answers inline: the gate must be synchronous");
  }
  return outcome;
}

/** One simulated tick, through the controller the engine holds. */
function tick(engine: EngineState, partition: CityPartition): void {
  const controller = engine.controller as Partial<JevController>;
  controller.directives?.(engine.city, engine.traffic, {
    observations: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition,
  });
  stepEngine(engine);
}

/* ---------------------------------- cases ---------------------------------- */

describe("A. the startup gate holds simulated time at zero", () => {
  it("does not advance a single millisecond until the first policy is accepted", async () => {
    let answer: ((value: unknown) => void) | null = null;
    const controller = createJevController({
      client: { id: "mock", requestPolicy: () => new Promise((resolve) => (answer = resolve)) },
      scenarioFingerprint: "gate-A",
    });
    const { engine } = crossroads(controller);

    // The gate is asked for the first policy and has no answer yet.
    const started = controller.start(controllerObservation(engine));
    expect(isPromiseLike<JevStartOutcome>(started)).toBe(true);
    const pendingStart = started as Promise<JevStartOutcome>;

    // The run is WAITING: no simulated time, no policy, no other decider.
    expect(engine.traffic.timeMs).toBe(0);
    expect(controller.status().source).toBe("waiting");
    expect(controller.policy()).toBeNull();
    expect(controller.status().accepted).toBe(0);
    expect(controller.status().fallbackMs).toBe(0);
    expect(controller.status().adaptiveTicks).toBe(0);

    // The answer arrives: the gate passes and the run may begin.
    (answer as unknown as (value: unknown) => void)(policy(1.25));
    expect((await pendingStart).state).toBe("ready");
    expect(engine.traffic.timeMs).toBe(0); // still nothing simulated while waiting
    expect(controller.status().accepted).toBe(1);
    expect(controller.status().source).toBe("live");
    expect(controller.policy()?.pressureScale).toBe(1.25);
  });
});

describe("B. a first response that fails stops the run before it starts", () => {
  it("reports the run as unable to start, and simulates nothing", () => {
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => {
          throw new JevClientError("upstream-error", "jev gateway responded 503");
        },
      },
      scenarioFingerprint: "gate-B",
    });
    const { engine } = crossroads(controller);
    const started = startedSync(controller.start(controllerObservation(engine)));
    expect(started.state).toBe("unable");
    if (started.state !== "unable") {
      throw new Error("the gate must report the run as unable to start");
    }
    expect(started.reason).toBe("upstream-error");
    expect(started.attempts).toBe(JEV_RUNTIME_DEFAULTS.START_ATTEMPTS);
    // Nothing was simulated, nothing was substituted, and the failure is named.
    expect(engine.traffic.timeMs).toBe(0);
    expect(controller.status().accepted).toBe(0);
    expect(controller.status().source).toBe("waiting");
    expect(controller.status().fallbackMs).toBe(0);
    expect(controller.status().adaptiveTicks).toBe(0);
    expect(controller.status().causes["upstream-error"]).toBeGreaterThan(0);
    // The driver seam reports the same thing the controller does.
    const driverStart = startedSync(startRunController(engine));
    expect(driverStart.state).toBe("unable");
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });

  it("never asks an Adaptive controller, even when the client throws nonsense", () => {
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => {
          throw new Error("service exploded");
        },
      },
      scenarioFingerprint: "gate-B2",
      startAttempts: 1,
    });
    const { engine, partition } = crossroads(controller);
    const started = startedSync(controller.start(controllerObservation(engine)));
    expect(started.state).toBe("unable");
    if (started.state !== "unable") {
      throw new Error("the gate must report the run as unable to start");
    }
    // Unclassified is reported as unclassified — and nothing else decides.
    expect(started.reason).toBe("unknown");
    for (let index = 0; index < 5; index += 1) {
      tick(engine, partition);
    }
    expect(controller.status().fallbackMs).toBe(0);
    expect(controller.status().adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

describe("C. a successful first policy starts the run under Jev", () => {
  it("governs the very first tick, with no ungoverned instant at all", () => {
    const controller = createJevController({
      client: { id: "mock", requestPolicy: () => policy(1.3) },
      scenarioFingerprint: "gate-C",
    });
    const { engine, partition } = crossroads(controller);
    expect(startedSync(controller.start(controllerObservation(engine))).state).toBe("ready");
    expect(controller.status().source).toBe("live");
    for (let index = 0; index < 20; index += 1) {
      tick(engine, partition);
    }
    finishRunController(engine);
    const status = controller.status();
    expect(status.invalidMs).toBe(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.invalidMs).toBe(0);
    expect(controller.invalidation()).toBeNull();
  });
});

describe("D. a refresh that fails leaves the last policy in force, as HELD", () => {
  it("keeps governing, reports heldMs, and never reports fallback time", async () => {
    let answers = 0;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        answers += 1;
        // The first policy is answered; every refresh after it fails, for good.
        return answers === 1
          ? policy(1.4)
          : Promise.reject(new JevClientError("timeout", "jev relay request timed out"));
      },
    };
    const controller = createJevController({
      client,
      scenarioFingerprint: "held-D",
      refreshMs: 500,
      ttlMs: 1_000,
      maxHoldMs: 30_000,
    });
    const { engine, partition } = crossroads(controller);
    expect((await controller.start(controllerObservation(engine))).state).toBe("ready");

    for (let index = 0; index < 40; index += 1) {
      tick(engine, partition);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    finishRunController(engine);
    const status = controller.status();

    // The model's own policy governed every millisecond of the run...
    expect(status.accepted).toBe(1);
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.invalidMs).toBe(0);
    // ...part of it past its freshness window, reported as HELD and not as fresh.
    expect(status.heldMs).toBeGreaterThan(0);
    expect(status.heldMs).toBeLessThan(status.liveMs);
    expect(controller.policy()?.pressureScale).toBe(1.4);
    // The failures are counted and classified, and they cost no fallback time.
    expect(status.rejected).toBeGreaterThan(0);
    expect(status.causes.timeout).toBeGreaterThan(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

describe("E. Jev unavailable beyond the maximum hold invalidates the run", () => {
  it("stops the run, keeps its measurements, and never substitutes for Jev", async () => {
    let answers = 0;
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => {
          answers += 1;
          return answers === 1
            ? policy(1.5)
            : Promise.reject(new JevClientError("timeout", "jev relay request timed out"));
        },
      },
      scenarioFingerprint: "invalidated-E",
      refreshMs: 500,
      ttlMs: 1_000,
      maxHoldMs: 2_000,
    });
    const { engine, partition } = crossroads(controller);
    expect((await controller.start(controllerObservation(engine))).state).toBe("ready");

    // Drive until the invalidation is reported — the driver's stop condition.
    let ticks = 0;
    while (controller.invalidation() === null && ticks < 200) {
      tick(engine, partition);
      ticks += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const invalidation = controller.invalidation();
    expect(invalidation).not.toBeNull();
    expect(invalidation?.reason).toBe("expired");
    expect(invalidation?.atSimMs).toBeGreaterThan(0);

    // The run stopped there: it kept its measurements and produced no result.
    finishRunController(engine);
    const status = controller.status();
    expect(status.source).toBe("invalidated");
    expect(status.accepted).toBe(1);
    expect(status.liveMs).toBeGreaterThan(0);
    expect(status.liveMs).toBe(invalidation?.atSimMs);
    expect(status.invalidMs).toBeGreaterThan(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    // The refused refreshes are classified, and no Adaptive controller decided.
    expect(status.causes.timeout).toBeGreaterThan(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

describe("F. a healthy run is 100% fresh-or-held Jev", () => {
  it("accounts every simulated millisecond to an accepted policy", async () => {
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => new Promise((resolve) => setTimeout(() => resolve(policy(1.1)), 1)),
      },
      scenarioFingerprint: "healthy-F",
      refreshMs: 500,
      ttlMs: 1_000,
    });
    const { engine, partition } = crossroads(controller);
    expect((await controller.start(controllerObservation(engine))).state).toBe("ready");
    for (let index = 0; index < 40; index += 1) {
      tick(engine, partition);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    finishRunController(engine);
    const status = controller.status();
    const meta = controller.meta();

    // Every instant was governed by a policy this run accepted...
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.invalidMs).toBe(0);
    expect(status.invalidation).toBeNull();
    // ...in a fresh or held state, and never by anything else.
    expect(status.liveMs).toBeGreaterThan(status.heldMs);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    expect(meta.fallbackMs).toBe(0);
    expect(meta.adaptiveTicks).toBe(0);
    expect(meta.invalidMs).toBe(0);
    expect(status.accepted).toBeGreaterThan(0);
    expect(status.refreshTelemetry.outcomes.live).toBeGreaterThan(0);
    expect(status.refreshTelemetry.outcomes.ungoverned).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

describe("G. a neutral policy is still a Jev response", () => {
  it("comes from an accepted answer, never from an Adaptive controller", () => {
    const neutral = neutralJevPolicy();
    const controller = createJevController({
      client: createMockJevClient({ respond: () => neutral }),
      scenarioFingerprint: "neutral-G",
    });
    const { engine, partition } = crossroads(controller);
    expect(startedSync(controller.start(controllerObservation(engine))).state).toBe("ready");
    for (let index = 0; index < 10; index += 1) {
      tick(engine, partition);
    }
    finishRunController(engine);

    // The policy in force IS the answer the client served, and the run's own
    // trace says where it came from.
    const inForce = controller.policy();
    expect(inForce).toEqual(neutral);
    const trace = controller.trace();
    expect(trace.events).toHaveLength(1);
    expect(trace.client).toBe("mock");
    expect(trace.events[0].source).toBe("live");
    expect(trace.events[0].policy).toEqual(neutral);
    expect(trace.events[0].requestGeneration).toBeGreaterThan(0);
    expect(controller.status().liveMs).toBe(engine.traffic.timeMs);
    expect(controller.status().fallbackMs).toBe(0);
    expect(controller.status().adaptiveTicks).toBe(0);
    expect(adaptiveCalls.constructions).toBe(0);
    expect(adaptiveCalls.decisions).toBe(0);
  });
});

describe("H. the accelerated tail is held Jev, not a gap", () => {
  it("asks for nothing, holds the last policy, and invalidates nothing", () => {
    let requests = 0;
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => {
          requests += 1;
          return policy(1.2);
        },
      },
      scenarioFingerprint: "tail-H",
      refreshMs: 500,
      ttlMs: 1_000,
      // The app's own shape, scaled down: the maximum hold covers the whole
      // tail, which is what makes a held tail Jev control rather than a gap.
      maxHoldMs: 60_000,
    });
    const { engine, partition } = crossroads(controller);
    expect(startedSync(controller.start(controllerObservation(engine))).state).toBe("ready");
    for (let index = 0; index < 12; index += 1) {
      tick(engine, partition);
    }
    const beforeTail = requests;
    const timeBeforeTail = engine.traffic.timeMs;

    // The app's tail: the rest of the horizon, simulated back to back. The
    // runtime is told, and stops asking — an unpaced burst of requests that
    // could never be answered is exactly what rate-limited the gateway.
    controller.beginAcceleratedTail();
    for (let index = 0; index < 60; index += 1) {
      tick(engine, partition);
    }
    finishRunController(engine);

    const status = controller.status();
    expect(requests).toBe(beforeTail); // not one request during the tail
    expect(engine.traffic.timeMs - timeBeforeTail).toBeGreaterThan(1_000);
    // The tail is governed by the last accepted policy, reported as held.
    expect(status.liveMs).toBe(engine.traffic.timeMs);
    expect(status.heldMs).toBeGreaterThan(engine.traffic.timeMs - timeBeforeTail - 1_000);
    expect(status.invalidMs).toBe(0);
    expect(status.invalidation).toBeNull();
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
    // The tail's windows are recorded as HELD, so the record says where the
    // time went rather than leaving it unexplained.
    const tailWindows = status.refreshTelemetry.recent.filter(
      (event) => event.atSimMs >= timeBeforeTail && event.skipped,
    );
    expect(tailWindows.length).toBeGreaterThan(0);
    expect(tailWindows.every((event) => event.outcome === "held")).toBe(true);
    expect(tailWindows[0].detail).toContain("accelerated tail");
  });

  it("does not invalidate a healthy tail that outruns the refresh loop", async () => {
    // A run whose last accepted policy is comfortably inside its hold when the
    // ego arrives: the tail (up to ~200 s of simulated time) is covered, so the
    // run is never invalidated by the fact that it stopped asking.
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => new Promise((resolve) => setTimeout(() => resolve(policy(1.2)), 1)),
      },
      scenarioFingerprint: "tail-H2",
      refreshMs: 500,
      ttlMs: 1_000,
      maxHoldMs: 300_000,
    });
    const { engine, partition } = crossroads(controller);
    expect((await controller.start(controllerObservation(engine))).state).toBe("ready");
    for (let index = 0; index < 20; index += 1) {
      tick(engine, partition);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const acceptedAt = controller.status().acceptedAtSimMs ?? 0;
    controller.beginAcceleratedTail();
    // 250 s of simulated time: more than the whole curated tail, less than the
    // 300 s hold that starts when the policy was accepted.
    for (let index = 0; index < 2_500; index += 1) {
      tick(engine, partition);
    }
    finishRunController(engine);
    const status = controller.status();
    expect(engine.traffic.timeMs - acceptedAt).toBeLessThan(status.maxHoldMs);
    expect(controller.invalidation()).toBeNull();
    expect(status.invalidMs).toBe(0);
    expect(status.heldMs).toBeGreaterThan(200_000);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
  });
});

describe("I. no live Jev run can reach an Adaptive decision", () => {
  it("counts an Adaptive construction when one really happens (the spy works)", () => {
    // The control that gives the zeros above their meaning: an Adaptive
    // controller built BY THIS TEST moves both counters, so a zero elsewhere is
    // a real absence and not a broken spy.
    const before = adaptiveCalls.constructions;
    const reference = createAdaptiveController();
    expect(reference.id).toBe("adaptive");
    expect(adaptiveCalls.constructions).toBe(before + 1);
    const { engine, partition } = crossroads(reference);
    for (let index = 0; index < 3; index += 1) {
      tick(engine, partition);
    }
    expect(adaptiveCalls.decisions).toBeGreaterThan(0);
    // ...and the Jev runs in this file moved neither counter.
    expect(adaptiveCalls.constructions).toBe(1);
  });

  it("has no Adaptive controller in the controller's own source", () => {
    const source = readFileSync(new URL("../controllers/jev.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/import[^;\n]*createAdaptiveController/);
    expect(source).not.toMatch(/createAdaptiveController\s*\(/);
    expect(source).not.toContain("createFixedController");
    // The one thing it shares with the Adaptive module is the pure
    // signal-mechanics vocabulary, never a controller.
    expect(source).toContain('import { phasePressure, starvedPhaseIndex } from "./adaptive";');
  });

  it("has no fallback vocabulary left in the runtime's source", () => {
    const source = readFileSync(new URL("../jev/runtime.ts", import.meta.url), "utf8");
    expect(source).not.toContain("createAdaptiveController");
    // `fallbackMs` survives as a hard zero, but nothing can ever add to it.
    expect(source).not.toMatch(/fallbackMs\s*\+=/);
    expect(source).not.toContain('source: "fallback"');
  });

  it("wires the honest stops into the UI: a stopped run is never a result", () => {
    const source = readFileSync(new URL("../components/TrafficSimulator.tsx", import.meta.url), "utf8");
    // The startup gate has its own waiting state...
    expect(source).toContain('case "JEV_STARTING"');
    expect(source).toContain('case "JEV_READY"');
    // ...a run that could not start reports the truth in plain words...
    expect(source).toContain('case "JEV_UNABLE"');
    expect(source).toContain("runUnableMessage(data.reason, data.detail)");
    // ...and an invalidated run NEVER becomes the visible Jev result: no
    // completion, no live result, no comparison.
    expect(source).toContain('case "RUN_INVALIDATED"');
    expect(source).toMatch(/case "RUN_INVALIDATED"[\s\S]{0,700}?store\.setRunComplete\(false\)/);
    expect(source).toMatch(/case "RUN_INVALIDATED"[\s\S]{0,700}?store\.setLiveResult\(null\)/);
  });

  it("keeps the worker's Jev path gated, tail-aware and stop-on-invalidation", () => {
    const source = readFileSync(new URL("../worker/simulation.worker.ts", import.meta.url), "utf8");
    // The startup gate, the tail handshake, and the honest stop.
    expect(source).toContain("await beginRun(buildToken);");
    expect(source).toContain("control?.beginAcceleratedTail();");
    expect(source).toContain("stopInvalidated(engine, config, invalidation);");
    expect(source).toContain("void gateSwitchedController(engine);");
    // And the invalidation is checked on EVERY tick, including inside the tail.
    expect(source).toMatch(/const invalidation = jevRunControl\(engine\)\?\.invalidation\(\) \?\? null;/);
  });
});

describe("J. a controller switched in mid-run passes the same gate", () => {
  it("waits for its first policy at the run's own clock, not at zero", () => {
    const { engine, partition } = crossroads(createFixedController());
    for (let index = 0; index < 20; index += 1) {
      tick(engine, partition); // the run is already at t=2000
    }
    const switched = createJevController({
      client: { id: "mock", requestPolicy: () => policy(1.2) },
      scenarioFingerprint: "switch-J",
      refreshMs: 500,
      ttlMs: 1_000,
      maxHoldMs: 30_000,
    });
    // The switch installs the controller in the engine, exactly as the worker's
    // SET_CONTROLLER does — and then the run WAITS for its first policy instead
    // of stepping without one.
    engine.controller = switched;
    const started = startedSync(switched.start(controllerObservation(engine)));
    expect(started.state).toBe("ready");
    // The policy is accepted at the RUN's own instant, so it governs from there
    // (not from zero, which would give it a hold window it never earned).
    expect(switched.status().acceptedAtSimMs).toBe(2_000);
    expect(switched.status().source).toBe("live");
    for (let index = 0; index < 10; index += 1) {
      tick(engine, partition);
    }
    finishRunController(engine);
    const status = switched.status();
    expect(status.liveMs).toBe(engine.traffic.timeMs - 2_000);
    expect(status.invalidMs).toBe(0);
    expect(status.fallbackMs).toBe(0);
    expect(status.adaptiveTicks).toBe(0);
  });
});

/* ------------------------------- the accounting ---------------------------- */

describe("telemetry and provenance are provable after a completed live run", () => {
  it("states every zero, and every non-zero, the contract is about", async () => {
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: () => new Promise((resolve) => setTimeout(() => resolve(policy(1.15)), 1)),
      },
      scenarioFingerprint: "telemetry-provable",
      refreshMs: 500,
      ttlMs: 1_000,
      maxHoldMs: 60_000,
    });
    const { engine, partition } = crossroads(controller);
    expect((await controller.start(controllerObservation(engine))).state).toBe("ready");
    for (let index = 0; index < 30; index += 1) {
      tick(engine, partition);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    controller.beginAcceleratedTail();
    for (let index = 0; index < 40; index += 1) {
      tick(engine, partition);
    }
    finishRunController(engine);
    const meta = controller.meta();
    const telemetry = meta.telemetry;

    // Adaptive decision ticks: 0 — and no fallback time, no fallback windows.
    expect(meta.adaptiveTicks).toBe(0);
    expect(meta.fallbackMs).toBe(0);
    expect(telemetry.outcomes.ungoverned).toBe(0);
    // At least one accepted live policy, and the governed/held split.
    expect(meta.accepted).toBeGreaterThanOrEqual(1);
    expect(meta.liveMs).toBeGreaterThan(0);
    expect(meta.heldMs).toBeGreaterThan(0);
    expect(meta.heldMs).toBeLessThan(meta.liveMs);
    // Accepted and rejected refreshes, with a reason for every rejection.
    expect(meta.refreshes).toBeGreaterThan(meta.accepted);
    expect(telemetry.outcomes.live).toBe(meta.accepted);
    expect(meta.rejected).toBeGreaterThan(0);
    for (const event of telemetry.recent.filter((row) => row.outcome !== "live")) {
      expect(event.reason).not.toBeNull();
      expect(event.detail.length).toBeGreaterThan(0);
    }
    // Whether an accepted policy was degraded by confidence filtering.
    expect(typeof meta.dropped).toBe("number");
    expect(typeof meta.clamped).toBe("number");
    // Whether the run was invalidated because Jev disappeared: it was not.
    expect(meta.invalidation).toBeNull();
    expect(meta.invalidMs).toBe(0);
    expect(meta.start?.state).toBe("ready");
    // The simulated window is fully accounted, to the millisecond.
    expect(meta.liveMs + meta.replayMs + meta.invalidMs + meta.fallbackMs).toBe(
      engine.traffic.timeMs,
    );
  });
});
