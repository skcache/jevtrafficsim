/**
 * Replay tests (Issue #14).
 *
 * Replay is the same runtime in `mode: "replay"`, fed a recorded trace instead
 * of a client. What is pinned here:
 *
 *   - zero network: no client method runs, no fetch happens
 *   - the accepted-policy sequence is reproduced exactly (same policies, same
 *     simulated instants)
 *   - a scenario replayed offline produces the SAME ChallengeResult as the run
 *     that was recorded — same trip, same city metrics, byte for byte
 *   - a trace recorded for another scenario is refused rather than half-applied
 *   - the benchmark seam carries replay metadata, and pacing (which only exists
 *     to let a remote model answer) never changes a result
 *
 * The recorded run here uses the deterministic mock client, so the whole test
 * is reproducible without a network.
 */
import { describe, expect, it, vi } from "vitest";
import { loadBenchmarkModel } from "@/benchmark/model";
import { runBenchmarkScenario } from "@/benchmark/runner";
import type { BenchmarkScenario } from "@/benchmark/scenarios";
import { createJevController, type JevController } from "@/controllers/jev";
import { jevProvenance } from "@/jev/provenance";
import { createMockJevClient, type JevClient } from "@/jev/client";
import { paceDelayMs } from "@/worker/challenge-compare";
import { buildScenarioRun } from "@/worker/challenge-compare";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { parseJevTrace, serializeTrace, type JevTrace } from "@/jev/trace";
import type { ChallengeResult } from "@/worker/challenge-result";
import type { ControllerFactoryContext } from "@/worker/challenge-compare";

const model = loadBenchmarkModel();
const HORIZON_MS = 20_000;

const SCENARIO = {
  tripId: "soldier-field-to-navy-pier" as const,
  trafficLevel: "everyday" as const,
  driver: "tourist" as const,
  seed: 42,
  durationMs: HORIZON_MS,
};

function requestOf(scenario: BenchmarkScenario) {
  return {
    tripId: scenario.tripId,
    trafficLevel: scenario.trafficLevel,
    driver: scenario.driver,
    seed: scenario.seed,
    durationMs: scenario.durationMs,
  };
}

/** One run with a live-mode controller; returns its result and its trace. */
function runLive(
  scenario: BenchmarkScenario,
  client: JevClient,
): { result: ChallengeResult; trace: JevTrace; controller: JevController } {
  let created: JevController | null = null;
  const run = buildScenarioRun(model, requestOf(scenario), {
    controllers: {
      jev: (context: ControllerFactoryContext) => {
        created = createJevController({
          client,
          scenarioFingerprint: context.fingerprint,
          refreshMs: 1_000,
        });
        return created;
      },
    },
  });
  const result = run.runUnder("jev");
  if (created === null) {
    throw new Error("the jev controller was never built");
  }
  const controller: JevController = created;
  return { result, trace: controller.trace(), controller };
}

/** One run off a recorded trace, with no client at all. */
function runReplay(scenario: BenchmarkScenario, trace: JevTrace | null): {
  result: ChallengeResult;
  controller: JevController;
} {
  let created: JevController | null = null;
  const run = buildScenarioRun(model, requestOf(scenario), {
    controllers: {
      jev: (context: ControllerFactoryContext) => {
        created = createJevController({
          client: null,
          mode: "replay",
          trace,
          scenarioFingerprint: context.fingerprint,
          refreshMs: 1_000,
        });
        return created;
      },
    },
  });
  const result = run.runUnder("jev");
  if (created === null) {
    throw new Error("the jev controller was never built");
  }
  const controller: JevController = created;
  return { result, controller };
}

describe("replay performs no network request", () => {
  it("never calls a client, and never touches global fetch", () => {
    const live = runLive(SCENARIO, createMockJevClient());
    expect(live.trace.events.length).toBeGreaterThan(0);

    const clientSpy: JevClient = {
      id: "mock",
      requestPolicy: vi.fn(() => {
        throw new Error("replay must not ask anyone");
      }),
    };
    const fetchSpy = vi.fn(() => {
      throw new Error("replay must not fetch");
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      let created: JevController | null = null;
      const run = buildScenarioRun(model, requestOf(SCENARIO), {
        controllers: {
          jev: (context: ControllerFactoryContext) => {
            created = createJevController({
              client: clientSpy,
              mode: "replay",
              trace: live.trace,
              scenarioFingerprint: context.fingerprint,
              refreshMs: 1_000,
            });
            return created;
          },
        },
      });
      run.runUnder("jev");
      expect(created).not.toBeNull();
      const controller: JevController = created as unknown as JevController;
      expect(controller.status().refreshes).toBe(0);
      expect(clientSpy.requestPolicy).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("replay reproduces the recorded run", () => {
  it("applies the same accepted policies at the same simulated times", () => {
    const live = runLive(SCENARIO, createMockJevClient());
    const replay = runReplay(SCENARIO, live.trace);
    expect(replay.controller.status().accepted).toBe(live.trace.events.length);
    const replayTrace = replay.controller.trace();
    expect(replayTrace.events.map((event) => event.policy)).toEqual(
      live.trace.events.map((event) => event.policy),
    );
    expect(replayTrace.events.map((event) => event.simulationTimeMs)).toEqual(
      live.trace.events.map((event) => event.simulationTimeMs),
    );
    expect(replayTrace.events.map((event) => event.requestGeneration)).toEqual(
      live.trace.events.map((event) => event.requestGeneration),
    );
    // The events are identical — same policies, same instants, same generations.
    expect(replayTrace.events).toEqual(live.trace.events);
    expect(JSON.stringify(replayTrace.events)).toBe(JSON.stringify(live.trace.events));
    // The trace's provenance differs on purpose: the replay produced its events
    // as a replay, and nothing may present that as a live run.
    expect(live.trace.client).toBe("mock");
    expect(replayTrace.client).toBe("replay");
    expect(serializeTrace(replayTrace)).not.toBe(serializeTrace(live.trace));
  });

  it("produces the same deterministic ChallengeResult as the recorded run", () => {
    const live = runLive(SCENARIO, createMockJevClient());
    const replay = runReplay(SCENARIO, live.trace);
    expect(replay.result.fingerprint).toBe(live.result.fingerprint);
    expect(replay.result.trip).toEqual(live.result.trip);
    expect(replay.result.city).toEqual(live.result.city);
    expect(JSON.stringify(replay.result.trip)).toBe(JSON.stringify(live.result.trip));
    expect(JSON.stringify(replay.result.city)).toBe(JSON.stringify(live.result.city));
  });

  it("replays a rush-hour run just as exactly", () => {
    const scenario: BenchmarkScenario = { ...SCENARIO, trafficLevel: "rush-hour" };
    const live = runLive(scenario, createMockJevClient());
    const replay = runReplay(scenario, live.trace);
    expect(replay.result.trip).toEqual(live.result.trip);
    expect(replay.result.city).toEqual(live.result.city);
    expect(live.trace.events.length).toBeGreaterThan(0);
  });

  it("round-trips through the serialised file form", () => {
    const live = runLive(SCENARIO, createMockJevClient());
    const text = serializeTrace(live.trace);
    const parsed = parseJevTrace(JSON.parse(text));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const replay = runReplay(SCENARIO, parsed.value);
    expect(replay.result.trip).toEqual(live.result.trip);
    expect(replay.result.city).toEqual(live.result.city);
  });
});

describe("replay refuses the wrong trace", () => {
  it("falls back to Adaptive rather than applying another scenario's policies", () => {
    const other: JevTrace = {
      version: 1,
      controllerId: "jev",
      client: "mock",
      scenarioFingerprint: "a-different-scenario",
      events: [
        {
          scenarioFingerprint: "a-different-scenario",
          simulationTimeMs: 0,
          requestedAtSimMs: 0,
          requestGeneration: 1,
          policy: {
            schemaVersion: JEV_SCHEMA_VERSION,
            pressureScale: 1.5,
            hint: "hold-longer",
            corridorWeights: [],
            regionWeights: [],
            corridorIntents: [],
            regionIntents: [],
          },
          source: "live",
        },
      ],
    };
    let created: JevController | null = null;
    const run = buildScenarioRun(model, requestOf(SCENARIO), {
      controllers: {
        jev: (context: ControllerFactoryContext) => {
          created = createJevController({
            client: null,
            mode: "replay",
            trace: other,
            scenarioFingerprint: context.fingerprint,
            refreshMs: 1_000,
          });
          return created;
        },
      },
    });
    // A replay with nothing valid to replay does not start at all: the wrong
    // trace is refused, and NOTHING is substituted for it.
    expect(() => run.runUnder("jev")).toThrow(/could not start/);
    if (created === null) {
      throw new Error("the jev controller was never built");
    }
    const controller: JevController = created;
    const status = controller.status();
    expect(status.accepted).toBe(0);
    expect(status.lastRejection?.kind).toBe("stale-fingerprint");
    expect(status.source).toBe("waiting");
    expect(status.start?.state).toBe("unable");
    expect(status.fallbackMs).toBe(0);
    expect(controller.trace().events).toHaveLength(0);
  });

  it("treats a missing trace as nothing to replay, and says so", () => {
    let created: JevController | null = null;
    const run = buildScenarioRun(model, requestOf(SCENARIO), {
      controllers: {
        jev: (context: ControllerFactoryContext) => {
          created = createJevController({
            client: null,
            mode: "replay",
            trace: null,
            scenarioFingerprint: context.fingerprint,
            refreshMs: 1_000,
          });
          return created;
        },
      },
    });
    expect(() => run.runUnder("jev")).toThrow(/could not start/);
    if (created === null) {
      throw new Error("the jev controller was never built");
    }
    const controller: JevController = created;
    const status = controller.status();
    expect(status.accepted).toBe(0);
    expect(status.source).toBe("waiting");
    expect(status.start?.state).toBe("unable");
    expect(status.fallbackMs).toBe(0);
    expect(status.invalidMs).toBe(0);
  });
});

describe("benchmark seam carries replay metadata", () => {
  it("marks a replayed run as a replay, with the counts to prove it", () => {
    const live = runLive(SCENARIO, createMockJevClient());
    let current: JevController | null = null;
    const records = runBenchmarkScenario(model, SCENARIO, ["jev"], {
      controllers: {
        jev: (context: ControllerFactoryContext) => {
          current = createJevController({
            client: null,
            mode: "replay",
            trace: live.trace,
            scenarioFingerprint: context.fingerprint,
            refreshMs: 1_000,
          });
          return current;
        },
      },
      describeController: () => (current === null ? undefined : jevProvenance(current.meta(), live.trace)),
    });
    expect(records).toHaveLength(1);
    const provenance = records[0].provenance!;
    expect(provenance.controller).toBe("jev");
    expect(provenance.mode).toBe("replay");
    expect(provenance.adapter).toBe("replay");
    expect(provenance.label).toBe("jev-replay");
    expect(provenance.accepted).toBe(live.trace.events.length);
    expect(provenance.refreshes).toBe(0);
    expect(provenance.liveMs).toBe(0);
    expect(provenance.trace?.client).toBe("mock");
    expect(provenance.trace?.events).toBe(live.trace.events.length);
    expect(provenance.replayMs).toBeGreaterThan(0);
  });

  it("marks a mocked live run as live, and refuses an unconfigured one", () => {
    let liveController: JevController | null = null;
    const liveRecords = runBenchmarkScenario(model, SCENARIO, ["jev"], {
      controllers: {
        jev: (context: ControllerFactoryContext) => {
          liveController = createJevController({
            client: createMockJevClient(),
            scenarioFingerprint: context.fingerprint,
            refreshMs: 1_000,
          });
          return liveController;
        },
      },
      describeController: () =>
        liveController === null ? undefined : jevProvenance(liveController.meta()),
    });
    expect(liveRecords[0].provenance?.mode).toBe("live");
    expect(liveRecords[0].provenance?.adapter).toBe("mock");
    expect(liveRecords[0].provenance?.label).toBe("jev-mock");
    expect(liveRecords[0].provenance?.modelInvolved).toBe(false);

    // A Jev run wired with NO client cannot obtain its first policy, so it never
    // starts and produces no artifact at all — never a fallback one.
    let unconfigured: JevController | null = null;
    expect(() =>
      runBenchmarkScenario(model, SCENARIO, ["jev"], {
        controllers: {
          jev: (context: ControllerFactoryContext) => {
            unconfigured = createJevController({
              client: null,
              scenarioFingerprint: context.fingerprint,
            });
            return unconfigured;
          },
        },
      }),
    ).toThrow(/could not start/);
    if (unconfigured === null) {
      throw new Error("the jev controller was never built");
    }
    const refused: JevController = unconfigured;
    expect(refused.meta().adapter).toBe("unconfigured");
    expect(refused.meta().accepted).toBe(0);
    expect(refused.meta().fallbackMs).toBe(0);
    expect(refused.meta().start?.state).toBe("unable");
  });
});

describe("pacing", () => {
  it("computes the delay to keep simulated time behind the wall clock", () => {
    // 8 simulated ms per wall ms: 8 s of simulated time wants 1 s of wall time.
    expect(paceDelayMs(8_000, 8, 0)).toBe(1_000);
    expect(paceDelayMs(8_000, 8, 1_000)).toBe(0);
    expect(paceDelayMs(8_000, 8, 400)).toBe(600);
    // Unpaced runs never wait.
    expect(paceDelayMs(8_000, 0, 0)).toBe(0);
    expect(paceDelayMs(8_000, Number.NaN, 0)).toBe(0);
  });

  it("does not change what is simulated", async () => {
    const scenario: BenchmarkScenario = { ...SCENARIO, durationMs: 5_000 };
    const runPaced = async (paceRatio: number) => {
      const run = buildScenarioRun(model, requestOf(scenario), {
        controllers: {
          jev: (context: ControllerFactoryContext) => {
            const controller = createJevController({
              client: createMockJevClient(),
              scenarioFingerprint: context.fingerprint,
              refreshMs: 1_000,
            });
            return controller;
          },
        },
      });
      return run.runUnderAsync("jev", { paceRatio });
    };
    const fast = await runPaced(0);
    // 50 simulated ms per wall ms: 5 s of simulated time takes ~0.1 s of wall.
    const paced = await runPaced(50_000);
    expect(paced.trip).toEqual(fast.trip);
    expect(paced.city).toEqual(fast.city);
  });
});
