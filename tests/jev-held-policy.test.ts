/**
 * Holding the last good policy (measured fix).
 *
 * The defect this file pins, measured before it was fixed: a 600 s run of the
 * real app spent 26.7% of its simulated time on the Adaptive fallback — 140 s of
 * that in the back-to-back tail after the ego arrives — against a PERFECT policy
 * client with ZERO rejections. The cause was structural, not the model's: the
 * tail never turns the event loop, so an answer already in flight cannot land
 * and a one-freshness-window TTL handed the rest of the run to the safety net.
 *
 * What is pinned here:
 *
 *   1. the model's last accepted policy keeps governing while nothing fresher
 *      arrives (HELD), bounded by a maximum hold, and the run reports how much
 *      of its governed time was held
 *   2. the tail shape — a synchronous stretch that cannot drain the event loop —
 *      no longer costs a third of the run, proven against the OLD rule
 *      (maxHoldMs === ttlMs) run on the same drive
 *   3. every fallback says WHY, in a closed vocabulary, and a failure is
 *      classified from the transport rather than from prose
 *   4. the label names the three Jev states distinctly — never calling a held
 *      run a fallback, never hiding a fallback behind the plain word Jev
 *   5. safety stays absolute under a HELD policy: an adversarial policy at the
 *      exact bounds cannot jump a legal minimum green or emit an illegal
 *      directive, held or fresh
 */
import { describe, expect, it } from "vitest";
import { createJevController } from "@/controllers/jev";
import { createAdaptiveController } from "@/controllers/adaptive";
import { JevClientError, createRelayJevClient, type JevClient } from "@/jev/client";
import { droppedAnswerCount, JEV_CONFIDENCE, policyFromEvaluations, buildEvaluationsBody } from "@/jev/gateway";
import { createJevPolicyRuntime, type JevCause } from "@/jev/runtime";
import { JEV_LIMITS, JEV_SCHEMA_VERSION, neutralJevPolicy, type JevPolicyRequest } from "@/jev/schema";
import { policyLabel, causeReason } from "@/components/ui-model";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
import { DEFAULT_SIGNAL_TIMING, SIMULATION_TIMESTEP_MS } from "@/sim/config";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { buildObservationFrame } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import { makeCrossroads } from "./traffic-support";

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

function observationOf(engine: EngineState, partition: CityPartition) {
  return {
    frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition,
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  };
}

function policy(scale = 1.2) {
  return { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: scale, hint: "neutral" as const, corridorWeights: [], regionWeights: [] };
}

/** Ticks with the event loop turning between them (the app's paced phase). */
async function pacedTicks(
  runtime: { observe: (observation: ReturnType<typeof observationOf>) => unknown },
  engine: EngineState,
  partition: CityPartition,
  ticks: number,
): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    runtime.observe(observationOf(engine, partition));
    stepEngine(engine);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Ticks with NO event-loop turn: the app's post-arrival tail. */
function tailTicks(
  runtime: { observe: (observation: ReturnType<typeof observationOf>) => unknown },
  engine: EngineState,
  partition: CityPartition,
  ticks: number,
): void {
  for (let tick = 0; tick < ticks; tick += 1) {
    runtime.observe(observationOf(engine, partition));
    stepEngine(engine);
  }
}

/* ------------------------------------------- 1. the tail, before and after -- */

describe("a policy keeps governing while nothing fresher arrives", () => {
  it("does not hand the synchronous tail to the Adaptive fallback (the measured defect)", async () => {
    const answer = { id: "mock", requestPolicy: () => new Promise((resolve) => setTimeout(() => resolve(policy(1.3)), 2)) };

    // The SAME drive under two rules: the shipped maximum hold, and the old
    // one-window rule (maxHoldMs === ttlMs) which is exactly what shipped before.
    const shipped = crossroads();
    const shippedRuntime = createJevPolicyRuntime({
      client: answer,
      scenarioFingerprint: "tail-shipped",
      refreshMs: 500,
      ttlMs: 1_000,
    });
    const oneWindow = crossroads();
    const oneWindowRuntime = createJevPolicyRuntime({
      client: answer,
      scenarioFingerprint: "tail-one-window",
      refreshMs: 500,
      ttlMs: 1_000,
      maxHoldMs: 1_000,
    });

    await pacedTicks(shippedRuntime, shipped.engine, shipped.partition, 12);
    await pacedTicks(oneWindowRuntime, oneWindow.engine, oneWindow.partition, 12);
    tailTicks(shippedRuntime, shipped.engine, shipped.partition, 30);
    tailTicks(oneWindowRuntime, oneWindow.engine, oneWindow.partition, 30);

    const held = shippedRuntime.status();
    const expired = oneWindowRuntime.status();

    // Both accepted a policy; only one of them kept using it.
    expect(held.accepted).toBeGreaterThan(0);
    expect(expired.accepted).toBeGreaterThan(0);
    // The old rule: the tail (2 900 ms of simulated time with no answer able to
    // land) is all fallback. The shipped rule: only the gap before the first
    // answer (one or two ticks) is.
    expect(expired.fallbackMs).toBeGreaterThanOrEqual(2_000);
    expect(held.fallbackMs).toBeLessThanOrEqual(300);
    expect(held.source).toBe("live");
    expect(held.heldMs).toBeGreaterThan(1_000);
    // Held time is inside the governed time, never beside it.
    expect(held.heldMs).toBeLessThanOrEqual(held.liveMs);
    // Every observed interval belongs to one source; the tick after the LAST
    // observation is closed by the next one, which never comes at the end of a
    // run (the deployed participation check allows exactly that one tick).
    expect(held.liveMs + held.replayMs + held.fallbackMs).toBe(
      shipped.engine.traffic.timeMs - SIMULATION_TIMESTEP_MS,
    );
  });

  it("names the cause of every fallback instead of reverting in silence", () => {
    const { engine, partition } = crossroads();
    const failures: { kind: string; cause: JevCause; detail: string }[] = [];
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        throw new JevClientError("timeout", "jev relay request timed out");
      },
    };
    const runtime = createJevPolicyRuntime({
      client,
      scenarioFingerprint: "causes",
      refreshMs: 100,
      onRejected: (rejection) => failures.push(rejection),
    });
    tailTicks(runtime, engine, partition, 5);
    const status = runtime.status();
    expect(status.accepted).toBe(0);
    expect(status.source).toBe("fallback");
    expect(status.lastCause).toBe("timeout");
    expect(status.causes.timeout).toBeGreaterThan(0);
    expect(status.fallbackReason).toBe("timeout");
    expect(failures.every((rejection) => rejection.cause === "timeout")).toBe(true);
    expect(status.lastRejection?.kind).toBe("client-error");
  });

  it("classifies rate limits, upstream errors and unreadable answers apart", () => {
    const cases: [string, unknown, JevCause][] = [
      ["a rate limit", new Error("jev gateway responded 429"), "rate-limited"],
      ["an upstream failure", new Error("jev gateway responded 503"), "upstream-error"],
      ["a refused request", new Error("jev service responded 401"), "rejected"],
      ["an unrecognised failure", new Error("service exploded"), "unknown"],
    ];
    for (const [label, thrown, expected] of cases) {
      const { engine, partition } = crossroads();
      const runtime = createJevPolicyRuntime({
        client: { id: "mock", requestPolicy: () => {
          throw thrown;
        } },
        scenarioFingerprint: "causes",
        refreshMs: 100,
      });
      tailTicks(runtime, engine, partition, 3);
      expect(runtime.status().lastCause, `expected ${expected} for ${label}`).toBe(expected);
      expect(runtime.status().lastRejection?.kind).toBe("client-error");
    }
    // An answer that arrives but cannot be a policy is its own cause.
    const { engine, partition } = crossroads();
    const malformed = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => ({ schemaVersion: JEV_SCHEMA_VERSION, hint: "fly" }) },
      scenarioFingerprint: "causes",
      refreshMs: 100,
    });
    tailTicks(malformed, engine, partition, 3);
    expect(malformed.status().lastCause).toBe("malformed");
    expect(malformed.status().lastRejection?.kind).toBe("malformed");
  });

  it("says unconfigured and first-policy rather than inventing a reason", () => {
    const { engine, partition } = crossroads();
    const unconfigured = createJevPolicyRuntime({ client: null, scenarioFingerprint: "none" });
    tailTicks(unconfigured, engine, partition, 3);
    expect(unconfigured.status().fallbackReason).toBe("unconfigured");

    const waiting = createJevPolicyRuntime({
      client: { id: "mock", requestPolicy: () => new Promise(() => undefined) },
      scenarioFingerprint: "waiting",
      refreshMs: 100,
    });
    tailTicks(waiting, engine, partition, 3);
    expect(waiting.status().fallbackReason).toBe("first-policy");
  });

  it("classifies the fallback TIME itself, so a run with zero refusals still explains itself", async () => {
    const { engine, partition } = crossroads();
    // The measured live shape: a healthy client whose FIRST answer takes a few
    // ticks to arrive, and nothing ever fails. The fallback time is real, and
    // its cause is not a rejection — it is "no policy exists yet".
    const runtime = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => new Promise((resolve) => setTimeout(() => resolve(policy(1.2)), 5)),
      },
      scenarioFingerprint: "opening-gap",
      refreshMs: 1_000,
    });
    await pacedTicks(runtime, engine, partition, 4);
    tailTicks(runtime, engine, partition, 10);
    const status = runtime.status();
    expect(status.rejected).toBe(0);
    expect(status.fallbackMs).toBeGreaterThan(0);
    expect(status.dominantFallbackCause).toBe("first-policy");
    expect(status.fallbackCauseMs["first-policy"]).toBe(status.fallbackMs);
    expect(status.lastCause).toBeNull(); // nothing failed; nothing is invented

    // ...and a fallback caused by failures is attributed to the failure.
    const { engine: failing, partition: failingPartition } = crossroads();
    const refused = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => {
          throw new JevClientError("upstream-error", "jev gateway responded 503");
        },
      },
      scenarioFingerprint: "refused",
      refreshMs: 100,
    });
    tailTicks(refused, failing, failingPartition, 10);
    const refusedStatus = refused.status();
    expect(refusedStatus.dominantFallbackCause).toBe("upstream-error");
    expect(refusedStatus.fallbackCauseMs["upstream-error"]).toBe(refusedStatus.fallbackMs);
    expect(refusedStatus.causes["upstream-error"]).toBeGreaterThan(0);
  });
});

/* --------------------------------------- 2. the transport carries the reason -- */

describe("the browser client reports why, and what an answer cost", () => {
  it("takes the relay's bounded class from the response header", async () => {
    const client = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "jev service request failed" }), {
          status: 502,
          headers: { "x-jev-reason": "timeout" },
        })) as unknown as typeof fetch,
    });
    await expect(client.requestPolicy({} as never)).rejects.toBeInstanceOf(JevClientError);
    try {
      await client.requestPolicy({} as never);
    } catch (error) {
      expect(error).toBeInstanceOf(JevClientError);
      expect((error as JevClientError).failure).toBe("timeout");
    }
  });

  it("classifies from the status when no header is present, and keeps the relay's words", async () => {
    const rateLimited = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "too many policy requests" }), { status: 429 })) as unknown as typeof fetch,
    });
    try {
      await rateLimited.requestPolicy({} as never);
      expect.unreachable("a 429 must throw");
    } catch (error) {
      expect((error as JevClientError).failure).toBe("rate-limited");
      expect((error as Error).message).toBe("too many policy requests");
    }
    const notConfigured = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "jev is not configured" }), { status: 503 })) as unknown as typeof fetch,
    });
    await expect(notConfigured.requestPolicy({} as never)).rejects.toThrow(/not configured/);
  });

  it("reads what an answer cost from the relay's counts", async () => {
    const client = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ policy: neutralJevPolicy(), clamped: ["pressureScale 9 -> 1.5"] }), {
          status: 200,
          headers: { "x-jev-clamped": "1", "x-jev-dropped": "2" },
        })) as unknown as typeof fetch,
    });
    await client.requestPolicy({} as never);
    expect(client.answerNotes?.()).toEqual({ clamped: 1, dropped: 2 });
  });

  it("counts a run's clamped values and dropped answers from the accepted answers only", () => {
    const { engine, partition } = crossroads();
    let calls = 0;
    const runtime = createJevPolicyRuntime({
      client: {
        id: "mock",
        requestPolicy: () => {
          calls += 1;
          return policy(1.1);
        },
        answerNotes: () => ({ clamped: 1, dropped: 2 }),
      },
      scenarioFingerprint: "notes",
      refreshMs: 1_000,
      minHoldMs: 1,
    });
    tailTicks(runtime, engine, partition, 40);
    const status = runtime.status();
    expect(status.accepted).toBe(calls);
    expect(status.clamped).toBe(calls);
    expect(status.dropped).toBe(calls * 2);
  });
});

/* -------------------------------------------------------- 3. the label ----- */

describe("the provenance label names the state that actually happened", () => {
  const base: PresentationPolicy = {
    source: "live",
    liveMs: 600_000,
    replayMs: 0,
    fallbackMs: 0,
    accepted: 20,
    rejected: 0,
    refreshes: 20,
  };

  it("keeps plain Jev for a run governed freshly from end to end", () => {
    expect(policyLabel("jev", base)?.text).toBe("Jev");
    expect(policyLabel("jev", base)?.detail).toBe("20 live policies");
  });

  it("says a policy was held rather than calling it fresh or a fallback", () => {
    const held: PresentationPolicy = { ...base, heldMs: 140_000, maxHoldMs: 300_000 };
    const label = policyLabel("jev", held);
    expect(label?.text).toBe("Jev · policy held");
    expect(label?.detail).toContain("23% of the run on a policy held past its refresh window");
    expect(label?.detail).toContain("20 live policies");
    // Never the fallback's words for time the model's policy governed.
    expect(label?.detail).not.toContain("fallback");
  });

  it("names the classified reason beside a fallback, and the imperfections too", () => {
    const onFallback: PresentationPolicy = {
      ...base,
      fallbackMs: 240_000,
      liveMs: 360_000,
      accepted: 16,
      cause: "timeout",
      dropped: 3,
      clamped: 1,
    };
    const label = policyLabel("jev", onFallback);
    expect(label?.text).toBe("Jev · fallback used");
    expect(label?.detail).toContain("40% of the run on the adaptive fallback");
    expect(label?.detail).toContain("(the model did not answer in time)");
    expect(label?.detail).toContain("16 live policies");
    expect(label?.detail).toContain("3 answers below the confidence floor");
    expect(label?.detail).toContain("1 value clamped");
    // A run whose provenance predates these fields keeps the old wording.
    const older: PresentationPolicy = { ...base, fallbackMs: 240_000, liveMs: 360_000 };
    expect(policyLabel("jev", older)?.detail).toContain("40% of the run on the adaptive fallback · ");
    expect(policyLabel("jev", older)?.detail).not.toContain("(");
  });

  it("has plain words for every cause it can classify, and none for an unknown one", () => {
    for (const cause of [
      "unconfigured",
      "first-policy",
      "expired",
      "held",
      "superseded",
      "timeout",
      "rate-limited",
      "upstream-error",
      "rejected",
      "unreachable",
      "not-configured",
      "malformed",
    ] as const) {
      expect(causeReason(cause), `no wording for ${cause}`).toBeTruthy();
    }
    expect(causeReason("unknown")).toBeNull();
    expect(causeReason(null)).toBeNull();
  });
});

/* ------------------------------------------------------- 4. safety stays ---- */

describe("a HELD policy is as bounded as a fresh one", () => {
  it("cannot jump a legal minimum green, however old the policy is", () => {
    const { engine } = crossroads();
    // Every magnitude at the top of its bounds, and the hint that relinquishes
    // greens fastest: the most aggressive policy the schema admits.
    const controller = createJevController({
      scenarioFingerprint: "held-hostile",
      refreshMs: 60_000,
      ttlMs: 1_000,
      maxHoldMs: 5_000,
      client: {
        id: "mock",
        requestPolicy: (request) => ({
          schemaVersion: JEV_SCHEMA_VERSION,
          pressureScale: JEV_LIMITS.PRESSURE_SCALE_MAX,
          hint: "switch-sooner" as const,
          corridorWeights: request.corridors.map((corridor) => ({ id: corridor.corridorId, weight: JEV_LIMITS.WEIGHT_MAX })),
          regionWeights: request.regions.map((region) => ({ id: region.regionId, weight: JEV_LIMITS.WEIGHT_MAX })),
        }),
      },
    });
    const driven = createEngine({
      city: engine.city,
      controller,
      spawns: Array.from({ length: 60 }, (_, second) =>
        engine.city.roads
          .filter((road) => road.to === 0)
          .map((road) => ({
            timeMs: second * 1_000,
            type: "car" as const,
            origin: road.from,
            destination: 0,
          })),
      ).flat(),
    });
    const minGreen = DEFAULT_SIGNAL_TIMING.minGreenMs;
    const lastGreen = new Map<number, { phase: number; elapsed: number }>();
    let phaseChanges = 0;
    for (let tick = 0; tick < 700; tick += 1) {
      stepEngine(driven);
      for (const [id, signalState] of driven.traffic.signals) {
        const served = lastGreen.get(id);
        if (signalState.stage === "green") {
          if (served && served.phase !== signalState.phaseIndex) {
            phaseChanges += 1;
            expect(served.elapsed, `signal ${id} left green too early`).toBeGreaterThanOrEqual(minGreen);
          }
          lastGreen.set(id, { phase: signalState.phaseIndex, elapsed: signalState.stageElapsedMs });
        }
      }
    }
    const status = controller.status();
    // The policy really was held for most of the run — this is not the fresh path.
    expect(status.heldMs).toBeGreaterThan(2_000);
    expect(status.accepted).toBeGreaterThan(0);
    expect(phaseChanges).toBeGreaterThan(0);
    // And it never left the bounds it was clamped into.
    const inForce = controller.policy();
    expect(inForce?.pressureScale ?? 0).toBeLessThanOrEqual(JEV_LIMITS.PRESSURE_SCALE_MAX);
    expect((inForce?.corridorWeights ?? []).every((entry) => entry.weight <= JEV_LIMITS.WEIGHT_MAX)).toBe(true);
  });
});

/* ------------------------------------------------------- 5. the seam ------- */

describe("the confidence floor is reported, never silent", () => {
  it("counts the answers a response carried but could not use", () => {
    // The live Gateway's own shape: a probability per option, and the SELECTED
    // option's probability is what decides usability. Measured against the real
    // model, one answer per refresh (the busiest corridor's weight, 0.19-0.22)
    // sits below the 0.25 floor — applied as neutral, and until now invisible.
    const request: JevPolicyRequest = {
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
          kind: "arterial" as const,
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
    };
    const body = buildEvaluationsBody(request);
    const weak = { choice: "low", probabilities: { low: 0.21, normal: 0.5, high: 0.2, top: 0.09 } };
    const strong = { choice: "high", probabilities: { low: 0.05, normal: 0.2, high: 0.6, top: 0.15 } };
    const response = {
      answers: {
        pressure: { choice: "assertive", probabilities: { relaxed: 0.1, steady: 0.2, assertive: 0.6, urgent: 0.1 } },
        hint: { choice: "hold-longer", probabilities: { neutral: 0.2, "hold-longer": 0.6, "switch-sooner": 0.2 } },
        "corridor:1": weak,
        "region:1": strong,
      },
    };
    // Exactly one answer is below the floor, and the policy is still built from
    // the rest — applied, imperfect, and counted.
    expect(droppedAnswerCount(body, response)).toBe(1);
    const policy = policyFromEvaluations(body, response);
    expect(policy.pressureScale).toBe(1.25);
    expect(policy.regionWeights).toEqual([{ id: 1, weight: 1.5 }]);
    expect(policy.corridorWeights).toEqual([]);
    // Silence is not a dropped answer.
    expect(droppedAnswerCount(body, { answers: { pressure: response.answers.pressure } })).toBe(0);
    // ...and the floor is one named constant, not a literal at a call site.
    expect(JEV_CONFIDENCE.MIN_ANSWER_CONFIDENCE).toBe(0.25);
  });
});
