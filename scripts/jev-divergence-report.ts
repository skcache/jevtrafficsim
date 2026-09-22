/**
 * Jev vs Adaptive: measured divergence on a stressed deterministic scenario.
 *
 * Reproduces, from the real engine, what the audit asks for: how often a live Jev
 * policy's signal decisions differ from Adaptive's, how many intersections that
 * touches, and whether the final ChallengeResult differs at all.
 *
 * Run: npx tsx scripts/jev-divergence-report.ts
 */
import { loadBenchmarkModel } from "@/benchmark/model";
import { createAdaptiveController } from "@/controllers/adaptive";
import { zoneMargin, createJevController, resolveJevWeights } from "@/controllers/jev";
import type { JevClient } from "@/jev/client";
import { neutralJevPolicy, parseJevPolicy, JEV_SCHEMA_VERSION, type JevPolicy } from "@/jev/schema";
import { buildCityPartition } from "@/sim/regions";
import { productionDemand } from "@/sim/demand-profile";
import { createEngine, runEngine, type ScheduledSpawn } from "@/sim/engine";
import { buildChallengeResult } from "@/worker/challenge-result";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import type { CuratedTripId } from "@/cities/chicago-trips";

const model = loadBenchmarkModel();
const partition = buildCityPartition(model.city);
const TRIP = "soldier-field-to-navy-pier" as CuratedTripId;
const HORIZON_MS = 600_000;

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

/** Records every directive a controller issues, per intersection. */
function recording(controller: {
  id: string;
  directives: (...args: unknown[]) => ReadonlyMap<number, unknown>;
}) {
  const log = new Map<number, string[]>();
  return {
    log,
    controller: {
      id: controller.id,
      directives: (city: never, traffic: never, context: never) => {
        const directives = controller.directives(city, traffic, context) as ReadonlyMap<number, unknown>;
        for (const [id, directive] of directives) {
          const list = log.get(id) ?? [];
          list.push(String(directive));
          log.set(id, list);
        }
        return directives;
      },
    },
  };
}

function run(policy: Partial<JevPolicy> | null) {
  const challenge = materializeChallengeTrip(model, TRIP, 7);
  const scenario = buildChallengeScenario({
    tripId: TRIP,
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
          scenarioFingerprint: "divergence-report",
        });
  const rec = recording(base as never);
  const engine = createEngine({
    city: model.city,
    controller: rec.controller as never,
    spawns,
    driver: "tourist",
    incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
  });
  runEngine(engine, HORIZON_MS);
  const result = buildChallengeResult(engine, scenario, "adaptive", 0, false);
  return { result, log: rec.log, tripTimeMs: result.trip.tripTimeMs, completed: result.trip.completed };
}

// A citywide strategy Adaptation cannot express: throttle a whole region.
const regionId = model.city.intersections[0].regionId;
const adaptive = run(null);
const neutral = run({});
const active = run({ regionIntents: [{ id: regionId, intent: "meter", strength: 1.6 }], hint: "hold-longer" });

let compared = 0;
let differing = 0;
let intersectionsDiffering = 0;
for (const [id, decisions] of active.log) {
  const other = adaptive.log.get(id) ?? [];
  const n = Math.min(decisions.length, other.length);
  let differs = false;
  for (let i = 0; i < n; i += 1) {
    compared += 1;
    if (decisions[i] !== other[i]) {
      differing += 1;
      differs = true;
    }
  }
  if (differs) intersectionsDiffering += 1;
}

console.log(`scenario          rush hour, ${TRIP}, 10 min, seed 7, production demand`);
console.log(`region intent     region ${regionId} meter 1.6 + hold-longer`);
console.log(`signal decisions  ${compared.toLocaleString()} compared, ${differing.toLocaleString()} differ (${((differing / compared) * 100).toFixed(1)}%)`);
console.log(`intersections     ${intersectionsDiffering} of ${adaptive.log.size} changed at least one decision`);
console.log(`neutral == adaptive      ${JSON.stringify(neutral.result) === JSON.stringify(adaptive.result) ? "EXACT" : "DIFFERS"}`);
console.log(`active  != adaptive      ${JSON.stringify(active.result) !== JSON.stringify(adaptive.result) ? "NON-IDENTICAL" : "identical"}`);
console.log(`trip times        adaptive ${(adaptive.tripTimeMs / 1000).toFixed(1)}s · jev ${(active.tripTimeMs / 1000).toFixed(1)}s · completed ${active.completed}`);
console.log(
  `zone margin check ${JSON.stringify(
    zoneMargin(
      model.city.intersections[0].id,
      { roads: [model.city.roads.find((road) => road.from === model.city.intersections[0].id)?.id ?? 0] } as never,
      partition,
      resolveJevWeights(
        (parseJevPolicy(
          {
            schemaVersion: JEV_SCHEMA_VERSION,
            regionIntents: [{ id: regionId, intent: "meter", strength: 1.6 }],
          },
          { regionIds: [regionId] },
        ) as { ok: true; value: { policy: JevPolicy } }).value.policy ?? neutralJevPolicy(),
      ),
    ),
  )}`,
);
