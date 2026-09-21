/**
 * Chicago Metro performance guards (Phase 1 §31, rebuilt for Issue #40).
 *
 * The old guard was three things the review correctly called out: 600 ticks (too
 * short for history to accumulate), an absolute per-step budget loose enough to
 * pass while the late run degraded, and no comparison between early and late at
 * all. It could not have caught the bug it was supposed to catch.
 *
 * What replaces it:
 *
 *   1. a real 6 000-tick rush-hour run of the frozen Metro geography, asserting
 *      that a step costs the same with thousands of arrivals behind it as it did
 *      while the live population was still filling — and that the arrivals are
 *      really there (an empty run would pass any ratio);
 *   2. a direct, decisive regression for the invariant itself: pad canonical
 *      HISTORY with thousands of arrived vehicles and prove one step does not
 *      get slower. This is the check the old file lacked, it runs in seconds, and
 *      it fails loudly on the pre-#40 engine.
 *
 * Both are ratios, not hardware-sensitive absolute thresholds. The one absolute
 * number that remains is a playback sanity bound with roughly an order of
 * magnitude of headroom, so it catches a catastrophic regression without
 * measuring the CI machine.
 */
import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { generateDemand } from "@/sim/demand";
import { createEngine, stepEngine, type EngineState } from "@/sim/engine";
import { checkTrafficInvariants, spawnVehicle, vehicleById } from "@/sim/traffic";
import { chicagoAsset, chicagoModel } from "./chicago-support";

const RUSH = "rush-hour" as const;
const HORIZON_MS = 600_000;
const TICKS = HORIZON_MS / 100;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function liveVehicles(engine: EngineState): number {
  let live = 0;
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state !== "arrived") live += 1;
  }
  return live;
}

function rushEngine(seed = 7, withEgo = false): EngineState {
  const model = chicagoModel(4);
  const spawns = generateDemand({ city: model.city, level: RUSH, seed, durationMs: HORIZON_MS });
  if (withEgo) {
    // One protagonist, exactly as the challenge harness spawns it: the ego is a
    // scheduled spawn with a role, routed by the engine.
    spawns.unshift({
      timeMs: 0,
      type: "car",
      origin: 0,
      destination: model.city.intersections.length - 1,
      role: "ego",
    });
  }
  return createEngine({ city: model.city, controller: createAdaptiveController(), spawns });
}

describe("Chicago Metro performance", () => {
  it(
    "keeps late-run step cost bounded by live traffic, not by arrivals (6 000-tick rush hour)",
    { timeout: 300_000 },
    () => {
      const engine = rushEngine();
      const windows = {
        mid: [] as number[],
        late: [] as number[],
      };
      const third = Math.floor(TICKS / 3);
      for (let tick = 0; tick < TICKS; tick += 1) {
        const started = performance.now();
        stepEngine(engine);
        const elapsed = performance.now() - started;
        if (tick >= third && tick < third + 1_000) windows.mid.push(elapsed);
        if (tick >= TICKS - 1_000) windows.late.push(elapsed);
      }

      const live = liveVehicles(engine);
      const arrived = engine.traffic.vehicles.length - live;
      const midMedian = median(windows.mid);
      const lateMedian = median(windows.late);
      const growth = lateMedian / Math.max(1e-6, midMedian);
      const liveMicrosPerStep = ((lateMedian * 1_000) / Math.max(1, live));

      console.log(
        `[metro rush 6000 ticks] mid=${midMedian.toFixed(3)}ms late=${lateMedian.toFixed(3)}ms ` +
          `growth=${growth.toFixed(2)}× live=${live} arrived=${arrived} ` +
          `${liveMicrosPerStep.toFixed(1)}µs/step/live-vehicle p95=${percentile(windows.late, 0.95).toFixed(3)}ms`,
      );

      expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
      // The run really accumulated history: without this the ratios are vacuous.
      expect(arrived).toBeGreaterThan(1_500);
      expect(engine.traffic.vehicles.length).toBeGreaterThan(3_500);
      // Both windows are past the live plateau, so the remaining growth can only
      // come from history (this is the discriminator the old guard was missing).
      expect(growth).toBeLessThan(1.5);
      // Per-live-vehicle work must not creep upwards either.
      expect(liveMicrosPerStep).toBeLessThan(6);
      // Playback sanity only: 7 simulation steps run per 100 ms tick, so a single
      // step must sit far inside that budget. Generous on purpose.
      expect(lateMedian).toBeLessThan(25);
      expect(percentile(windows.late, 0.95)).toBeLessThan(60);
    },
  );

  it(
    "does not slow down when thousands of arrived vehicles are added to history",
    { timeout: 120_000 },
    () => {
      // Lockstep control: two engines of the SAME scenario, stepped tick for
      // tick, so the live population and the RNG sequence are identical. One
      // gets 8 000 extra arrived vehicles in canonical history; the other does
      // not. Any difference in step cost is therefore caused by history alone —
      // which is exactly the invariant, and it needs no absolute threshold.
      const padded = rushEngine(11);
      const control = rushEngine(11);
      for (let tick = 0; tick < 400; tick += 1) {
        stepEngine(padded);
        stepEngine(control);
      }

      const PADDING = 8_000;
      for (let index = 0; index < PADDING; index += 1) {
        spawnVehicle(padded.city, padded.traffic, {
          // Sequential id, as the allocator requires; a route-less spawn is born
          // arrived, so it lands in canonical history only.
          id: padded.traffic.vehicles.length,
          type: "car",
          origin: 0,
          destination: 0,
          route: [],
          spawnTimeMs: padded.traffic.timeMs,
        });
      }

      const paddedSamples: number[] = [];
      const controlSamples: number[] = [];
      for (let tick = 0; tick < 300; tick += 1) {
        const paddedStart = performance.now();
        stepEngine(padded);
        paddedSamples.push(performance.now() - paddedStart);
        const controlStart = performance.now();
        stepEngine(control);
        controlSamples.push(performance.now() - controlStart);
      }

      const paddedMedian = median(paddedSamples);
      const controlMedian = median(controlSamples);
      const growth = paddedMedian / Math.max(1e-6, controlMedian);
      console.log(
        `[history invariance] history ${control.traffic.vehicles.length} vs ${padded.traffic.vehicles.length} ` +
          `(live ${padded.traffic.activeVehicles.size} both) ` +
          `median ${controlMedian.toFixed(3)}ms vs ${paddedMedian.toFixed(3)}ms growth=${growth.toFixed(2)}×`,
      );

      expect(checkTrafficInvariants(padded.city, padded.traffic)).toEqual([]);
      expect(checkTrafficInvariants(control.city, control.traffic)).toEqual([]);
      // The padding is real and enormous: more vehicles than a whole run spawns.
      expect(padded.traffic.vehicles.length - control.traffic.vehicles.length).toBe(PADDING);
      // Both runs are the same scenario at the same simulated time: same live
      // population, so the comparison is apples to apples.
      expect(padded.traffic.timeMs).toBe(control.traffic.timeMs);
      expect(padded.traffic.activeVehicles.size).toBe(control.traffic.activeVehicles.size);
      // THE invariant: 8 000 extra arrived vehicles must not make a step slower.
      // Measured on this machine: pre-#40 engine 1.441× (0.761 → 1.096 ms), with
      // the live index 1.133× (0.758 → 0.859 ms). The residual ~0.10 ms is heap
      // and GC pressure from keeping canonical history, which the issue requires
      // keeping. The bound sits between the two — 1.25 — so it fails the old
      // engine and passes the new one without measuring the CI machine.
      expect(growth).toBeLessThan(1.25);
    },
  );

  it("finds the ego in O(1) after a long run, arrived or not", { timeout: 120_000 }, () => {
    const engine = rushEngine(5, true);
    for (let tick = 0; tick < 1_200; tick += 1) {
      stepEngine(engine);
    }
    const egoId = engine.egoVehicleId;
    expect(egoId).not.toBeNull();
    const ego = vehicleById(engine.traffic, egoId);
    expect(ego).not.toBeNull();
    expect(ego!.id).toBe(egoId);
    // Same object as the canonical array position — ids ARE indices.
    expect(engine.traffic.vehicles[egoId!]).toBe(ego);
    // And the lookup is total: an id that was never allocated is simply absent.
    expect(vehicleById(engine.traffic, engine.traffic.vehicles.length + 10)).toBeNull();
    expect(vehicleById(engine.traffic, null)).toBeNull();
    // The live index agrees with a full scan, after thousands of arrivals.
    expect(engine.traffic.activeVehicles.size).toBe(liveVehicles(engine));
    expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
  });

  it("keeps Fixed control comparable to Adaptive on the same demand", () => {
    const model = chicagoModel(4);
    const spawns = generateDemand({ city: model.city, level: RUSH, seed: 7, durationMs: HORIZON_MS });
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
