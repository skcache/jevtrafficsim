/**
 * Jev benchmark provenance tests (Issue #38).
 *
 * The standard here is the one the issue set: hand the artifact to a hostile
 * engineer with zero repository context and they must be able to tell, from the
 * JSON alone, whether a `controller: "jev"` result came from the real service, a
 * deterministic stand-in, a replay, or the Adaptive fallback — and a mock run
 * must never be able to pass itself off as a live one.
 *
 * Nothing here changes what the simulation does: the same scenario, the same
 * controllers, the same engines. Only the metadata is under test.
 */
import { describe, expect, it } from "vitest";
import { aggregateRuns } from "@/benchmark/aggregate";
import { adapterBanner, buildDocument, jevLabel } from "@/benchmark/cli";
import { loadBenchmarkModel } from "@/benchmark/model";
import { runBenchmarkScenario, type BenchmarkRunRecord } from "@/benchmark/runner";
import type { BenchmarkMatrix } from "@/benchmark/scenarios";
import { createJevController, type JevController } from "@/controllers/jev";
import { createMockJevClient } from "@/jev/client";
import {
  adapterFromId,
  adapterInvolvesModel,
  jevProvenance,
  provenanceLabel,
  provenanceLine,
  type JevProvenance,
} from "@/jev/provenance";
import { parseJevTrace, serializeTrace, type JevTrace } from "@/jev/trace";

const model = loadBenchmarkModel();
const HORIZON_MS = 20_000;
const SCENARIO = {
  tripId: "soldier-field-to-navy-pier" as const,
  trafficLevel: "everyday" as const,
  driver: "tourist" as const,
  seed: 42,
  durationMs: HORIZON_MS,
};

/** A Jev run through the real runner, with the adapter the caller wired. */
function jevRecord(options: {
  readonly trace?: JevTrace | null;
  readonly replay?: boolean;
  readonly client?: "mock" | null;
}): { record: Extract<BenchmarkRunRecord, { controller: "jev" }>; controller: JevController } {
  let controller: JevController | null = null;
  const records = runBenchmarkScenario(model, SCENARIO, ["jev"], {
    controllers: {
      jev: (context) => {
        controller = createJevController({
          client: options.replay === true ? null : (options.client === null ? null : createMockJevClient()),
          mode: options.replay === true ? "replay" : "live",
          trace: options.trace ?? null,
          scenarioFingerprint: context.fingerprint,
          refreshMs: 1_000,
        });
        return controller;
      },
    },
    describeController: () => (controller === null ? undefined : jevProvenance(controller.meta(), options.trace ?? null)),
  });
  if (records[0].controller !== "jev") throw new Error("expected Jev record");
  return { record: records[0], controller: controller! };
}

/** A trace recorded from a mock live run, with #38's recorded-run block. */
function recordedTrace(): { trace: JevTrace; provenance: JevProvenance } {
  const { controller, record } = jevRecord({});
  const meta = controller.meta();
  const trace: JevTrace = {
    ...controller.trace(),
    recorded: {
      adapter: meta.adapter,
      accepted: meta.accepted,
      rejected: meta.rejected,
      refreshes: meta.refreshes,
      expiries: meta.expiries,
      liveMs: meta.liveMs,
      fallbackMs: meta.fallbackMs,
    },
  };
  return { trace, provenance: record.provenance! };
}

describe("adapter vocabulary", () => {
  it("maps every client id the codebase can produce, and nothing else", () => {
    expect(adapterFromId("mock")).toBe("mock");
    expect(adapterFromId("gateway")).toBe("gateway");
    expect(adapterFromId("live")).toBe("schema-service");
    expect(adapterFromId("replay")).toBe("replay");
    expect(adapterFromId("something-else")).toBeNull();
    expect(adapterFromId(undefined)).toBeNull();
  });

  it("says which adapters involve a model, and which cannot", () => {
    expect(adapterInvolvesModel("gateway")).toBe(true);
    expect(adapterInvolvesModel("schema-service")).toBe(true);
    expect(adapterInvolvesModel("mock")).toBe(false);
    expect(adapterInvolvesModel("replay")).toBe(false);
    expect(adapterInvolvesModel("unconfigured")).toBe(false);
  });

  it("labels every adapter with the same token the CLI prints", () => {
    expect(provenanceLabel("mock")).toBe("jev-mock");
    expect(provenanceLabel("gateway")).toBe("jev-gateway");
    expect(provenanceLabel("schema-service")).toBe("jev-schema-service");
    expect(provenanceLabel("replay")).toBe("jev-replay");
  });
});

describe("a mock run is unmistakably a mock run", () => {
  it("serializes adapter, mode and the fact that no model was involved", () => {
    const { record } = jevRecord({});
    const provenance = record.provenance!;
    expect(provenance.controller).toBe("jev");
    expect(provenance.adapter).toBe("mock");
    expect(provenance.label).toBe("jev-mock");
    expect(provenance.mode).toBe("live");
    expect(provenance.modelInvolved).toBe(false);
  });

  it("could not be mistaken for a gateway run even by JSON alone", () => {
    const mock = jevRecord({}).record;
    const serialized = JSON.parse(JSON.stringify(mock)) as { provenance: JevProvenance };
    expect(serialized.provenance.label).toBe("jev-mock");
    expect(JSON.stringify(serialized)).toContain('"modelInvolved":false');
    expect(JSON.stringify(serialized)).not.toContain('"gateway"');
  });

  it("prints a banner that says so in words, not only in a field", () => {
    const banner = adapterBanner({ jevAdapter: "mock" }, null);
    expect(banner).toContain("jev-mock");
    expect(banner).toContain("NO model, NO network, NO credential");
    expect(banner).toContain("NOT the Jev service");
    // The other adapters are named just as plainly.
    expect(adapterBanner({ jevAdapter: "gateway" }, null)).toContain("GATEWAY adapter");
    expect(adapterBanner({ jevAdapter: "live" }, null)).toContain("LIVE adapter");
    expect(adapterBanner({ jevAdapter: "replay" }, null)).toContain("REPLAY adapter");
    expect(jevLabel({ jevAdapter: "mock" })).toBe("jev-mock");
    expect(jevLabel({ jevAdapter: "live" })).toBe("jev-schema-service");
  });

  it("names the file and the document for the adapter that produced it", () => {
    const document = buildDocument(
      {
        trips: [SCENARIO.tripId],
        trafficLevels: [SCENARIO.trafficLevel],
        seeds: [SCENARIO.seed],
        drivers: [SCENARIO.driver],
        controllers: ["jev"],
        durationMs: HORIZON_MS,
      },
      [jevRecord({}).record],
      "mock",
    );
    expect(document.jevAdapter).toEqual({ adapter: "mock", label: "jev-mock", modelInvolved: false });
    const gatewayDocument = buildDocument(document.matrix, [], "gateway");
    expect(gatewayDocument.jevAdapter?.label).toBe("jev-gateway");
    expect(gatewayDocument.jevAdapter?.modelInvolved).toBe(true);
  });
});

describe("fallback and live time survive serialization", () => {
  it("records the funnel and the governed time for a run with a client", () => {
    const { record } = jevRecord({});
    const provenance = record.provenance!;
    for (const value of [provenance.accepted, provenance.rejected, provenance.refreshes, provenance.expiries]) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    for (const value of [provenance.liveMs, provenance.replayMs, provenance.fallbackMs]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    // The first window is always the fallback, so a live run shows both.
    expect(provenance.accepted).toBeGreaterThan(0);
    expect(provenance.liveMs).toBeGreaterThan(0);
    expect(provenance.fallbackMs).toBeGreaterThan(0);
    expect(provenance.replayMs).toBe(0);
    expect(provenance.traceEvents).toBe(provenance.accepted);
  });

  it("records a run that never had a policy source at all", () => {
    const { record } = jevRecord({ client: null });
    const provenance = record.provenance!;
    expect(provenance.adapter).toBe("unconfigured");
    expect(provenance.accepted).toBe(0);
    expect(provenance.liveMs).toBe(0);
    expect(provenance.fallbackMs).toBeGreaterThan(0);
  });

  it("keeps a saved record readable without any other file", () => {
    // The whole standard: one record, no repository, answer every question.
    const { record } = jevRecord({ client: null });
    const parsed = JSON.parse(JSON.stringify(record)) as typeof record;
    const provenance = parsed.provenance!;
    expect(provenance.accepted).toBe(0); // no live policy was ever accepted
    expect(provenance.liveMs).toBe(0); // none of the run was live
    expect(provenance.fallbackMs).toBeGreaterThan(0); // all of it was the fallback
    expect(provenance.adapter).toBe("unconfigured"); // and no adapter produced it
    expect(provenance.modelInvolved).toBe(false);
  });
});

describe("replay preserves what it replayed, and what that run was", () => {
  it("says replay, and carries the recorded run's history with it", () => {
    const { trace } = recordedTrace();
    // The trace travels as a file would: serialized, then parsed back.
    const parsed = parseJevTrace(JSON.parse(serializeTrace(trace)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const replay = jevRecord({ replay: true, trace: parsed.value });
    const provenance = replay.record.provenance!;
    expect(provenance.adapter).toBe("replay");
    expect(provenance.label).toBe("jev-replay");
    expect(provenance.mode).toBe("replay");
    expect(provenance.refreshes).toBe(0);
    expect(provenance.rejected).toBe(0);
    expect(provenance.replayMs).toBeGreaterThan(0);
    expect(provenance.liveMs).toBe(0);
    // ...and the recorded run is not laundered: it was a mock run that used the
    // fallback, and both facts survive into the replayed artifact.
    expect(provenance.trace?.client).toBe("mock");
    expect(provenance.trace?.events).toBe(trace.events.length);
    expect(provenance.recorded?.adapter).toBe("mock");
    expect(provenance.recorded?.fallbackMs).toBeGreaterThan(0);
    expect(provenance.recorded?.accepted).toBe(trace.events.length);
    expect(provenance.modelInvolved).toBe(false);
  });

  it("does not pretend a trace without a recorded block had a clean history", () => {
    const { trace } = recordedTrace();
    const legacy: JevTrace = {
      version: trace.version,
      controllerId: trace.controllerId,
      client: trace.client,
      scenarioFingerprint: trace.scenarioFingerprint,
      events: trace.events,
    };
    const parsed = parseJevTrace(JSON.parse(JSON.stringify(legacy)) as unknown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.recorded).toBeNull();
    const replay = jevRecord({ replay: true, trace: parsed.value });
    expect(replay.record.provenance?.recorded).toBeNull();
    // Unknown, not clean: the banner says so in words.
    expect(adapterBanner({ jevAdapter: "replay" }, parsed.value)).toContain(
      "fallback history is NOT recorded",
    );
  });

  it("follows the recorded run when deciding whether a model was involved", () => {
    const { controller, record } = jevRecord({});
    const meta = controller.meta();
    const gatewayTrace: JevTrace = {
      ...controller.trace(),
      client: "gateway",
      recorded: { ...record.provenance!.recorded!, adapter: "gateway" },
      events: controller.trace().events,
      version: controller.trace().version,
      controllerId: controller.trace().controllerId,
      scenarioFingerprint: controller.trace().scenarioFingerprint,
    };
    const provenance = jevProvenance({ ...meta, mode: "replay", adapter: "replay" }, gatewayTrace);
    expect(provenance.adapter).toBe("replay");
    expect(provenance.modelInvolved).toBe(true); // gateway replayed offline is still model-derived
  });
});

describe("aggregation never erases provenance", () => {
  it("keeps the adapter visible in every summary entry", () => {
    const { record } = jevRecord({});
    const groups = aggregateRuns([record]);
    const entry = groups[0].controllers[0];
    expect(entry.provenance?.label).toBe("jev-mock");
    expect(entry.provenance?.adapter).toBe("mock");
    expect(entry.provenance?.modelInvolved).toBe(false);
    expect(entry.provenance?.accepted).toBe(record.provenance?.accepted);
    expect(entry.provenance?.fallbackMs).toBe(record.provenance?.fallbackMs);
    // The entry's id names the source as well as the controller.
    expect(entry.id).toBe("jev#jev-mock");
  });

  it("splits runs of different provenance instead of merging them", () => {
    const mockRun = jevRecord({}).record;
    const gatewayRun = {
      ...mockRun,
      provenance: {
        ...mockRun.provenance!,
        label: "jev-gateway",
        adapter: "gateway",
        modelInvolved: true,
      } as JevProvenance,
    };
    const groups = aggregateRuns([mockRun, gatewayRun]);
    // Same scenario, same controller, different source: two entries, never one.
    expect(groups[0].controllers).toHaveLength(2);
    expect(groups[0].controllers.map((entry) => entry.id)).toEqual(["jev#jev-gateway", "jev#jev-mock"]);
    expect(groups[0].controllers[0].provenance?.modelInvolved).toBe(true);
    expect(groups[0].controllers[1].provenance?.modelInvolved).toBe(false);
    // And each summary describes only its own runs: no averaging across sources.
    expect(groups[0].controllers[0].runs).toBe(1);
    expect(groups[0].controllers[1].runs).toBe(1);
  });

  it("leaves Fixed and Adaptive summaries without provenance, as before", () => {
    const records = runBenchmarkScenario(model, SCENARIO, ["fixed", "adaptive"]);
    const groups = aggregateRuns(records);
    for (const entry of groups[0].controllers) {
      expect(entry.provenance).toBeNull();
      expect(entry.id).toBe(`${entry.controller}#none`);
    }
  });
});

describe("hardening changed no experimental semantics", () => {
  it("refuses to emit a Jev artifact whose run lost its provenance", () => {
    const { record } = jevRecord({});
    const { provenance: _omitted, ...missing } = record;
    void _omitted;
    const matrix: BenchmarkMatrix = {
      trips: [SCENARIO.tripId], trafficLevels: [SCENARIO.trafficLevel],
      seeds: [SCENARIO.seed], drivers: [SCENARIO.driver],
      controllers: ["jev"], durationMs: HORIZON_MS,
    };
    expect(() => buildDocument(matrix, [missing as BenchmarkRunRecord])).toThrow(/without provenance/);
  });

  it("produces byte-identical Fixed/Adaptive records to a run without any jev metadata", () => {
    const matrix: BenchmarkMatrix = {
      trips: [SCENARIO.tripId],
      trafficLevels: [SCENARIO.trafficLevel],
      seeds: [SCENARIO.seed],
      drivers: [SCENARIO.driver],
      controllers: ["fixed", "adaptive"],
      durationMs: HORIZON_MS,
    };
    const first = runBenchmarkScenario(model, SCENARIO, matrix.controllers, {});
    const second = runBenchmarkScenario(model, SCENARIO, matrix.controllers, {
      describeController: () => undefined,
    });
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    // The records still carry the scenario, the world receipt and the results.
    expect(first[0].controller).toBe("fixed");
    expect(first[0].fingerprint).toHaveLength(8);
    expect(Object.keys(first[0])).toEqual([
      "fingerprint",
      "scenario",
      "controller",
      "world",
      "trip",
      "city",
    ]);
  });

  it("does not let a replay document claim no model was involved", () => {
    const { record } = jevRecord({});
    const gatewayReplay = {
      ...record,
      provenance: {
        ...record.provenance!,
        adapter: "replay",
        mode: "replay",
        label: "jev-replay",
        modelInvolved: true,
        recorded: { ...record.provenance!.recorded!, adapter: "gateway" },
      } as JevProvenance,
    };
    const document = buildDocument(
      {
        trips: [SCENARIO.tripId],
        trafficLevels: [SCENARIO.trafficLevel],
        seeds: [SCENARIO.seed],
        drivers: [SCENARIO.driver],
        controllers: ["jev"],
        durationMs: HORIZON_MS,
      },
      [gatewayReplay],
      "replay",
    );
    // The flag says "replay"; the records say the recorded run used the model.
    expect(document.jevAdapter?.modelInvolved).toBe(true);
    expect(document.jevAdapter?.label).toBe("jev-replay");
  });

  it("keeps the trace reference out of a non-replay run", () => {
    const { record } = jevRecord({});
    expect(record.provenance?.trace).toBeNull();
    expect(record.provenance?.recorded).toBeNull();
  });

  it("describes a provenance record in one line, mock first", () => {
    const line = provenanceLine(jevRecord({}).record.provenance!);
    expect(line.startsWith("jev-mock (mode=live, adapter=mock, model=no)")).toBe(true);
    expect(line).toContain("accepted");
    expect(line).toContain("governed: live");
  });
});
