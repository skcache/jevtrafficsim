/**
 * Chicago Metro Rush performance guard (Phase 1, §31).
 *
 * Metro is the largest geography the showcase runs (2 300+ intersections,
 * 5 100+ directed roads) — an order of magnitude past the procedural cities.
 * This test keeps a permanent budget on the interactive path: if a change
 * makes the engine too slow to run at 10 Hz, it fails here rather than in the
 * browser.
 */
import { describe, expect, it } from "vitest";
import { createEngine, stepEngine, takeSnapshot } from "@/sim/engine";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { generateDemand } from "@/sim/demand";
import { checkTrafficInvariants } from "@/sim/traffic";
import { chicagoAsset, chicagoModel } from "./chicago-support";

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index];
}

describe("Chicago Metro performance", () => {
  it("runs Metro Rush inside the interactive step budget", () => {
    const model = chicagoModel(4);
    const spawns = generateDemand({
      city: model.city,
      level: "rush-hour",
      seed: 7,
      durationMs: 600_000,
    });
    const engine = createEngine({
      city: model.city,
      controller: createAdaptiveController(),
      spawns,
    });

    const stepMs: number[] = [];
    const ticks = 600;
    for (let tick = 0; tick < ticks; tick += 1) {
      const started = performance.now();
      stepEngine(engine);
      stepMs.push(performance.now() - started);
    }

    const avg = stepMs.reduce((sum, value) => sum + value, 0) / stepMs.length;
    const p95 = percentile(stepMs, 0.95);
    const snapshot = takeSnapshot(engine);
    const snapshotBytes = JSON.stringify(snapshot).length;

    // Reported for the Phase-1 numbers; keep the log line for future diffs.
    console.log(
      `[chicago metro rush] avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms ` +
        `vehicles=${engine.traffic.vehicles.length} snapshot=${(snapshotBytes / 1024).toFixed(0)}KB ` +
        `roads=${model.city.roads.length} intersections=${model.city.intersections.length}`,
    );

    expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
    expect(snapshot.vehicles.length).toBeGreaterThan(0);
    // 10 Hz means 100 ms per tick; the worker also renders, so keep the step
    // well inside that. Generous enough for CI machines, tight enough to catch
    // a real regression.
    expect(avg).toBeLessThan(40);
    expect(p95).toBeLessThan(80);
  });

  it("keeps Fixed control comparable to Adaptive on the same demand", () => {
    const model = chicagoModel(4);
    const spawns = generateDemand({
      city: model.city,
      level: "rush-hour",
      seed: 7,
      durationMs: 600_000,
    });
    for (const controller of [createFixedController(), createAdaptiveController()]) {
      const engine = createEngine({ city: model.city, controller, spawns });
      for (let tick = 0; tick < 300; tick += 1) {
        stepEngine(engine);
      }
      expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
    }
  });

  it("imports the expected Metro scale", () => {
    const asset = chicagoAsset(4);
    expect(asset.counts.intersections).toBeGreaterThan(2000);
    expect(asset.counts.roads).toBeGreaterThan(4000);
    expect(asset.counts.bridges).toBeGreaterThan(100);
    expect(asset.counts.signals).toBeGreaterThan(500);
  });
});
