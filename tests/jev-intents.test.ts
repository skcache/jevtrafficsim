/**
 * Coordinated zone intents — the shipping pass's answer to "Jev and Adaptive
 * look the same".
 *
 * The surface is deliberately tiny: one bounded entry about a corridor or a
 * region, and the only thing it can do is bias the switch margin at every
 * intersection that serves that zone. That is the smallest thing Adaptive
 * structurally cannot express, because Adaptive only ever sees one intersection's
 * own approaches — it has no representation of "release this region" or "throttle
 * entry to it", no matter how hard it looks at local pressure.
 *
 * What these tests pin:
 *   - the schema keeps the surface bounded and hostile input out
 *   - one intent moves MANY intersections, and in the same direction
 *   - neutral stays exactly Adaptive (the ablation must survive the extension)
 *   - a stressed Chicago scenario diverges in actual signal decisions and in the
 *     final ChallengeResult, without anyone tuning for a winner
 */
import { describe, expect, it } from "vitest";
import type { CuratedTripId } from "@/cities/chicago-trips";
import { loadBenchmarkModel } from "@/benchmark/model";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createJevController, zoneMargin, resolveJevWeights } from "@/controllers/jev";
import type { JevClient } from "@/jev/client";
import {
  JEV_LIMITS,
  JEV_SCHEMA_VERSION,
  neutralJevPolicy,
  parseJevPolicy,
  type JevPolicy,
} from "@/jev/schema";
import { buildCityPartition } from "@/sim/regions";
import { createEngine, runEngine, type ScheduledSpawn } from "@/sim/engine";
import { productionDemand } from "@/sim/demand-profile";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";
import { buildChallengeResult } from "@/worker/challenge-result";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { buildPresentationMetrics } from "@/worker/presentation-snapshot";

const model = loadBenchmarkModel();
const TRIP_ID = "soldier-field-to-navy-pier" as CuratedTripId;
const partition = buildCityPartition(model.city);
const [SAMPLE_ROAD, SAMPLE_CORRIDORS] = [...partition.roadCorridors.entries()][0];
const SAMPLE_CORRIDOR = SAMPLE_CORRIDORS[0];
const SAMPLE_REGION = model.city.intersections[0].regionId;

/** A client that answers with whatever policy the test hands it. */
function scriptedClient(policy: Partial<JevPolicy>): JevClient {
  return {
    id: "mock",
    requestPolicy: () => ({
      schemaVersion: JEV_SCHEMA_VERSION,
      pressureScale: 1,
      hint: "neutral",
      corridorWeights: [],
      regionWeights: [],
      corridorIntents: [],
      regionIntents: [],
      ...policy,
    }),
  };
}

describe("zone intents: the surface stays bounded", () => {
  it("clamps strength into the declared band instead of accepting any number", () => {
    const parsed = parseJevPolicy(
      {
        schemaVersion: JEV_SCHEMA_VERSION,
        pressureScale: 1,
        hint: "neutral",
        corridorIntents: [
          { id: 3, intent: "drain", strength: 99 },
          { id: 4, intent: "meter", strength: 0.01 },
        ],
      },
      { corridorIds: [3, 4] },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.policy.corridorIntents).toEqual([
      { id: 3, intent: "drain", strength: JEV_LIMITS.INTENT_STRENGTH_MAX },
      { id: 4, intent: "meter", strength: JEV_LIMITS.INTENT_STRENGTH_MIN },
    ]);
  });

  it("refuses an intent the schema does not define, and a zone nobody asked about", () => {
    const bad = parseJevPolicy(
      {
        schemaVersion: JEV_SCHEMA_VERSION,
        corridorIntents: [{ id: 1, intent: "prioritize-the-ego-car", strength: 1 }],
      },
      { corridorIds: [1] },
    );
    expect(bad.ok).toBe(false);

    const unknown = parseJevPolicy(
      {
        schemaVersion: JEV_SCHEMA_VERSION,
        regionIntents: [{ id: 999, intent: "drain", strength: 1 }],
      },
      { regionIds: [1, 2] },
    );
    expect(unknown.ok).toBe(false);
  });

  it("treats a missing intent list as no intents at all", () => {
    const parsed = parseJevPolicy(
      { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1, hint: "neutral" },
      {},
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.policy.corridorIntents).toEqual([]);
    expect(parsed.value.policy.regionIntents).toEqual([]);
  });
});

describe("zone intents: one entry moves many intersections coherently", () => {
  const observation = (roads: number[]) => ({ roads }) as never;

  it("neutral leaves every signal's margin untouched", () => {
    const weights = resolveJevWeights(neutralJevPolicy());
    for (const intersection of model.city.intersections.slice(0, 25)) {
      expect(zoneMargin(intersection.id, observation([SAMPLE_ROAD]), partition, weights)).toBe(1);
    }
  });

  it("one corridor intent reaches every road serving that corridor, all the same way", () => {
    const parsed = parseJevPolicy(
      {
        schemaVersion: JEV_SCHEMA_VERSION,
        corridorIntents: [{ id: SAMPLE_CORRIDOR, intent: "meter", strength: 1.5 }],
      },
      { corridorIds: [SAMPLE_CORRIDOR] },
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const weights = resolveJevWeights(parsed.value.policy);
    const serving = [...partition.roadCorridors.entries()].filter(([, ids]) =>
      ids.includes(SAMPLE_CORRIDOR),
    );
    expect(serving.length).toBeGreaterThan(1);
    for (const [roadId] of serving) {
      const from = model.city.roads.find((road) => road.id === roadId);
      expect(from).toBeDefined();
      expect(
        zoneMargin(from!.from, observation([roadId]), partition, weights),
      ).toBeCloseTo(1.5, 5);
    }
  });

  it("clamps the product so no pile-up of intents can exceed the band", () => {
    const policy = parseJevPolicy(
      {
        schemaVersion: JEV_SCHEMA_VERSION,
        corridorIntents: [{ id: SAMPLE_CORRIDOR, intent: "meter", strength: 1.6 }],
        regionIntents: [{ id: SAMPLE_REGION, intent: "meter", strength: 1.6 }],
      },
      { corridorIds: [SAMPLE_CORRIDOR], regionIds: [SAMPLE_REGION] },
    );
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    const weights = resolveJevWeights(policy.value.policy);
    const road = model.city.roads.find((entry) => entry.id === SAMPLE_ROAD);
    expect(road).toBeDefined();
    if (road === undefined) return;
    const margin = zoneMargin(road.from, observation([SAMPLE_ROAD]), partition, weights);
    expect(margin).toBeLessThanOrEqual(JEV_LIMITS.INTENT_STRENGTH_MAX + 1e-9);
    // Both intents apply to a road inside the region, so the product is clamped
    // at the ceiling rather than multiplying past it.
    expect(margin).toBeCloseTo(JEV_LIMITS.INTENT_STRENGTH_MAX, 5);
  });
});

describe("zone intents: a citywide strategy Adaptive cannot express", () => {
  const HORIZON_MS = 240_000;

  /** Wraps a controller so the test can see what it actually decided. */
  function recording(controller: ReturnType<typeof createAdaptiveController>) {
    const decisions = new Map<number, string>();
    return {
      decisions,
      controller: {
        id: controller.id,
        directives: (city: never, traffic: never, context: never) => {
          const directives = controller.directives(city, traffic, context);
          for (const [id, directive] of directives) {
            decisions.set(id, `${decisions.get(id) ?? ""}|${directive}`);
          }
          return directives;
        },
      },
    };
  }

  function runWith(policy: Partial<JevPolicy> | null) {
    const challenge = materializeChallengeTrip(model, TRIP_ID, 7);
    const scenario = buildChallengeScenario({
      tripId: TRIP_ID,
      trafficLevel: "rush-hour",
      driver: "tourist",
      seed: 7,
      durationMs: HORIZON_MS,
    });
    const world = resolveScenarioWorld(model, challenge.trip, scenario);
    const spawns: ScheduledSpawn[] = [
      challenge.spawn,
      ...productionDemand({
        city: model.city,
        level: "rush-hour",
        seed: world.demandSeed,
        durationMs: HORIZON_MS,
      }),
    ];
    const base =
      policy === null
        ? createAdaptiveController()
        : createJevController({
            client: scriptedClient(policy),
            scenarioFingerprint: `intent-proof-${policy === null ? "adaptive" : "jev"}`,
          });
    const recorder = recording(base as ReturnType<typeof createAdaptiveController>);
    const engine = createEngine({
      city: model.city,
      controller: recorder.controller,
      spawns,
      driver: "tourist",
      incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
    });
    runEngine(engine, HORIZON_MS);
    const result = buildChallengeResult(engine, scenario, "adaptive", 0, false);
    return { result, decisions: recorder.decisions, metrics: buildPresentationMetrics(engine) };
  }

  it("diverges in real signal decisions and in the final result, without being tuned to win", () => {
    const adaptive = runWith(null);
    const neutral = runWith({});
    const active = runWith({
      regionIntents: [{ id: SAMPLE_REGION, intent: "meter", strength: 1.6 }],
      hint: "hold-longer",
    });

    // 1. Neutral is still exactly Adaptive — the ablation survives the extension.
    expect(neutral.result).toEqual(adaptive.result);
    expect(neutral.metrics).toEqual(adaptive.metrics);

    // 2. The active policy is NOT identical: the whole point of the extension.
    const adaptiveJson = JSON.stringify(adaptive.result);
    expect(JSON.stringify(active.result)).not.toBe(adaptiveJson);

    // 3. The divergence is citywide, not one lucky signal: one bounded entry
    //    moves decisions at many intersections, because that is what it means.
    let changed = 0;
    for (const [id, decision] of active.decisions) {
      if (adaptive.decisions.get(id) !== decision) {
        changed += 1;
      }
    }
    expect(changed).toBeGreaterThan(5);
  }, 300_000);
});
