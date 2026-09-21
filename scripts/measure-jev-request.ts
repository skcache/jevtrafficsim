/**
 * Size the Jev relay's body ceiling from evidence (Issue #37).
 *
 *   npx tsx scripts/measure-jev-request.ts
 *
 * Prints what production code actually generates for a busy Metro rush hour
 * (the generator caps corridors/regions/hotspots itself) and the worst case the
 * strict schema admits: every list at its limit with numbers at the top of their
 * guards. `JEV_LIMITS.REQUEST_BODY_BYTES` must fit the second with headroom, and
 * the route refuses anything larger before touching the model.
 *
 * Measured 2026-09-21: 18.3 KB generated, 23.6 KB worst case, 64 KB ceiling.
 */
import { createAdaptiveController } from "@/controllers/adaptive";
import { buildCityPartition } from "@/sim/regions";
import { buildObservationFrame } from "@/sim/observations";
import { createEngine, runEngine } from "@/sim/engine";
import { generateDemand } from "@/sim/demand";
import { buildJevPolicyRequest } from "@/jev/request";
import { JEV_LIMITS, JEV_SCHEMA_VERSION } from "@/jev/schema";
import { loadBenchmarkModel } from "@/benchmark/model";

function main(): void {
  const model = loadBenchmarkModel();
  console.log("city:", model.city.roads.length, "roads,", model.city.intersections.length, "intersections");

  for (const level of ["everyday", "rush-hour"] as const) {
    for (const horizonMs of [600_000, 1_800_000]) {
      const engine = createEngine({
        city: model.city,
        controller: createAdaptiveController(),
        spawns: generateDemand({ city: model.city, level, seed: 42, durationMs: horizonMs }),
      });
      // Run well past the peak so the city is genuinely loaded.
      runEngine(engine, horizonMs);

      const frame = buildObservationFrame(engine.city, engine.traffic, engine.arrivals);
      const partition = buildCityPartition(engine.city);
      const request = buildJevPolicyRequest({
        frame,
        partition,
        intersections: engine.city.intersections.length,
        activeVehicles: engine.traffic.vehicles.length,
      });
      const json = JSON.stringify(request);
      console.log(
        `${level.padEnd(9)} horizon ${String(horizonMs / 1000).padStart(5)}s | ` +
          `vehicles ${String(engine.traffic.vehicles.length).padStart(5)} | ` +
          `corridors ${String(request.corridors.length).padStart(3)}/${JEV_LIMITS.REQUEST_CORRIDORS} ` +
          `regions ${String(request.regions.length).padStart(3)}/${JEV_LIMITS.REQUEST_REGIONS} ` +
          `hotspots ${String(request.hotspots.length).padStart(3)}/${JEV_LIMITS.REQUEST_HOTSPOTS} | ` +
          `JSON ${JSON.stringify(request).length} bytes (${(json.length / 1024).toFixed(1)} KB)`,
      );
    }
  }

  // Worst case the schema admits: every list at its limit, numbers at the top of
  // their absurdity guards. This is what the body ceiling must fit.
  const entry = {
    intersections: 12,
    queuedVehicles: 480,
    maxWaitMs: 86_399_999,
    arrivalRatePerSecond: 999.999,
    occupancyRatio: 0.999,
  };
  const worst = {
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: 86_399_999,
    windowMs: 60_000,
    city: {
      intersections: 999_999,
      signalizedIntersections: 999_999,
      activeVehicles: 999_999,
      queuedVehicles: 999_999,
      maxWaitMs: 86_399_999,
      arrivalRatePerSecond: 999_999,
    },
    corridors: Array.from({ length: JEV_LIMITS.REQUEST_CORRIDORS }, (_, index) => ({
      corridorId: 999_000 + index,
      kind: "arterial",
      ...entry,
    })),
    regions: Array.from({ length: JEV_LIMITS.REQUEST_REGIONS }, (_, index) => ({
      regionId: 999_000 + index,
      signalizedIntersections: 12,
      ...entry,
    })),
    hotspots: Array.from({ length: JEV_LIMITS.REQUEST_HOTSPOTS }, (_, index) => ({
      intersectionId: 999_000 + index,
      regionId: 999_000 + index,
      stage: "yellow",
      phaseIndex: 63,
      phaseCount: 64,
      stageElapsedMs: 86_399_999,
      queuedVehicles: 480,
      maxWaitMs: 86_399_999,
      arrivalRatePerSecond: 999.999,
      occupancyRatio: 0.999,
      downstreamOccupancyRatio: 0.999,
    })),
  };
  const worstJson = JSON.stringify(worst);
  console.log(
    `worst-case legal request: ${worstJson.length} bytes (${(worstJson.length / 1024).toFixed(1)} KB)`,
  );
  console.log(`body ceiling: ${JEV_LIMITS.REQUEST_BODY_BYTES} bytes (${JEV_LIMITS.REQUEST_BODY_BYTES / 1024} KB)`);
}

main();
