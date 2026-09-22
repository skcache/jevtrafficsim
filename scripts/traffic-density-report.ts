/**
 * How busy does the LIVE VIEW actually look?
 *
 * The screenshot test failed this: thousands of active vehicles citywide, but the
 * follow view showed a couple of dozen sprites. This measures the two things that
 * decide the visual answer:
 *
 *   - vehicles inside the follow viewport (zoom 15.4 at 1440x900 is ~3.9 x 2.4 km)
 *   - how many roads the congestion overlay paints, by severity
 *
 * Run: npx tsx scripts/traffic-density-report.ts --level rush-hour
 */
import { createAdaptiveController } from "@/controllers/adaptive";
import { loadBenchmarkModel } from "@/benchmark/model";
import { productionDemand } from "@/sim/demand-profile";
import { createEngine, runEngine, type ScheduledSpawn } from "@/sim/engine";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { roadPressure } from "@/render/congestion";
import { buildDirectedPathIndexes, sampleDirectedRoad } from "@/render/map-geometry";
import type { CuratedTripId } from "@/cities/chicago-trips";
import type { TrafficLevel } from "@/sim/types";

const model = loadBenchmarkModel();
const indexes = buildDirectedPathIndexes(model);
const TRIP = "soldier-field-to-navy-pier" as CuratedTripId;
const HORIZON_MS = 600_000;
/** Viewport half-extents at zoom 15.4 on a 1440x900 window (lat 41.88). */
const HALF_W_M = 1950;
const HALF_H_M = 1210;

function measure(level: TrafficLevel) {
  const challenge = materializeChallengeTrip(model, TRIP, 42);
  const scenario = buildChallengeScenario({
    tripId: TRIP,
    trafficLevel: level,
    driver: "tourist",
    seed: 42,
    durationMs: HORIZON_MS,
  });
  const world = resolveScenarioWorld(model, challenge.trip, scenario);
  const spawns: ScheduledSpawn[] = [
    challenge.spawn,
    ...productionDemand({ city: model.city, level, seed: world.demandSeed, durationMs: HORIZON_MS }),
  ];
  const engine = createEngine({
    city: model.city,
    controller: createAdaptiveController(),
    spawns,
    driver: "tourist",
    incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
  });

  console.log(`\n=== ${level} (production profile) ===`);
  for (const mark of [60_000, 180_000, 300_000, 420_000]) {
    runEngine(engine, mark);
    // The followed car: the frame names it (never by position in a list).
    const frame = buildPresentationSnapshot(engine, 0);
    const heroId = frame.ego?.id ?? null;
    const hero = [...engine.traffic.activeVehicles].find((vehicle) => vehicle.id === heroId);
    let heroX = 0;
    let heroY = 0;
    if (hero && hero.roadId !== null) {
      const sample = sampleDirectedRoad(indexes, hero.roadId, hero.progress);
      if (sample) {
        heroX = sample.x;
        heroY = sample.y;
      }
    }
    let inView = 0;
    let within1km = 0;
    let within2km = 0;
    let within5km = 0;
    for (const vehicle of engine.traffic.activeVehicles) {
      if (vehicle.roadId === null || vehicle.state === "pending") {
        continue;
      }
      const sample = sampleDirectedRoad(indexes, vehicle.roadId, vehicle.progress);
      if (!sample) {
        continue;
      }
      const dx = sample.x - heroX;
      const dy = sample.y - heroY;
      const distance = Math.hypot(dx, dy);
      if (Math.abs(dx) <= HALF_W_M && Math.abs(dy) <= HALF_H_M) inView += 1;
      if (distance <= 1000) within1km += 1;
      if (distance <= 2000) within2km += 1;
      if (distance <= 5000) within5km += 1;
    }
    const pressure = roadPressure(frame);
    const byLevel = { warm: 0, bad: 0, severe: 0 };
    for (const entry of pressure) {
      byLevel[entry.level] += 1;
    }
    console.log(
      `t=${mark / 1000}s  active=${engine.traffic.activeVehicles.size}` +
        `  inView=${inView}  ≤1km=${within1km}  ≤2km=${within2km}  ≤5km=${within5km}` +
        `  painted roads=${pressure.length} (warm ${byLevel.warm} / bad ${byLevel.bad} / severe ${byLevel.severe})`,
    );
  }
}

const level = process.argv.includes("--level")
  ? (process.argv[process.argv.indexOf("--level") + 1] as TrafficLevel)
  : "rush-hour";
measure(level);
