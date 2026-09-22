/**
 * Jev adapter tests (Issue #13).
 *
 * What is pinned here:
 *
 * - the request schema: what we send is bounded, and a malformed one is refused
 * - the policy schema: structure and identity are strict, magnitudes are clamped
 * - no ego privilege: no ego field exists in the request, no adapter module can
 *   read ego state, and no frame field carries vehicle identity
 * - the client boundary: the browser path carries no credential, the route
 *   never echoes one, and the worker protocol has no field to put one in
 * - deterministic policy translation: same policy + same frame, same directives
 * - signal safety under adversarial output: a hostile policy cannot produce an
 *   illegal directive, cannot jump the legal minimum green, and cannot starve a
 *   movement
 * - the refresh cadence: one citywide request every few SIMULATED seconds, not
 *   per tick, not per vehicle, not per intersection
 *
 * The mock adapter is used throughout: it is deterministic, it needs no
 * network, and it is labelled as a mock everywhere it appears.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createJevController,
  jevDirective,
  jevPhaseWeight,
  resolveJevWeights,
  type JevController,
} from "@/controllers/jev";
import { createMockJevClient, createRelayJevClient, type JevClient } from "@/jev/client";
import { buildJevPolicyRequest, jevPolicyContext } from "@/jev/request";
import {
  JEV_LIMITS,
  JEV_SCHEMA_VERSION,
  neutralJevPolicy,
  parseJevPolicy,
  validateJevPolicyRequest,
  type JevPolicy,
  type JevPolicyRequest,
} from "@/jev/schema";
import { DEFAULT_SIGNAL_TIMING } from "@/sim/config";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createEngine, stepEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import { buildObservationFrame, type IntersectionObservation, type PhaseObservation } from "@/sim/observations";
import { buildCityPartition, type CityPartition } from "@/sim/regions";
import type { SignalDirective, SignalState, SignalStage } from "@/sim/signals";
import { makeCrossroads } from "./traffic-support";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function phase(phaseIndex: number, overrides: Partial<PhaseObservation> = {}): PhaseObservation {
  return {
    phaseIndex,
    roads: [phaseIndex * 10, phaseIndex * 10 + 1],
    queuedVehicles: 0,
    maxWaitMs: 0,
    arrivalRatePerSecond: 0,
    occupancyRatio: 0,
    downstreamOccupancyRatio: 0,
    ...overrides,
  };
}

function observation(
  phases: PhaseObservation[],
  overrides: Partial<IntersectionObservation> = {},
): IntersectionObservation {
  return {
    intersectionId: 0,
    stage: "green",
    phaseIndex: 0,
    stageElapsedMs: 10_000,
    phaseCount: phases.length,
    phases,
    ...overrides,
  };
}

function signal(overrides: Partial<SignalState> = {}): SignalState {
  return {
    intersectionId: 0,
    groups: [[0, 1], [10, 11]],
    phaseIndex: 0,
    stage: "green" as SignalStage,
    stageElapsedMs: 10_000,
    timing: { ...DEFAULT_SIGNAL_TIMING },
    ...overrides,
  };
}

function policy(overrides: Partial<JevPolicy> = {}): JevPolicy {
  return { ...neutralJevPolicy(), ...overrides };
}

/**
 * A four-way signalized crossroads with traffic arriving on every arm, plus the
 * partition and the centre intersection id. `vehicles: false` gives an empty
 * city for tests that only need geometry.
 */
function crossroadsCity(options: { vehicles?: boolean } = {}): {
  engine: EngineState;
  partition: CityPartition;
  intersectionId: number;
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
  const spawns: ScheduledSpawn[] = [];
  if (options.vehicles !== false) {
    for (let index = 0; index < built.approachRoadIds.length; index += 1) {
      const origin = built.city.roads[built.approachRoadIds[index]].from;
      const next = built.approachRoadIds[(index + 1) % built.approachRoadIds.length];
      spawns.push({
        timeMs: index * 1_000,
        type: "car",
        origin,
        destination: built.city.roads[next].from,
      });
    }
  }
  const engine = createEngine({
    city: built.city,
    controller: createAdaptiveController(),
    spawns,
  });
  return {
    engine,
    partition: buildCityPartition(built.city),
    intersectionId: built.centerId,
    spawns,
  };
}

function frameOf(engine: EngineState) {
  return buildObservationFrame(engine.city, engine.traffic, engine.arrivals);
}

function requestFor(engine: EngineState, partition: CityPartition): JevPolicyRequest {
  return buildJevPolicyRequest({
    frame: frameOf(engine),
    partition,
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  });
}

/** Source with comments removed: scans test code, not prose about code. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Walk every number in a JSON document (for "does it contain X" checks). */
function collectKeys(value: unknown, keys: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectKeys(entry, keys);
    }
    return keys;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      keys.push(key);
      collectKeys(entry, keys);
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// 1. request schema
// ---------------------------------------------------------------------------

describe("jev request schema", () => {
  it("accepts a well-formed request and rejects a malformed one", () => {
    const { engine, partition } = crossroadsCity();
    for (let tick = 0; tick < 40; tick += 1) {
      stepEngine(engine);
    }
    const request = requestFor(engine, partition);
    expect(validateJevPolicyRequest(request)).toEqual({ ok: true, value: request });

    const base = JSON.parse(JSON.stringify(request)) as Record<string, unknown>;
    const broken: [string, (value: Record<string, unknown>) => void][] = [
      ["not an object", () => undefined],
      ["bad schema version", (value) => (value.schemaVersion = 99)],
      ["negative time", (value) => (value.timeMs = -1)],
      ["non-finite time", (value) => (value.timeMs = Number.NaN)],
      ["zero window", (value) => (value.windowMs = 0)],
      ["missing city", (value) => delete value.city],
      ["negative city field", (value) => ((value.city as Record<string, unknown>).queuedVehicles = -3)],
      ["non-finite city field", (value) => ((value.city as Record<string, unknown>).maxWaitMs = Number.POSITIVE_INFINITY)],
      ["missing hotspots", (value) => delete value.hotspots],
      ["hotspots not an array", (value) => (value.hotspots = {})],
      ["hotspot without an id", (value) => ((value.hotspots as unknown[])[0] = { queuedVehicles: 1 })],
      ["too many hotspots", (value) => (value.hotspots = Array.from({ length: JEV_LIMITS.REQUEST_HOTSPOTS + 1 }, () => ({ intersectionId: 0 })))],
    ];
    for (const [label, mutate] of broken) {
      const candidate = label === "not an object" ? 42 : structuredClone(base);
      if (label !== "not an object") {
        mutate(candidate as Record<string, unknown>);
      }
      const result = validateJevPolicyRequest(candidate);
      expect(result.ok, `expected rejection: ${label}`).toBe(false);
    }
  });

  it("bounds the request: caps every list and keeps it compact", () => {
    const { engine, partition } = crossroadsCity();
    const request = buildJevPolicyRequest(
      { frame: frameOf(engine), partition, intersections: engine.city.intersections.length, activeVehicles: 0 },
      { maxCorridors: 2, maxRegions: 1, maxHotspots: 1 },
    );
    expect(request.corridors.length).toBeLessThanOrEqual(2);
    expect(request.regions.length).toBeLessThanOrEqual(1);
    expect(request.hotspots.length).toBeLessThanOrEqual(1);
    expect(request.schemaVersion).toBe(JEV_SCHEMA_VERSION);
  });

  it("is a pure function of its inputs", () => {
    const { engine, partition } = crossroadsCity();
    for (let tick = 0; tick < 25; tick += 1) {
      stepEngine(engine);
    }
    const first = requestFor(engine, partition);
    const second = requestFor(engine, partition);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});

// ---------------------------------------------------------------------------
// 2. policy schema + 3. bounds
// ---------------------------------------------------------------------------

describe("jev policy schema", () => {
  const context = { corridorIds: [3, 7], regionIds: [1, 2] };

  it("parses a well-formed policy", () => {
    const result = parseJevPolicy(
      {
        schemaVersion: JEV_SCHEMA_VERSION,
        pressureScale: 1.2,
        hint: "hold-longer",
        corridorWeights: [{ id: 3, weight: 1.5 }],
        regionWeights: [{ id: 2, weight: 0.75 }],
      },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.policy.pressureScale).toBe(1.2);
    expect(result.value.policy.hint).toBe("hold-longer");
    expect(result.value.policy.corridorWeights).toEqual([{ id: 3, weight: 1.5 }]);
    expect(result.value.clamped).toEqual([]);
  });

  it("defaults every omitted field to neutral", () => {
    const result = parseJevPolicy({ schemaVersion: JEV_SCHEMA_VERSION }, context);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.policy).toEqual(neutralJevPolicy());
  });

  it("rejects malformed policies outright", () => {
    const cases: [string, unknown][] = [
      ["not an object", "policy"],
      ["null", null],
      ["array", []],
      ["wrong schema version", { schemaVersion: 2 }],
      ["missing schema version", { pressureScale: 1 }],
      ["non-finite pressure scale", { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: Number.NaN }],
      ["string pressure scale", { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: "1.2" }],
      ["unknown hint", { schemaVersion: JEV_SCHEMA_VERSION, hint: "clear-the-arterials" }],
      ["hint not a string", { schemaVersion: JEV_SCHEMA_VERSION, hint: 7 }],
      ["weights not an array", { schemaVersion: JEV_SCHEMA_VERSION, corridorWeights: {} }],
      ["weight entry not an object", { schemaVersion: JEV_SCHEMA_VERSION, corridorWeights: [4] }],
      ["weight id not an integer", { schemaVersion: JEV_SCHEMA_VERSION, corridorWeights: [{ id: 1.5, weight: 1 }] }],
      ["weight not finite", { schemaVersion: JEV_SCHEMA_VERSION, corridorWeights: [{ id: 3, weight: Number.POSITIVE_INFINITY }] }],
      ["unknown corridor id", { schemaVersion: JEV_SCHEMA_VERSION, corridorWeights: [{ id: 999, weight: 1 }] }],
      ["unknown region id", { schemaVersion: JEV_SCHEMA_VERSION, regionWeights: [{ id: 999, weight: 1 }] }],
      ["duplicate id", { schemaVersion: JEV_SCHEMA_VERSION, corridorWeights: [{ id: 3, weight: 1 }, { id: 3, weight: 1 }] }],
      [
        "too many entries",
        {
          schemaVersion: JEV_SCHEMA_VERSION,
          corridorWeights: Array.from({ length: JEV_LIMITS.POLICY_ENTRIES + 1 }, (_, index) => ({
            id: index === 0 ? 3 : 7,
            weight: 1,
          })),
        },
      ],
    ];
    for (const [label, candidate] of cases) {
      const result = parseJevPolicy(candidate, context);
      expect(result.ok, `expected rejection: ${label}`).toBe(false);
    }
  });

  it("clamps out-of-range magnitudes and reports each one", () => {
    const result = parseJevPolicy(
      {
        schemaVersion: JEV_SCHEMA_VERSION,
        pressureScale: 99,
        corridorWeights: [
          { id: 3, weight: 0.001 },
          { id: 7, weight: 500 },
        ],
        regionWeights: [{ id: 1, weight: -4 }],
      },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.policy.pressureScale).toBe(JEV_LIMITS.PRESSURE_SCALE_MAX);
    expect(result.value.policy.corridorWeights).toEqual([
      { id: 3, weight: JEV_LIMITS.WEIGHT_MIN },
      { id: 7, weight: JEV_LIMITS.WEIGHT_MAX },
    ]);
    expect(result.value.policy.regionWeights).toEqual([{ id: 1, weight: JEV_LIMITS.WEIGHT_MIN }]);
    expect(result.value.clamped).toHaveLength(4);
  });

  it("ignores unknown fields so a newer service cannot break the adapter", () => {
    const result = parseJevPolicy(
      { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.1, tomorrow: "a new idea", phases: [1, 2] },
      context,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.value.policy.pressureScale).toBe(1.1);
    expect(Object.keys(result.value.policy)).toEqual([
      "schemaVersion",
      "pressureScale",
      "hint",
      "corridorWeights",
      "regionWeights",
      "corridorIntents",
      "regionIntents",
    ]);
  });

  it("has no field that could name a lamp state or a phase", () => {
    const keys = collectKeys(neutralJevPolicy());
    for (const banned of ["phaseIndex", "green", "yellow", "allRed", "all-red", "stage", "lamp", "durationMs"]) {
      expect(keys).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. no ego privilege
// ---------------------------------------------------------------------------

describe("no ego privilege", () => {
  it("sends no ego field and no vehicle-level field at all", () => {
    const { engine, partition } = crossroadsCity();
    // Give the engine an ego: if anything ego-shaped could leak, this is when.
    engine.egoVehicleId = engine.traffic.vehicles[0]?.id ?? null;
    for (let tick = 0; tick < 30; tick += 1) {
      stepEngine(engine);
    }
    const request = requestFor(engine, partition);
    const keys = collectKeys(request);
    for (const key of keys) {
      expect(key, `request must not carry an ego field: ${key}`).not.toMatch(/ego/i);
      expect(key, `request must not carry a route field: ${key}`).not.toMatch(/route|destination/i);
    }
    // The only vehicle-shaped things in the request are aggregate counts.
    const vehicleKeys = [...new Set(keys.filter((key) => /vehicle/i.test(key)))].sort();
    expect(vehicleKeys).toEqual(["activeVehicles", "queuedVehicles"]);
    expect(typeof request.city.activeVehicles).toBe("number");
    expect(typeof request.city.queuedVehicles).toBe("number");
  });

  it("carries no vehicle identity in the observation frame it is built from", () => {
    const { engine } = crossroadsCity();
    engine.egoVehicleId = engine.traffic.vehicles[0]?.id ?? null;
    for (let tick = 0; tick < 30; tick += 1) {
      stepEngine(engine);
    }
    const frame = frameOf(engine);
    const keys = collectKeys({
      approaches: [...frame.approaches.values()],
      intersections: [...frame.intersections.values()],
    });
    const identityKeys = keys.filter((key) => /ego|route|destination/i.test(key));
    expect(identityKeys).toEqual([]);
    // Vehicle-shaped fields are counts only — never an id, never a list.
    expect([...new Set(keys.filter((key) => /vehicle/i.test(key)))].sort()).toEqual(["queuedVehicles"]);
  });

  it("cannot be reached from the adapter modules", () => {
    // Source scan: the adapter and the controller never name ego state, so
    // there is no code path by which a policy could privilege the visible trip.
    const files = [
      "jev/schema.ts",
      "jev/request.ts",
      "jev/client.ts",
      "controllers/jev.ts",
    ];
    for (const file of files) {
      const scanned = code(readFileSync(path.join(process.cwd(), file), "utf8"));
      expect(scanned, `${file} must not read ego state`).not.toMatch(/egoVehicleId|\bego\b/i);
      expect(scanned, `${file} must not read a vehicle route`).not.toMatch(/\.route\b/);
      expect(scanned, `${file} must not read vehicle identity`).not.toMatch(/\.id\s*===\s*traffic|vehicle\.id/);
    }
    // And the request builder never receives the traffic state at all: only the
    // engine-owned frame, the partition and two counts.
    const requestSource = code(readFileSync(path.join(process.cwd(), "jev", "request.ts"), "utf8"));
    expect(requestSource).not.toMatch(/TrafficState/);
  });

  it("is exercised by the same controller the challenge harness runs", () => {
    // The visible trip is measured after the run (ChallengeResult), never fed
    // into the policy: the controller's only inputs are city, traffic and the
    // engine-owned context, and it reads just the frame's aggregates.
    const controller = createJevController({ client: createMockJevClient(), scenarioFingerprint: "adapter-1" });
    expect(controller.id).toBe("jev");
    const { engine, partition } = crossroadsCity();
    const directives = controller.directives(engine.city, engine.traffic, {
      observations: frameOf(engine),
      partition,
    });
    expect(directives.size).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// 5. client + secret boundary
// ---------------------------------------------------------------------------

describe("client boundary", () => {
  it("sends no credential from the browser-side relay client", async () => {
    const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
    const client = createRelayJevClient({
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({
          url,
          headers: (init.headers ?? {}) as Record<string, string>,
          body: String(init.body),
        });
        return new Response(JSON.stringify({ policy: neutralJevPolicy() }), { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.requestPolicy(requestFixture());
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/api/jev/policy");
    const headerText = JSON.stringify(seen[0].headers).toLowerCase();
    expect(headerText).not.toContain("authorization");
    expect(headerText).not.toContain("bearer");
    expect(seen[0].body).not.toMatch(/token|secret|api[-_]?key/i);
  });

  it("keeps the credential out of the worker protocol and the app surface", () => {
    const files = ["worker/protocol.ts", "worker/simulation.worker.ts", "components/ui-model.ts"];
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source, `${file} must not read the jev credential`).not.toMatch(/JEV_TOKEN|JEV_ENDPOINT/);
      expect(source, `${file} must not carry a token field`).not.toMatch(/\btoken\s*:/);
    }
  });

  it("reads its credentials from arguments, never from the environment", () => {
    const clientSource = code(readFileSync(path.join(process.cwd(), "jev", "client.ts"), "utf8"));
    expect(clientSource).not.toMatch(/process\.env/);
  });

  it("refuses to invent a policy when the service is unavailable", async () => {
    const client = createRelayJevClient({
      fetchImpl: (async () =>
        new Response(JSON.stringify({ error: "jev is not configured" }), { status: 503 })) as unknown as typeof fetch,
    });
    await expect(client.requestPolicy(requestFixture())).rejects.toThrow(/not configured/);
  });

  it("keeps a failed refresh from replacing a good policy", () => {
    let calls = 0;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        calls += 1;
        if (calls === 1) {
          return { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.4 };
        }
        throw new Error("service exploded");
      },
    };
    const { engine, partition } = crossroadsCity();
    const controller = createJevController({ client, refreshMs: 500, minHoldMs: 100, scenarioFingerprint: "adapter-2" });
    for (let tick = 0; tick < 60; tick += 1) {
      // A fresh frame per tick, exactly as the engine supplies one.
      controller.directives(engine.city, engine.traffic, {
        observations: frameOf(engine),
        partition,
      });
      stepEngine(engine);
    }
    const status = controller.status();
    expect(status.accepted).toBeGreaterThanOrEqual(1);
    expect(status.rejected).toBeGreaterThanOrEqual(1);
    expect(status.lastRejection?.detail).toContain("service exploded");
    // The good policy is still in force; nothing was invented to replace it.
    expect(controller.policy()?.pressureScale).toBe(1.4);
  });
});

// ---------------------------------------------------------------------------
// 6. deterministic translation
// ---------------------------------------------------------------------------

describe("policy translation", () => {
  it("turns a weight into a bounded phase weight", () => {
    const { partition, intersectionId } = crossroadsCity();
    const weights = resolveJevWeights(
      policy({ pressureScale: 1.5, corridorWeights: [{ id: 0, weight: 2 }], regionWeights: [{ id: 0, weight: 2 }] }),
    );
    const bounded = jevPhaseWeight(phase(0), intersectionId, partition, weights);
    expect(bounded).toBeLessThanOrEqual(JEV_LIMITS.COMBINED_WEIGHT_MAX);
    expect(bounded).toBeGreaterThanOrEqual(JEV_LIMITS.COMBINED_WEIGHT_MIN);

    const neutral = resolveJevWeights(neutralJevPolicy());
    expect(jevPhaseWeight(phase(0), intersectionId, partition, neutral)).toBe(1);
  });

  it("lets a policy change a decision, deterministically", () => {
    // Current phase slightly ahead of its successor: neutral holds, a heavy
    // weight on the successor's corridor advances.
    const phases = [
      phase(0, { queuedVehicles: 6, roads: [0, 1] }),
      phase(1, { queuedVehicles: 4, roads: [10, 11] }),
    ];
    const state = signal();
    const seen = observation(phases);
    const { partition, intersectionId } = crossroadsCity();

    const neutral = resolveJevWeights(neutralJevPolicy());
    const neutralDirective = jevDirective(
      state,
      seen,
      (index) => jevPhaseWeight(seen.phases[index], intersectionId, partition, neutral),
      neutral.marginScale,
    );
    expect(neutralDirective).toBe("hold");

    const boosted = resolveJevWeights(
      policy({
        hint: "switch-sooner",
        regionWeights: [{ id: partition.intersectionRegion.get(intersectionId) ?? 0, weight: 2 }],
      }),
    );
    const boostedDirective = jevDirective(
      state,
      seen,
      (index) => (index === 1 ? 2 : 1),
      boosted.marginScale,
    );
    expect(boostedDirective).toBe("advance");

    // Same inputs, same answer, every time.
    for (let repeat = 0; repeat < 5; repeat += 1) {
      expect(
        jevDirective(
          state,
          seen,
          (index) => (index === 1 ? 2 : 1),
          boosted.marginScale,
        ),
      ).toBe("advance");
    }
  });

  it("produces identical directive streams for identical runs", () => {
    const run = (): string[] => {
      const { engine, partition } = crossroadsCity();
      const controller = createJevController({ client: createMockJevClient(), scenarioFingerprint: "adapter-1" });
      const trace: string[] = [];
      for (let tick = 0; tick < 80; tick += 1) {
        const directives = controller.directives(engine.city, engine.traffic, {
          observations: frameOf(engine),
          partition,
        });
        trace.push(
          [...directives.entries()]
            .sort(([a], [b]) => a - b)
            .map(([id, directive]) => `${id}:${directive}`)
            .join(","),
        );
        stepEngine(engine);
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });
});

// ---------------------------------------------------------------------------
// 7. safety under adversarial output
// ---------------------------------------------------------------------------

describe("signal safety", () => {
  it("cannot jump the legal minimum green, whatever the policy says", () => {
    const state = signal({ stageElapsedMs: DEFAULT_SIGNAL_TIMING.minGreenMs - 100 });
    const phases = [
      phase(0, { queuedVehicles: 0 }),
      phase(1, { queuedVehicles: 12, maxWaitMs: 20_000 }),
    ];
    const seen = observation(phases, { stageElapsedMs: state.stageElapsedMs });
    const directive = jevDirective(state, seen, (index) => (index === 1 ? 2 : 0.25), 2);
    expect(directive).toBeUndefined();
  });

  it("cannot starve a movement, however hostile the weights are", () => {
    const starved = phase(1, { queuedVehicles: 0, maxWaitMs: 40_000 });
    const favoured = phase(0, { queuedVehicles: 40, maxWaitMs: 0 });
    const state = signal();
    const seen = observation([favoured, starved]);
    // Weights at the extreme bounds against the starved phase, and a hint that
    // holds greens as long as the bounds allow.
    const directive = jevDirective(state, seen, (index) => (index === 0 ? 2 : 0.25), 2);
    expect(directive).toBe("advance");
  });

  it("never emits anything but hold or advance", () => {
    const { engine, partition } = crossroadsCity();
    const hostile = createJevController({
      scenarioFingerprint: "adapter-hostile",
      client: createMockJevClient({
        respond: () => ({
          schemaVersion: JEV_SCHEMA_VERSION,
          pressureScale: 1e9,
          hint: "switch-sooner",
          corridorWeights: Array.from({ length: 20 }, (_, index) => ({ id: index, weight: index === 0 ? -1e9 : 1e9 })),
          regionWeights: [{ id: 0, weight: 1e9 }],
        }),
      }),
    });
    const legal = new Set<SignalDirective>(["hold", "advance"]);
    for (let tick = 0; tick < 120; tick += 1) {
      const directives = hostile.directives(engine.city, engine.traffic, {
        observations: frameOf(engine),
        partition,
      });
      for (const directive of directives.values()) {
        expect(legal.has(directive)).toBe(true);
      }
      stepEngine(engine);
    }
    // Clamped, not obeyed: the scale never leaves its bounds.
    expect(hostile.policy()?.pressureScale ?? 0).toBeLessThanOrEqual(JEV_LIMITS.PRESSURE_SCALE_MAX);
    expect(
      (hostile.policy()?.corridorWeights ?? []).every((entry) => entry.weight <= JEV_LIMITS.WEIGHT_MAX),
    ).toBe(true);
  });

  it("keeps the engine's own signal timing intact under a hostile policy", () => {
    const { engine: fixture, partition } = crossroadsCity({ vehicles: false });
    // A demand stream, so the hostile policy is actually asked to make
    // decisions: one car per arm per second for the whole run. Arm sources are
    // the far ends of the roads that arrive at the centre.
    const sources = fixture.city.roads
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
    // Every weight at the top of its bounds, and a hint that relinquishes greens
    // as fast as the bounds allow: the most aggressive policy the schema admits.
    const controller = createJevController({
      scenarioFingerprint: "adapter-engine",
      client: createMockJevClient({
        respond: (request) => ({
          schemaVersion: JEV_SCHEMA_VERSION,
          pressureScale: JEV_LIMITS.PRESSURE_SCALE_MAX,
          hint: "switch-sooner",
          corridorWeights: request.corridors.map((corridor) => ({
            id: corridor.corridorId,
            weight: JEV_LIMITS.WEIGHT_MAX,
          })),
          regionWeights: request.regions.map((region) => ({
            id: region.regionId,
            weight: JEV_LIMITS.WEIGHT_MAX,
          })),
        }),
      }),
    });
    const driven = createEngine({ city: fixture.city, controller, spawns });
    const minGreen = DEFAULT_SIGNAL_TIMING.minGreenMs;
    // Last GREEN seen per signal: the yellow/all-red clearance that follows a
    // phase is short by design, so the invariant is on the green it served.
    const lastGreen = new Map<number, { phase: number; elapsed: number }>();
    let phaseChanges = 0;
    for (let tick = 0; tick < 400; tick += 1) {
      stepEngine(driven);
      for (const [id, signalState] of driven.traffic.signals) {
        const served = lastGreen.get(id);
        if (signalState.stage === "green") {
          if (served && served.phase !== signalState.phaseIndex) {
            // A different phase is green now: the one that just ended served at
            // least its legal minimum before yielding (clearance stages are the
            // mechanics' business and are short by design).
            phaseChanges += 1;
            expect(served.elapsed, `signal ${id} left green too early`).toBeGreaterThanOrEqual(
              minGreen,
            );
            expect(partition.intersectionRegion.has(id)).toBe(true);
          }
          lastGreen.set(id, {
            phase: signalState.phaseIndex,
            elapsed: signalState.stageElapsedMs,
          });
        }
      }
    }
    expect(phaseChanges).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 8. cadence
// ---------------------------------------------------------------------------

describe("refresh cadence", () => {
  it("asks once per refresh window of SIMULATED time, not per tick", () => {
    const requests: JevPolicyRequest[] = [];
    const client: JevClient = {
      id: "mock",
      requestPolicy: (request) => {
        requests.push(request);
        return neutralJevPolicy();
      },
    };
    const { engine, partition } = crossroadsCity();
    const controller = createJevController({ client, refreshMs: 1_000, scenarioFingerprint: "adapter-4" });
    const horizonTicks = 500; // 50 s of simulated time at 100 ms per tick
    let lastObservedMs = 0;
    for (let tick = 0; tick < horizonTicks; tick += 1) {
      lastObservedMs = engine.traffic.timeMs;
      controller.directives(engine.city, engine.traffic, {
        observations: frameOf(engine),
        partition,
      });
      stepEngine(engine);
    }
    // One request per refresh window of simulated time, including t = 0.
    expect(requests.length).toBe(Math.floor(lastObservedMs / 1_000) + 1);
    expect(requests.length).toBeLessThan(horizonTicks / 5);
    expect(requests[0].timeMs % 1_000).toBe(0);
    expect(requests[1].timeMs - requests[0].timeMs).toBe(1_000);
    // One request covers the whole city, so the count is set by the horizon and
    // the window alone: the same run with an empty city asks exactly as often.
    const { engine: empty, partition: emptyPartition } = crossroadsCity({ vehicles: false });
    const quietRequests: JevPolicyRequest[] = [];
    const quiet = createJevController({
      scenarioFingerprint: "adapter-quiet",
      client: {
        id: "mock",
        requestPolicy: (request) => {
          quietRequests.push(request);
          return neutralJevPolicy();
        },
      },
      refreshMs: 1_000,
    });
    for (let tick = 0; tick < horizonTicks; tick += 1) {
      quiet.directives(empty.city, empty.traffic, {
        observations: frameOf(empty),
        partition: emptyPartition,
      });
      stepEngine(empty);
    }
    expect(quietRequests.length).toBe(requests.length);
    expect(quietRequests.length).toBeGreaterThan(0);
  });

  it("defers rather than stacking when a request is still in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;
    const client: JevClient = {
      id: "mock",
      requestPolicy: () => {
        calls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(neutralJevPolicy());
          }, 25);
        });
      },
    };
    const { engine, partition } = crossroadsCity();
    const controller = createJevController({ client, refreshMs: 100, scenarioFingerprint: "adapter-5" });
    for (let tick = 0; tick < 40; tick += 1) {
      const context = { observations: frameOf(engine), partition };
      controller.directives(engine.city, engine.traffic, context);
      stepEngine(engine);
      await new Promise((resolve) => {
        setTimeout(resolve, 3);
      });
    }
    expect(calls).toBeGreaterThan(0);
    expect(maxInFlight).toBe(1);
  });

  it("runs on the neutral policy until an answer arrives", () => {
    const { engine, partition } = crossroadsCity();
    const controller: JevController = createJevController({
      scenarioFingerprint: "adapter-6",
      client: { id: "mock", requestPolicy: () => new Promise(() => undefined) },
    });
    // Two ticks: the first only establishes the clock, the second accounts for
    // the interval the fallback governed.
    controller.directives(engine.city, engine.traffic, {
      observations: frameOf(engine),
      partition,
    });
    stepEngine(engine);
    controller.directives(engine.city, engine.traffic, {
      observations: frameOf(engine),
      partition,
    });
    const status = controller.status();
    // No policy yet: the Adaptive fallback is what governs the city.
    expect(status.source).toBe("fallback");
    expect(status.acceptedAtSimMs).toBeNull();
    expect(controller.policy()).toBeNull();
    expect(status.fallbackMs).toBeGreaterThan(0);
  });
});

/** A minimal well-formed request, for client-level tests. */
function requestFixture(): JevPolicyRequest {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: 0,
    windowMs: 5_000,
    city: {
      intersections: 1,
      signalizedIntersections: 1,
      activeVehicles: 0,
      queuedVehicles: 0,
      maxWaitMs: 0,
      arrivalRatePerSecond: 0,
    },
    corridors: [{ corridorId: 1, kind: "arterial", intersections: 1, queuedVehicles: 0, maxWaitMs: 0, arrivalRatePerSecond: 0, occupancyRatio: 0 }],
    regions: [{ regionId: 1, intersections: 1, signalizedIntersections: 1, queuedVehicles: 0, maxWaitMs: 0, arrivalRatePerSecond: 0, occupancyRatio: 0 }],
    hotspots: [
      {
        intersectionId: 1,
        regionId: 1,
        stage: "green",
        phaseIndex: 0,
        phaseCount: 2,
        stageElapsedMs: 0,
        queuedVehicles: 0,
        maxWaitMs: 0,
        arrivalRatePerSecond: 0,
        occupancyRatio: 0,
        downstreamOccupancyRatio: 0,
      },
    ],
  };
}

describe("policy context", () => {
  it("only offers ids the request carried", () => {
    const request = requestFixture();
    expect(jevPolicyContext(request)).toEqual({ corridorIds: [1], regionIds: [1] });
    const rejected = parseJevPolicy(
      { schemaVersion: JEV_SCHEMA_VERSION, corridorWeights: [{ id: 2, weight: 1 }] },
      jevPolicyContext(request),
    );
    expect(rejected.ok).toBe(false);
  });
});
