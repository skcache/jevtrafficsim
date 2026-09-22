import { createAdaptiveController } from "@/controllers/adaptive";
import { loadBenchmarkModel } from "@/benchmark/model";
import { productionDemand } from "@/sim/demand-profile";
import { createEngine, runEngine, type ScheduledSpawn } from "@/sim/engine";
import { buildChallengeResult } from "@/worker/challenge-result";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { buildPresentationMetrics } from "@/worker/presentation-snapshot";

const model = loadBenchmarkModel();
const challenge = materializeChallengeTrip(model, "soldier-field-to-navy-pier", 42);
const scenario = buildChallengeScenario({
  tripId: "soldier-field-to-navy-pier",
  trafficLevel: "everyday",
  driver: "tourist",
  seed: 42,
  durationMs: 600_000,
});
const world = resolveScenarioWorld(model, challenge.trip, scenario);
const spawns: ScheduledSpawn[] = [
  challenge.spawn,
  ...productionDemand({ city: model.city, level: "everyday", seed: world.demandSeed, durationMs: 600_000 }),
];
const engine = createEngine({
  city: model.city,
  controller: createAdaptiveController(),
  spawns,
  driver: "tourist",
  incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
});
runEngine(engine, 600_000);
const result = buildChallengeResult(engine, scenario, "adaptive", 0, false);
console.log("built result at sim", Math.round(engine.traffic.timeMs), "active", engine.traffic.activeVehicles.size);
try {
  const cloned = structuredClone(result);
  console.log("structuredClone(result): OK", Object.keys(cloned).length, "keys");
} catch (error) {
  console.log("structuredClone(result) THREW:", String(error).slice(0, 200));
}
try {
  const metrics = structuredClone(buildPresentationMetrics(engine));
  console.log("structuredClone(metrics): OK", Object.keys(metrics).length, "keys");
} catch (error) {
  console.log("structuredClone(metrics) THREW:", String(error).slice(0, 200));
}
