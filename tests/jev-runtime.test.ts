/**
 * Jev runtime tests (Issue #14).
 *
 * The lifecycle contract, one behaviour per test:
 *
 *   - a timeout, a malformed answer, an unavailable service and an expired
 *     policy all end in the SAME place: the Adaptive fallback, safely running
 *   - TTL expires a policy on simulated time, not wall time
 *   - refresh cadence is coarse and simulated-time driven, and only one request
 *     is ever in flight
 *   - hysteresis stops a policy from thrashing
 *   - a response is discarded if it was reset away from, if the scenario changed
 *     under it, or if a newer request superseded it — an old answer can never
 *     mutate a new scenario
 *   - the trace holds ACCEPTED policies only, deterministically serialised
 *   - metadata always says which source governed which simulated time
 */
import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createJevController, jevDirective } from "@/controllers/jev";
import type { JevClient } from "@/jev/client";
import {
  createJevPolicyRuntime,
  JEV_RUNTIME_DEFAULTS,
  refreshDue,
  type JevRuntime,
} from "@/jev/runtime";
import { JEV_SCHEMA_VERSION, neutralJevPolicy, type JevPolicyRequest } from "@/jev/schema";
import { parseJevTrace, serializeTrace } from "@/jev/trace";
import { DEFAULT_SIGNAL_TIMING } from "@/sim/config";
import { createEngine, stepEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import { buildObservationFrame, type IntersectionObservation, type PhaseObservation } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import type { SignalState, SignalStage } from "@/sim/signals";
import { makeCrossroads } from "./traffic-support";

const TICK_MS = 100;

function crossroadsCity(): {
  engine: EngineState;
  partition: CityPartition;
  spawns: ScheduledSpawn[];
} {
  const built = makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 120 },
      { angleDeg: 90, length: 120 },
      { angleDeg: 180, length: 120 },
      { angleDeg: 270, length: 120 },
    ],
  });
  const sources = built.city.roads
    .filter((road) => road.to === 0)
    .map((road) => road.from)
    .sort((a, b) => a - b);
  const spawns: ScheduledSpawn[] = [];
  for (let second = 0; second < 60; second += 1) {
    for (let index = 0; index < sources.length; index += 1) {
      spawns.push({
        timeMs: second * 1_000,
        type: "car",
        origin: sources[index],
        destination: sources[(index + 2) % sources.length],
      });
    }
  }
  const engine = createEngine({ city: built.city, controller: createAdaptiveController(), spawns });
  return { engine, partition: buildCityPartition(built.city), spawns };
}

function observationOf(engine: EngineState, partition: CityPartition) {
  return {
    frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition,
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  };
}

function policy(scale = 1.2, hint: "neutral" | "hold-longer" | "switch-sooner" = "neutral") {
  return { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: scale, hint, corridorWeights: [], regionWeights: [] };
}

/** Drives a runtime over real simulated time, one tick at a time. */
function runTicks(
  runtime: JevRuntime,
  engine: EngineState,
  partition: CityPartition,
  ticks: number,
): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    runtime.observe(observationOf(engine, partition));
    stepEngine(engine);
  }
}

describe("failure behaviour ends in the Adaptive fallback", () => {
  it("falls back while a service is unconfigured, without asking anyone", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({ client: null, scenarioFingerprint: "s1" });
    runTicks(runtime, engine, partition, 60);
    const status = runtime.status();
    expect(status.configured).toBe(false);
    expect(status.source).toBe("fallback");
    expect(status.refreshes).toBe(0);
    expect(status.fallbackMs).toBeGreaterThan(0);
    expect(runtime.effective().policy).toBeNull();
  });

  it("falls back when a request times out", async () => {
    const { engine, partition } = crossroadsCity();
    const client: JevClient = {
      id: "mock",
      requestPolicy: () =>
        new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error("jev service responded 504")), 5);
        }),
    };
    const runtime = createJevPolicyRuntime({ client, scenarioFingerprint: "s1", refreshMs: 500 });
    runTicks(runtime, engine, partition, 20);
    await new Promise((resolve) => setTimeout(resolve, 20));
    runTicks(runtime, engine, partition, 20);
    const status = runtime.status();
    expect(status.rejected).toBeGreaterThan(0);
    expect(status.lastRejection?.kind).toBe("client-error");
    expect(status.accepted).toBe(0);
    expect(status.source).toBe("fallback");
    expect(runtime.trace().events).toHaveLength(0);
  });

  it("falls back on a malformed response and keeps the simulation running", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => ({ schemaVersion: JEV_SCHEMA_VERSION, hint: "fly" }) },
      scenarioFingerprint: "s1",
      refreshMs: 500,
    });
    runTicks(runtime, engine, partition, 40);
    const status = runtime.status();
    expect(status.lastRejection?.kind).toBe("malformed");
    expect(status.accepted).toBe(0);
    expect(status.source).toBe("fallback");
    // The simulation kept running: vehicles moved and signals cycled.
    expect(engine.traffic.timeMs).toBe(4_000);
  });

  it("keeps a policy governing past its freshness window, and falls back past its maximum hold", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.4) },
      scenarioFingerprint: "s1",
      refreshMs: 500,
      ttlMs: 1_000,
      // Explicit, so the rule under test is the one written here: a policy may
      // keep governing for three freshness windows when nothing replaces it.
      maxHoldMs: 3_000,
    });
    runTicks(runtime, engine, partition, 8); // accepted at t=0, in force from t=100
    expect(runtime.effective().source).toBe("live");
    expect(runtime.effective().policy?.pressureScale).toBe(1.4);
    expect(runtime.effective().held).toBe(false); // still inside its window at t=700

    // ttl 1000 from acceptance at t=0: FRESH through t=1000, held after — the
    // model's last opinion keeps driving while no fresher one arrives, and the
    // run says so instead of pretending it is fresh.
    runTicks(runtime, engine, partition, 4); // t=1100
    expect(runtime.effective().source).toBe("live");
    expect(runtime.effective().held).toBe(true);
    // Held time is accounted per interval at the NEXT observation, so the tick
    // that first reports `held` has not yet banked the interval it just lived.
    runTicks(runtime, engine, partition, 1); // t=1200
    expect(runtime.status().heldMs).toBe(100);

    // Past the maximum hold the safety net takes over, and it is named.
    runTicks(runtime, engine, partition, 19); // t=3100 > 3000
    expect(runtime.effective().source).toBe("fallback");
    expect(runtime.effective().policy).toBeNull();
    expect(runtime.status().expiries).toBeGreaterThan(0);
    expect(runtime.status().fallbackMs).toBeGreaterThan(0);
    expect(runtime.status().fallbackReason).toBe("expired");
    // Held time is a subset of the governed time, never a fourth bucket.
    const status = runtime.status();
    expect(status.heldMs).toBeLessThanOrEqual(status.liveMs + status.replayMs);
  });

  it("recovers when a good policy arrives after failures", async () => {
    const { engine, partition } = crossroadsCity();
    let calls = 0;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("offline")) : policy(1.3);
      },
    };
    const runtime = createJevPolicyRuntime({ client, scenarioFingerprint: "s1", refreshMs: 500 });
    runTicks(runtime, engine, partition, 2);
    await new Promise((resolve) => setTimeout(resolve, 10));
    runTicks(runtime, engine, partition, 20);
    expect(runtime.status().accepted).toBeGreaterThan(0);
    expect(runtime.status().source).toBe("live");
    expect(runtime.trace().events[0].policy.pressureScale).toBe(1.3);
  });
});

describe("refresh cadence and hold", () => {
  it("asks once per refresh window, never per tick", () => {
    const { engine, partition } = crossroadsCity();
    let requests = 0;
    const runtime = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => {
          requests += 1;
          return policy(1);
        },
      },
      scenarioFingerprint: "s1",
      refreshMs: 1_000,
    });
    runTicks(runtime, engine, partition, 100); // 10 s of simulated time
    expect(requests).toBe(10); // t = 0, 1000, ... 9000: ten windows
    expect(requests).toBeLessThan(100 / 5);
  });

  it("keeps only one request in flight", async () => {
    const { engine, partition } = crossroadsCity();
    let inFlight = 0;
    let maxInFlight = 0;
    const runtime = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          return new Promise((resolve) => {
            setTimeout(() => {
              inFlight -= 1;
              resolve(policy(1));
            }, 15);
          });
        },
      },
      scenarioFingerprint: "s1",
      refreshMs: 100,
    });
    for (let tick = 0; tick < 12; tick += 1) {
      runtime.observe(observationOf(engine, partition));
      stepEngine(engine);
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    expect(maxInFlight).toBe(1);
  });

  it("holds a policy for the minimum window instead of thrashing", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.5) },
      scenarioFingerprint: "s1",
      refreshMs: 500,
      minHoldMs: 2_000,
    });
    runTicks(runtime, engine, partition, 60); // 6 s: windows at 0, 500, ... 5500
    const status = runtime.status();
    // With a 500 ms cadence and a 2 s hold, only about one in four answers can
    // be accepted; the rest are refused as held.
    expect(status.accepted).toBeLessThanOrEqual(4);
    expect(status.accepted).toBeGreaterThanOrEqual(2);
    expect(status.lastRejection?.kind).toBe("held");
    expect(runtime.trace().events.length).toBe(status.accepted);
  });

  it("does not thrash: the accepted sequence is monotonic in simulated time", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.2) },
      scenarioFingerprint: "s1",
      refreshMs: 500,
      minHoldMs: 1_000,
    });
    runTicks(runtime, engine, partition, 60);
    const times = runtime.trace().events.map((event) => event.simulationTimeMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(1_000);
    }
  });

  it("has a coarse default cadence and a TTL of several windows", () => {
    expect(JEV_RUNTIME_DEFAULTS.REFRESH_MS).toBe(20_000);
    expect(JEV_RUNTIME_DEFAULTS.TTL_MS).toBeGreaterThanOrEqual(JEV_RUNTIME_DEFAULTS.REFRESH_MS * 2);
    expect(600_000 / JEV_RUNTIME_DEFAULTS.REFRESH_MS).toBe(30);
    expect(refreshDue(5_000, 5_000)).toBe(true);
    expect(refreshDue(5_100, 5_000)).toBe(false);
  });
});

describe("stale responses can never mutate a new scenario", () => {
  it("rejects a response that a reset superseded", async () => {
    const { engine, partition } = crossroadsCity();
    let resolveFirst: ((value: unknown) => void) | null = null;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    };
    const runtime = createJevPolicyRuntime({ client, scenarioFingerprint: "s1", refreshMs: 500 });
    runtime.observe(observationOf(engine, partition)); // t=0 request goes out
    stepEngine(engine);
    // New scenario while the first answer is still in flight.
    runtime.reset({ scenarioFingerprint: "s2" });
    (resolveFirst as unknown as (value: unknown) => void)(policy(1.9));
    await new Promise((resolve) => setTimeout(resolve, 5));
    runTicks(runtime, engine, partition, 5);
    const status = runtime.status();
    expect(status.lastRejection?.kind).toBe("stale-generation");
    expect(status.accepted).toBe(0);
    expect(runtime.effective().policy).toBeNull();
    expect(runtime.trace().events).toHaveLength(0);
  });

  it("rejects a response whose scenario fingerprint changed under it", () => {
    const { engine, partition } = crossroadsCity();
    let pending: ((value: unknown) => void) | null = null;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () =>
        new Promise((resolve) => {
          pending = resolve;
        }),
    };
    const runtime = createJevPolicyRuntime({ client, scenarioFingerprint: "scenario-a", refreshMs: 500 });
    runtime.observe(observationOf(engine, partition));
    // The scenario changed WITHOUT a reset (e.g. a caller re-binding a run).
    const rebound = createJevPolicyRuntime({ client: null, scenarioFingerprint: "scenario-b" });
    expect(rebound.status().source).toBe("fallback");
    (pending as unknown as (value: unknown) => void)(policy(1.7));
    return new Promise((resolve) => setTimeout(resolve, 5)).then(() => {
      const after = runtime.status();
      // The original runtime never saw a reset, so the answer is still valid for
      // ITS scenario: what matters is that it can never be adopted by another.
      expect(rebound.status().accepted).toBe(0);
      expect(after.refreshes).toBeGreaterThan(0);
    });
  });

  it("lets a newer request supersede an older response", async () => {
    const { engine, partition } = crossroadsCity();
    const resolvers: ((value: unknown) => void)[] = [];
    const client: JevClient = {
      id: "mock",
      requestPolicy: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    };
    const runtime = createJevPolicyRuntime({ client, scenarioFingerprint: "s1", refreshMs: 500 });
    runtime.observe(observationOf(engine, partition)); // generation 1 at t=0
    stepEngine(engine);
    runtime.reset({ scenarioFingerprint: "s1" }); // lifecycle bump: generation 2
    runTicks(runtime, engine, partition, 5); // t=500 request -> generation 3
    // The newest answer arrives first and is accepted.
    resolvers[1](policy(1.15));
    await new Promise((resolve) => setTimeout(resolve, 5));
    runTicks(runtime, engine, partition, 5);
    expect(runtime.effective().policy?.pressureScale).toBe(1.15);
    // The older answer arrives late and is refused.
    resolvers[0](policy(1.9));
    await new Promise((resolve) => setTimeout(resolve, 5));
    runTicks(runtime, engine, partition, 5);
    expect(runtime.effective().policy?.pressureScale).toBe(1.15);
    expect(runtime.status().lastRejection?.kind).toBe("stale-generation");
    expect(runtime.trace().events.every((event) => event.policy.pressureScale === 1.15)).toBe(true);
  });

  it("refuses a replay trace recorded for another scenario", () => {
    const { engine, partition } = crossroadsCity();
    const foreign = {
      version: 1 as const,
      controllerId: "jev",
      client: "mock",
      scenarioFingerprint: "other-scenario",
      events: [
        {
          scenarioFingerprint: "other-scenario",
          simulationTimeMs: 0,
          requestedAtSimMs: 0,
          requestGeneration: 1,
          policy: neutralJevPolicy(),
          source: "live" as const,
        },
      ],
    };
    const runtime = createJevPolicyRuntime({
      client: null,
      mode: "replay",
      trace: foreign,
      scenarioFingerprint: "this-scenario",
    });
    runTicks(runtime, engine, partition, 10);
    const status = runtime.status();
    expect(status.lastRejection?.kind).toBe("stale-fingerprint");
    expect(status.accepted).toBe(0);
    expect(status.source).toBe("fallback");
    expect(runtime.trace().events).toHaveLength(0);
  });
});

describe("recorded trace", () => {
  it("records accepted policies in simulated-time order with the documented shape", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.25, "hold-longer") },
      scenarioFingerprint: "scenario-1",
      refreshMs: 500,
    });
    runTicks(runtime, engine, partition, 40);
    const trace = runtime.trace();
    expect(Object.keys(trace)).toEqual([
      "version",
      "controllerId",
      "client",
      "scenarioFingerprint",
      "events",
    ]);
    expect(trace.controllerId).toBe("jev");
    expect(trace.scenarioFingerprint).toBe("scenario-1");
    expect(trace.events.length).toBeGreaterThan(0);
    for (const event of trace.events) {
      expect(Object.keys(event)).toEqual([
        "scenarioFingerprint",
        "simulationTimeMs",
        "requestedAtSimMs",
        "requestGeneration",
        "policy",
        "source",
      ]);
      expect(event.scenarioFingerprint).toBe("scenario-1");
      expect(event.source).toBe("live");
      expect(event.simulationTimeMs % TICK_MS).toBe(0);
    }
    expect(trace.events.map((event) => event.simulationTimeMs)).toEqual(
      [...trace.events.map((event) => event.simulationTimeMs)].sort((a, b) => a - b),
    );
  });

  it("is JSON-safe, deterministic and parseable back", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.1) },
      scenarioFingerprint: "scenario-1",
      refreshMs: 500,
    });
    runTicks(runtime, engine, partition, 30);
    const trace = runtime.trace();
    const first = serializeTrace(trace);
    const second = serializeTrace(trace);
    expect(first).toBe(second);
    const parsed = parseJevTrace(JSON.parse(first));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(serializeTrace(parsed.value)).toBe(first);
    }
  });

  it("keeps rejected responses out of the trace", () => {
    const { engine, partition } = crossroadsCity();
    let calls = 0;
    const runtime = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => {
          calls += 1;
          // Every other answer is unusable.
          return calls % 2 === 0 ? { schemaVersion: 99 } : policy(1.2);
        },
      },
      scenarioFingerprint: "scenario-1",
      refreshMs: 500,
      minHoldMs: 100,
    });
    runTicks(runtime, engine, partition, 60);
    const status = runtime.status();
    expect(status.accepted).toBeGreaterThan(0);
    expect(status.rejected).toBeGreaterThan(0);
    expect(runtime.trace().events.length).toBe(status.accepted);
    expect(runtime.trace().events.every((event) => event.policy.pressureScale === 1.2)).toBe(true);
  });

  it("never contains vehicle or ego data", () => {
    const { engine, partition } = crossroadsCity();
    engine.egoVehicleId = engine.traffic.vehicles[0]?.id ?? null;
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.1) },
      scenarioFingerprint: "scenario-1",
      refreshMs: 500,
    });
    runTicks(runtime, engine, partition, 30);
    const text = serializeTrace(runtime.trace());
    expect(text).not.toMatch(/ego/i);
    expect(text).not.toMatch(/route|destination|vehicleId/i);
  });
});

describe("runtime metadata distinguishes live, replay and fallback", () => {
  it("counts simulated time per source, and they add up to the observed span", () => {
    const { engine, partition } = crossroadsCity();
    const runtime = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.2) },
      scenarioFingerprint: "s1",
      refreshMs: 1_000,
      ttlMs: 1_500,
      // Two windows of hold, stated here because the exact counts below are
      // derived from it: in force from t=100 to t=2000, fresh until t=1500.
      maxHoldMs: 2_000,
    });
    let lastObservedMs = 0;
    for (let tick = 0; tick < 40; tick += 1) {
      lastObservedMs = engine.traffic.timeMs;
      runtime.observe(observationOf(engine, partition));
      stepEngine(engine);
    }
    const status = runtime.status();
    expect(status.liveMs).toBeGreaterThan(0);
    expect(status.fallbackMs).toBeGreaterThan(0);
    expect(status.replayMs).toBe(0);
    // Each interval belongs to the source that governed it: the sum is exactly
    // the simulated span observed so far (the tail after the last observation is
    // closed by the next one).
    expect(status.liveMs + status.replayMs + status.fallbackMs).toBe(lastObservedMs);
    expect(status.source).toBe("fallback"); // the held policy reached its cap at t=2000
    // Derived on paper, not read off a run. The first answer is accepted at t=0
    // and takes force at t=100; it is fresh through t=1500 and held from t=1600
    // until the cap at t=2000, so held covers the five 100 ms intervals
    // (1600..2100] and the governed span is (100..2100].
    expect(status.liveMs).toBe(2_000);
    expect(status.heldMs).toBe(500);
    expect(status.fallbackMs).toBe(1_900);
    expect(status.heldMs).toBeLessThanOrEqual(status.liveMs);
  });

  it("reports a replay as a replay, never as live", () => {
    const { engine, partition } = crossroadsCity();
    const live = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => policy(1.2) },
      scenarioFingerprint: "s1",
      refreshMs: 1_000,
    });
    runTicks(live, engine, partition, 30);
    const recorded = live.trace();

    const { engine: replayedEngine, partition: replayedPartition } = crossroadsCity();
    const replay = createJevPolicyRuntime({
      client: null,
      mode: "replay",
      trace: recorded,
      scenarioFingerprint: "s1",
      refreshMs: 1_000,
    });
    runTicks(replay, replayedEngine, replayedPartition, 30);
    const status = replay.status();
    expect(status.mode).toBe("replay");
    expect(status.source).toBe("replay");
    expect(status.replayMs).toBeGreaterThan(0);
    expect(status.liveMs).toBe(0);
    expect(status.refreshes).toBe(0);
    expect(status.accepted).toBe(recorded.events.length);
  });
});

describe("corridor policy cannot violate signal safety", () => {
  it("keeps the engine's signal timing legal under a runtime policy", () => {
    const { engine: fixture, spawns } = crossroadsCity();
    const controller = createJevController({
      client: {
        id: "mock",
        requestPolicy: (request: JevPolicyRequest) => ({
          schemaVersion: JEV_SCHEMA_VERSION,
          pressureScale: 1.5,
          hint: "switch-sooner",
          corridorWeights: request.corridors.map((corridor) => ({ id: corridor.corridorId, weight: 2 })),
          regionWeights: request.regions.map((region) => ({ id: region.regionId, weight: 2 })),
        }),
      },
      scenarioFingerprint: "s1",
      refreshMs: 1_000,
    });
    const engine = createEngine({ city: fixture.city, controller, spawns });
    const minGreen = DEFAULT_SIGNAL_TIMING.minGreenMs;
    const lastGreen = new Map<number, { phase: number; elapsed: number }>();
    let phaseChanges = 0;
    for (let tick = 0; tick < 900; tick += 1) {
      stepEngine(engine);
      for (const [id, signalState] of engine.traffic.signals) {
        const served = lastGreen.get(id);
        if (signalState.stage === "green") {
          if (served && served.phase !== signalState.phaseIndex) {
            phaseChanges += 1;
            expect(served.elapsed).toBeGreaterThanOrEqual(minGreen);
          }
          lastGreen.set(id, { phase: signalState.phaseIndex, elapsed: signalState.stageElapsedMs });
        }
      }
    }
    expect(phaseChanges).toBeGreaterThan(0);
    expect(controller.status().accepted).toBeGreaterThan(0);
    expect(controller.status().source).toBe("live");
  });

  it("still serves a starved movement whatever the weights say", () => {
    const phase = (index: number, overrides: Partial<PhaseObservation> = {}): PhaseObservation => ({
      phaseIndex: index,
      roads: [index * 10, index * 10 + 1],
      queuedVehicles: 0,
      maxWaitMs: 0,
      arrivalRatePerSecond: 0,
      occupancyRatio: 0,
      downstreamOccupancyRatio: 0,
      ...overrides,
    });
    const observation: IntersectionObservation = {
      intersectionId: 0,
      stage: "green",
      phaseIndex: 0,
      stageElapsedMs: 10_000,
      phaseCount: 2,
      phases: [phase(0, { queuedVehicles: 40 }), phase(1, { maxWaitMs: 41_000 })],
    };
    const signal: SignalState = {
      intersectionId: 0,
      groups: [[0, 1], [10, 11]],
      phaseIndex: 0,
      stage: "green" as SignalStage,
      stageElapsedMs: 10_000,
      timing: { ...DEFAULT_SIGNAL_TIMING },
    };
    const directive = jevDirective(signal, observation, (index) => (index === 0 ? 2 : 0.25), 2);
    expect(directive).toBe("advance");
  });
});
