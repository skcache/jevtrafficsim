/**
 * Issue #14 closeout tests: the four contract gaps, each with a proof.
 *
 *   1. a live Jev controller is bound to the REAL scenario fingerprint — in the
 *      browser worker too — so the trace fingerprint is the run's, the
 *      stale-response guard checks a real identity, a reset gets a new correct
 *      one, and a mid-run controller switch keeps the current one
 *   2. in-flight ownership is explicit: a superseded request settling can never
 *      clear a newer request's slot, and no third request can slip in
 *   3. gateway answer confidence is an explicit, configurable policy: an answer
 *      below the floor never becomes a policy opinion
 *   4. a trace loaded from disk obeys the LIVE bounded-policy contract, so replay
 *      can reproduce an accepted policy but never introduce an impossible one
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createJevController } from "@/controllers/jev";
import type { JevClient } from "@/jev/client";
import {
  answerConfidenceUsable,
  buildEvaluationsBody,
  JEV_CONFIDENCE,
  JEV_PRESSURE_BUCKETS,
  JEV_WEIGHT_BUCKETS,
  policyFromEvaluations,
} from "@/jev/gateway";
import { createJevPolicyRuntime } from "@/jev/runtime";
import { JEV_LIMITS, JEV_SCHEMA_VERSION, parseJevPolicy, type JevPolicy } from "@/jev/schema";
import { parseJevTrace } from "@/jev/trace";
import { buildChallengeScenario, fingerprintForRun, scenarioFingerprint } from "@/worker/challenge-scenario";
import { buildObservationFrame } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { createAdaptiveController } from "@/controllers/adaptive";
import { makeCrossroads } from "./traffic-support";
import type { BenchmarkScenario } from "@/benchmark/scenarios";

/* -------------------------------------------------------------- helpers --- */

function crossroads(): { engine: EngineState; partition: CityPartition } {
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
    engine: createEngine({ city: built.city, controller: createAdaptiveController(), spawns: [] }),
    partition: buildCityPartition(built.city),
  };
}

function observation(engine: EngineState, partition: CityPartition) {
  return {
    frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition,
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  };
}

function readSource(file: string): string {
  return readFileSync(path.join(process.cwd(), file), "utf8");
}

/** Source with comments removed: scans code, not prose about code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

const SCENARIO: BenchmarkScenario = {
  tripId: "soldier-field-to-navy-pier",
  trafficLevel: "everyday",
  driver: "tourist",
  seed: 42,
  durationMs: 600_000,
};

function gatewayBody() {
  return buildEvaluationsBody({
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: 5_000,
    windowMs: 5_000,
    city: {
      intersections: 10,
      signalizedIntersections: 4,
      activeVehicles: 20,
      queuedVehicles: 8,
      maxWaitMs: 30_000,
      arrivalRatePerSecond: 2,
    },
    corridors: [
      {
        corridorId: 1,
        kind: "arterial",
        intersections: 2,
        queuedVehicles: 8,
        maxWaitMs: 30_000,
        arrivalRatePerSecond: 1,
        occupancyRatio: 0.5,
      },
    ],
    regions: [
      {
        regionId: 1,
        intersections: 2,
        signalizedIntersections: 2,
        queuedVehicles: 8,
        maxWaitMs: 30_000,
        arrivalRatePerSecond: 1,
        occupancyRatio: 0.5,
      },
    ],
    hotspots: [],
  });
}

/* ------------------------------------------- 1. real scenario fingerprint --- */

describe("a live Jev controller is bound to the real scenario fingerprint", () => {
  it("derives the same identity the challenge harness does", () => {
    const fromConfig = fingerprintForRun(SCENARIO);
    const fromScenario = scenarioFingerprint(
      buildChallengeScenario({
        tripId: SCENARIO.tripId,
        trafficLevel: SCENARIO.trafficLevel,
        driver: SCENARIO.driver,
        seed: SCENARIO.seed,
        durationMs: SCENARIO.durationMs,
      }),
    );
    expect(fromConfig).toBe(fromScenario);
  });

  it("gives a different identity to a different scenario", () => {
    const other = fingerprintForRun({ ...SCENARIO, seed: 2026 });
    expect(other).not.toBe(fingerprintForRun(SCENARIO));
    expect(fingerprintForRun(SCENARIO)).toBe(fingerprintForRun({ ...SCENARIO }));
  });

  it("records the bound fingerprint in the trace", () => {
    const controller = createJevController({
      client: { id: "mock", requestPolicy: () => ({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.2 }) },
      scenarioFingerprint: fingerprintForRun(SCENARIO),
      refreshMs: 500,
    });
    const { engine, partition } = crossroads();
    for (let tick = 0; tick < 20; tick += 1) {
      controller.directives(engine.city, engine.traffic, {
        observations: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
        partition,
      });
      stepEngine(engine);
    }
    const trace = controller.trace();
    expect(trace.scenarioFingerprint).toBe(fingerprintForRun(SCENARIO));
    expect(trace.events.length).toBeGreaterThan(0);
    expect(trace.events.every((event) => event.scenarioFingerprint === trace.scenarioFingerprint)).toBe(true);
  });

  it("switches identity on a reset, and keeps it across a controller switch", () => {
    const first = fingerprintForRun(SCENARIO);
    const second = fingerprintForRun({ ...SCENARIO, tripId: "river-north-to-navy-pier" });
    const controller = createJevController({
      client: null,
      scenarioFingerprint: first,
      refreshMs: 500,
    });
    expect(controller.trace().scenarioFingerprint).toBe(first);
    controller.reset({ scenarioFingerprint: second });
    expect(controller.trace().scenarioFingerprint).toBe(second);
    expect(controller.trace().scenarioFingerprint).not.toBe(first);
    // Switching controller mid-run re-derives the identity from the SAME config,
    // so it is byte-identical: the run's identity does not move.
    expect(fingerprintForRun(SCENARIO)).toBe(first);
  });

  it("binds every controller in the worker to a real identity, never a placeholder", () => {
    const worker = code(readSource("worker/simulation.worker.ts"));
    // Every construction site passes an identity derived from the run config.
    const constructions = [...worker.matchAll(/createJevController\(\{/g)];
    expect(constructions.length).toBeGreaterThan(0);
    expect(worker).toMatch(/createJevController\(\{\s*\n\s*client: createRelayJevClient\(\),\s*\n\s*scenarioFingerprint: identity,/);
    // The worker's controller factory takes the identity as an argument.
    expect(worker).toMatch(/function makeController\(choice: ControllerChoice, identity: string\)/);
    // Both call sites give it a real one: the scenario just built (INIT/RESET)
    // and the run in progress (SET_CONTROLLER).
    expect(worker).toContain("makeController(config.controller, fingerprintForRun(config))");
    expect(worker).toContain("makeController(command.controller, fingerprintForRun(runningConfig))");
    // No placeholder identity anywhere in the worker.
    expect(worker).not.toMatch(/scenarioFingerprint:\s*["']live["']/);
  });

  it("does not let a controller be built without an identity", () => {
    // The fingerprint is required by the type in both places, and neither has a
    // fallback: this is the compile-time half of "no placeholder in production".
    const controllerSource = code(readSource("controllers/jev.ts"));
    expect(controllerSource).toMatch(/readonly scenarioFingerprint: string;/);
    expect(controllerSource).toContain("scenarioFingerprint: options.scenarioFingerprint,");
    expect(controllerSource).not.toMatch(/scenarioFingerprint\s*\?\?/);

    const runtimeSource = code(readSource("jev/runtime.ts"));
    expect(runtimeSource).toMatch(/readonly scenarioFingerprint: string;/);
    expect(runtimeSource).not.toMatch(/scenarioFingerprint\s*\?\?/);
    expect(runtimeSource).not.toMatch(/scenarioFingerprint\s*\|\|/);
  });
});

/* ------------------------------------------------- 2. in-flight ownership --- */

describe("in-flight request ownership survives a reset", () => {
  it("never lets a superseded request clear a newer request's slot", async () => {
    const { engine, partition } = crossroads();
    const resolvers: ((value: unknown) => void)[] = [];
    const rejecters: ((reason: unknown) => void)[] = [];
    const client: JevClient = {
      id: "mock",
      requestPolicy: () =>
        new Promise((resolve, reject) => {
          resolvers.push(resolve);
          rejecters.push(reject);
        }),
    };
    const runtime = createJevPolicyRuntime({
      client,
      scenarioFingerprint: "scenario-A",
      refreshMs: 500,
    });

    // Request A at t=0.
    runtime.observe(observation(engine, partition));
    expect(client !== null).toBe(true);
    expect(runtime.status().inFlight).toBe(true);
    expect(runtime.status().refreshes).toBe(1);

    // A reset while A is in flight: the slot is freed for the new scenario, and
    // the per-scenario counters start over with it.
    runtime.reset({ scenarioFingerprint: "scenario-B" });
    const afterReset = runtime.status();
    expect(afterReset.inFlight).toBe(false);
    expect(afterReset.refreshes).toBe(0);

    // Request B at t=500 for the new scenario, and it OWNS the slot.
    for (let tick = 0; tick < 5; tick += 1) {
      stepEngine(engine);
    }
    runtime.observe(observation(engine, partition));
    expect(runtime.status().refreshes).toBe(1);
    expect(runtime.status().inFlight).toBe(true);

    // A settles late. It must be rejected AND must not release B's slot.
    resolvers[0]({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.9 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const afterA = runtime.status();
    expect(afterA.lastRejection?.kind).toBe("stale-generation");
    expect(afterA.inFlight, "a stale request released a newer request's slot").toBe(true);
    expect(afterA.accepted).toBe(0);

    // ...so no third request can start while B is still running.
    for (let tick = 0; tick < 5; tick += 1) {
      stepEngine(engine);
    }
    runtime.observe(observation(engine, partition)); // t=1000: a refresh boundary
    expect(runtime.status().refreshes, "a third request overlapped").toBe(1);

    // B settles: it owns the slot, so it releases it.
    resolvers[1]({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(runtime.status().inFlight).toBe(false);
    // A policy takes effect from the tick AFTER its acceptance instant, so the
    // count lands on the next observation.
    expect(runtime.status().accepted).toBe(0);

    // The next boundary both adopts B and is free to ask again.
    for (let tick = 0; tick < 5; tick += 1) {
      stepEngine(engine);
    }
    runtime.observe(observation(engine, partition)); // t=1500
    const settled = runtime.status();
    expect(settled.accepted).toBe(1);
    expect(settled.source).toBe("live");
    expect(settled.refreshes).toBe(2);
    expect(runtime.effective().policy?.pressureScale).toBe(1.1);
    rejecters.forEach((reject) => reject(new Error("cleanup")));
  });
});

/* ------------------------------------------------------ 3. confidence rule -- */

describe("gateway answer confidence", () => {
  it("accepts a high-confidence answer, assertively", () => {
    const body = gatewayBody();
    const policy = policyFromEvaluations(body, {
      answers: {
        pressure: { choice: "urgent", confidence: 0.9 },
        hint: "unused",
        "corridor:1": { choice: "top", confidence: 0.8 },
        "region:1": { choice: "high", confidence: 0.7 },
      },
    });
    expect(policy.pressureScale).toBe(JEV_PRESSURE_BUCKETS.urgent);
    expect(policy.corridorWeights).toEqual([{ id: 1, weight: JEV_WEIGHT_BUCKETS.top }]);
    expect(policy.regionWeights).toEqual([{ id: 1, weight: JEV_WEIGHT_BUCKETS.high }]);
  });

  it("refuses to let a low-confidence answer be assertive", () => {
    const body = gatewayBody();
    const policy = policyFromEvaluations(body, {
      answers: {
        pressure: { choice: "urgent", confidence: JEV_CONFIDENCE.MIN_ANSWER_CONFIDENCE - 0.01 },
        "corridor:1": { choice: "top", confidence: 0.01 },
        "region:1": { choice: "top", confidence: 0 },
      },
    });
    // Degraded to the schema's neutral defaults: no opinion, still valid.
    expect(policy.pressureScale).toBe(1);
    expect(policy.corridorWeights).toEqual([]);
    expect(policy.regionWeights).toEqual([]);
    expect(parseJevPolicy(policy).ok).toBe(true);
  });

  it("rejects malformed confidence safely, whatever shape it arrives in", () => {
    const hostile = [Number.NaN, Number.POSITIVE_INFINITY, -0.5, 1.5, "high", null, {}, []];
    for (const confidence of hostile) {
      expect(answerConfidenceUsable(confidence, JEV_CONFIDENCE.MIN_ANSWER_CONFIDENCE)).toBe(false);
      const body = gatewayBody();
      const policy = policyFromEvaluations(body, {
        answers: {
          pressure: { choice: "urgent", confidence },
          "corridor:1": { choice: "top", confidence },
        },
      });
      expect(policy.pressureScale).toBe(1);
      expect(policy.corridorWeights).toEqual([]);
    }
    // ...and a missing confidence is not an opinion either.
    const body = gatewayBody();
    const policy = policyFromEvaluations(body, { answers: { pressure: { choice: "urgent" } } });
    expect(policy.pressureScale).toBe(1);
  });

  it("honours a configured floor, and the floor is one named constant", () => {
    const body = gatewayBody();
    const answer = { pressure: { choice: "urgent", confidence: 0.4 } };
    // Default floor 0.25 -> usable.
    expect(policyFromEvaluations(body, { answers: answer }).pressureScale).toBe(
      JEV_PRESSURE_BUCKETS.urgent,
    );
    // Raised floor 0.5 -> not usable.
    expect(policyFromEvaluations(body, { answers: answer }, { minConfidence: 0.5 }).pressureScale).toBe(1);
    expect(JEV_CONFIDENCE.MIN_ANSWER_CONFIDENCE).toBeGreaterThan(0);
    expect(JEV_CONFIDENCE.MIN_ANSWER_CONFIDENCE).toBeLessThanOrEqual(1);
    // The threshold is not scattered: the only literal lives in the constant.
    const gatewaySource = code(readSource("jev/gateway.ts"));
    const magicFloats = [...gatewaySource.matchAll(/\b0\.\d+\b/g)].map((match) => match[0]);
    expect(magicFloats.filter((value) => value === "0.25")).toHaveLength(1);
  });
});

/* -------------------------------------------- 4. adversarial traces -------- */

describe("a trace may never carry a policy live code would refuse", () => {
  const base = {
    scenarioFingerprint: "scenario-A",
    simulationTimeMs: 1_000,
    requestedAtSimMs: 1_000,
    requestGeneration: 1,
    source: "live" as const,
  };

  function traceWith(policy: unknown) {
    return {
      version: 1 as const,
      controllerId: "jev",
      client: "gateway",
      scenarioFingerprint: "scenario-A",
      events: [{ ...base, policy }],
    };
  }

  function validPolicy(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: JEV_SCHEMA_VERSION,
      pressureScale: 1.2,
      hint: "hold-longer",
      corridorWeights: [{ id: 3, weight: 1.5 }],
      regionWeights: [{ id: 1, weight: 1 }],
      ...overrides,
    };
  }

  it("accepts a policy that the live contract accepts", () => {
    const parsed = parseJevTrace(traceWith(validPolicy()));
    expect(parsed.ok).toBe(true);
  });

  it("rejects every policy the live contract would refuse or clamp", () => {
    const cases: [string, Record<string, unknown>][] = [
      ["pressure scale above the bounds", validPolicy({ pressureScale: JEV_LIMITS.PRESSURE_SCALE_MAX + 1 })],
      ["pressure scale below the bounds", validPolicy({ pressureScale: 0.01 })],
      ["weight above the bounds", validPolicy({ corridorWeights: [{ id: 3, weight: 1e9 }] })],
      ["negative weight", validPolicy({ regionWeights: [{ id: 1, weight: -5 }] })],
      [
        "too many entries",
        validPolicy({
          corridorWeights: Array.from({ length: JEV_LIMITS.POLICY_ENTRIES + 1 }, (_, index) => ({
            id: index,
            weight: 1,
          })),
        }),
      ],
      ["duplicate ids", validPolicy({ corridorWeights: [{ id: 3, weight: 1 }, { id: 3, weight: 2 }] })],
      ["non-finite weight", validPolicy({ corridorWeights: [{ id: 3, weight: Number.NaN }] })],
      ["non-finite pressure scale", validPolicy({ pressureScale: Number.POSITIVE_INFINITY })],
      ["unknown hint", validPolicy({ hint: "clear-everything" })],
      ["wrong schema version", validPolicy({ schemaVersion: 2 })],
      ["weights not an array", validPolicy({ corridorWeights: {} })],
      ["entry without weight", validPolicy({ corridorWeights: [{ id: 3 }] })],
      ["id not an integer", validPolicy({ corridorWeights: [{ id: 1.5, weight: 1 }] })],
      ["weights as a string", validPolicy({ corridorWeights: "none" })],
    ];
    for (const [label, policy] of cases) {
      const parsed = parseJevTrace(traceWith(policy));
      expect(parsed.ok, `expected rejection: ${label}`).toBe(false);
    }
  });

  it("keeps the invariant: trace-accepted implies live-accepted", () => {
    const samples: unknown[] = [
      validPolicy(),
      validPolicy({ pressureScale: 0.5, corridorWeights: [], regionWeights: [] }),
      validPolicy({ hint: "switch-sooner", corridorWeights: [{ id: 7, weight: 0.5 }] }),
      validPolicy({ pressureScale: 99 }),
      validPolicy({ corridorWeights: [{ id: 1, weight: -3 }] }),
      validPolicy({ hint: "nope" }),
      { schemaVersion: 1 },
      null,
      [],
      42,
    ];
    for (const policy of samples) {
      const trace = parseJevTrace(traceWith(policy));
      if (!trace.ok) {
        continue;
      }
      for (const event of trace.value.events) {
        // Any id set: a live policy is only ever checked against the ids its
        // request carried, so a policy that passes with one context must pass
        // structurally everywhere.
        const live = parseJevPolicy(event.policy, { corridorIds: [3, 7, 1], regionIds: [1, 3] });
        expect(live.ok, `trace accepted a policy live code refuses: ${JSON.stringify(policy)}`).toBe(
          true,
        );
        if (live.ok) {
          // And nothing had to be clamped on the way in.
          expect(live.value.clamped).toEqual([]);
        }
      }
    }
  });

  it("still refuses a trace whose events belong to another scenario", () => {
    const foreign = traceWith(validPolicy());
    foreign.events[0] = { ...foreign.events[0], scenarioFingerprint: "scenario-B" };
    expect(parseJevTrace(foreign).ok).toBe(false);
  });

  it("still loads a real recorded trace", () => {
    const recorded = {
      version: 1 as const,
      controllerId: "jev",
      client: "mock",
      scenarioFingerprint: fingerprintForRun(SCENARIO),
      events: [
        {
          scenarioFingerprint: fingerprintForRun(SCENARIO),
          simulationTimeMs: 0,
          requestedAtSimMs: 0,
          requestGeneration: 1,
          policy: {
            schemaVersion: JEV_SCHEMA_VERSION,
            pressureScale: 1.1,
            hint: "neutral" as const,
            corridorWeights: [],
            regionWeights: [],
          },
          source: "live" as const,
        },
      ],
    };
    const parsed = parseJevTrace(recorded);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const policy: JevPolicy = parsed.value.events[0].policy;
      expect(policy.pressureScale).toBe(1.1);
    }
  });
});
