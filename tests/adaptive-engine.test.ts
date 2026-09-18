import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { DEFAULT_SIGNAL_TIMING } from "@/sim/config";
import { generateCity } from "@/sim/city-generator";
import { generateDemand } from "@/sim/demand";
import {
  createEngine,
  runEngine,
  stepEngine,
  takeSnapshot,
  type EngineState,
  type ScheduledSpawn,
} from "@/sim/engine";
import { validateSignalState } from "@/sim/signals";
import { checkTrafficInvariants } from "@/sim/traffic";
import type { City, Intersection, Road, TrafficLevel } from "@/sim/types";

/**
 * Signalized four-way crossroads used by the Adaptive integration tests:
 * center 0 at (100,100); arms east/north/west/south with approach roads
 * 0/2/4/6 and exit roads 1/3/5/7. Geometric fallback grouping pairs the
 * east-west approaches (group 0) and the north-south approaches (group 1).
 */
function crossroads(armLength: number, dominantExitLength?: number): City {
  const road = (id: number, from: number, to: number, length: number = armLength): Road => ({
    id,
    from,
    to,
    length,
    lanes: 1,
    speedLimit: 10,
    capacity: 4,
    kind: "local",
    closed: false,
  });
  const node = (id: number, x: number, y: number, control: "signal" | "uncontrolled"): Intersection => ({
    id,
    x,
    y,
    incoming: [],
    outgoing: [],
    control,
    regionId: 0,
  });
  const intersections: Intersection[] = [node(0, 100, 100, "signal")];
  const roads: Road[] = [];
  [0, 90, 180, 270].forEach((angleDeg, index) => {
    const radians = (angleDeg * Math.PI) / 180;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);
    const source = 1 + index * 2;
    const exit = 2 + index * 2;
    intersections.push(node(source, 100 - dx * armLength, 100 - dy * armLength, "uncontrolled"));
    intersections.push(node(exit, 100 + dx * armLength, 100 + dy * armLength, "uncontrolled"));
    roads.push(road(index * 2, source, 0));
    roads.push(road(index * 2 + 1, 0, exit, index === 0 ? dominantExitLength : armLength));
  });
  for (const r of roads) {
    intersections[r.from].outgoing.push(r.id);
    intersections[r.to].incoming.push(r.id);
  }
  return { size: "small", seed: 0, gridWidth: 2, gridHeight: 2, intersections, roads, corridors: [] };
}

function metricsOf(engine: EngineState) {
  return takeSnapshot(engine).metrics;
}

describe("adaptive end to end", () => {
  it("serves a starved minor approach within a bounded time under dominant demand", () => {
    // Adversarial asymmetry: the east approach (road 0) gets a car every
    // 400 ms (~18x the north approach's demand). The minor north approach
    // (road 2) must still be served: its CONTINUOUS queue wait may never run
    // away — the anti-starvation rule guarantees service within threshold +
    // a ring walk, and a weak score bonus would let it grow for the whole run.
    const city = crossroads(40);
    const spawns: ScheduledSpawn[] = [];
    for (let t = 0; t < 110_000; t += 400) {
      spawns.push({ timeMs: t, type: "car", origin: 1, destination: 2 }); // dominant: east
    }
    for (let t = 0; t < 110_000; t += 3_000) {
      spawns.push({ timeMs: t, type: "car", origin: 3, destination: 4 }); // minor: north
    }
    const engine = createEngine({ city, controller: createAdaptiveController(), spawns });

    let minorGreenStarts = 0;
    let previousPhase = -1;
    while (engine.traffic.timeMs < 140_000) {
      stepEngine(engine);
      const signal = engine.traffic.signals.get(0);
      if (signal && signal.stage === "green" && signal.phaseIndex === 1 && previousPhase !== 1) {
        minorGreenStarts += 1;
      }
      if (signal) {
        previousPhase = signal.stage === "green" ? signal.phaseIndex : previousPhase;
      }
      if (engine.ticks % 100 === 0) {
        expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
        for (const [, s] of engine.traffic.signals) {
          expect(validateSignalState(s)).toEqual([]);
        }
      }
    }

    // Bounded starvation: threshold 35 s + clearance + walk overhead < 45 s.
    const minorPeakWait = engine.approaches.peakWaitMs.get(2) ?? 0;
    expect(minorPeakWait).toBeGreaterThan(0); // the fixture does queue this approach
    expect(minorPeakWait).toBeLessThan(45_000);
    // The minor phase was actually served several times, not once by luck.
    expect(minorGreenStarts).toBeGreaterThanOrEqual(3);
    // Every minor vehicle completed within the run.
    const minorVehicles = engine.traffic.vehicles.filter((vehicle) => vehicle.origin === 3);
    expect(minorVehicles.length).toBeGreaterThan(30);
    for (const vehicle of minorVehicles) {
      expect(vehicle.state).toBe("arrived");
    }
    expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
  }, 300_000);

  it("crosses the starvation threshold only inside the guaranteed bound", () => {
    // Hard-rule territory: three parked cars pin the dominant phase's exit
    // road at 3.0 of 4 units, so the dominant movement can NEVER discharge —
    // its pressure never dips and the minor phase would wait forever under a
    // weak score bonus. The minor approach's continuous wait therefore crosses
    // the 35 s threshold, which must trigger the anti-starvation rule: the
    // ring advances to it as soon as min green permits, and it is served
    // within threshold + clearance.
    const city = crossroads(40, 2000);
    const spawns: ScheduledSpawn[] = [];
    for (let i = 0; i < 3; i += 1) {
      spawns.push({ timeMs: 0, type: "car", origin: 0, destination: 2 }); // park on exit road 1
    }
    for (let t = 0; t < 110_000; t += 500) {
      spawns.push({ timeMs: t, type: "car", origin: 1, destination: 2 }); // dominant east
    }
    for (let t = 0; t < 110_000; t += 3_000) {
      spawns.push({ timeMs: t, type: "car", origin: 3, destination: 4 }); // minor north
    }
    const engine = createEngine({ city, controller: createAdaptiveController(), spawns });

    let eligibleAt: number | null = null;
    let servedAt: number | null = null;
    let minorGreenStarts = 0;
    let previousPhase = -1;
    // Long enough that the last minor vehicle (spawned at 108 s, served in the
    // ~225 s service round) has crossed and finished.
    while (engine.traffic.timeMs < 240_000) {
      stepEngine(engine);
      const signal = engine.traffic.signals.get(0);
      if (!signal) {
        continue;
      }
      if (signal.stage === "green" && signal.phaseIndex === 1 && previousPhase !== 1) {
        minorGreenStarts += 1;
      }
      if (signal.stage === "green") {
        previousPhase = signal.phaseIndex;
      }
      if (eligibleAt === null && (engine.approaches.current.get(2)?.maxWaitMs ?? 0) >= 35_000) {
        eligibleAt = engine.traffic.timeMs;
      }
      if (eligibleAt !== null && servedAt === null && signal.stage === "green" && signal.phaseIndex === 1) {
        servedAt = engine.traffic.timeMs;
      }
      if (engine.ticks % 100 === 0) {
        expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
        for (const [, s] of engine.traffic.signals) {
          expect(validateSignalState(s)).toEqual([]);
        }
      }
    }

    // The fixture genuinely drives the minor approach into starvation...
    expect(eligibleAt).not.toBeNull();
    // ...and the rule serves it within threshold + clearance stage (≤ 5 s here).
    expect(servedAt).not.toBeNull();
    expect((servedAt ?? 0) - (eligibleAt ?? 0)).toBeLessThanOrEqual(5_000);
    // Peak continuous wait stays inside the guarantee: threshold + clearance.
    expect(engine.approaches.peakWaitMs.get(2) ?? 0).toBeLessThan(45_000);
    expect(minorGreenStarts).toBeGreaterThanOrEqual(2);
    // Everything the minor approach carried completed.
    for (const vehicle of engine.traffic.vehicles.filter((v) => v.origin === 3)) {
      expect(vehicle.state).toBe("arrived");
    }
    expect(checkTrafficInvariants(city, engine.traffic)).toEqual([]);
  }, 300_000);

  it("beats Fixed decisively on a workload designed for adaptive control", () => {
    // One dominant heavy axis (westbound) plus a light north-south trickle:
    // Fixed burns half its cycle on the near-empty cross phase, Adaptive keeps
    // serving the heavy queue while it persists. Same city + same schedule.
    const city = crossroads(40);
    const spawns: ScheduledSpawn[] = [];
    for (let t = 0; t < 135_000; t += 1_500) {
      spawns.push({ timeMs: t, type: "car", origin: 7, destination: 8 }); // heavy westbound (road 6 -> 7)
    }
    for (let t = 0; t < 135_000; t += 7_500) {
      spawns.push({ timeMs: t, type: "car", origin: 3, destination: 4 }); // light north-south
    }

    const fixedEngine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(fixedEngine, 240_000);
    const adaptiveEngine = createEngine({ city, controller: createAdaptiveController(), spawns });
    runEngine(adaptiveEngine, 240_000);

    const fixed = metricsOf(fixedEngine);
    const adaptive = metricsOf(adaptiveEngine);

    // Adaptive moves the same demand with materially less waiting.
    expect(adaptive.averageWaitTimeMs).toBeLessThan(fixed.averageWaitTimeMs * 0.75);
    expect(adaptive.p95WaitTimeMs).toBeLessThan(fixed.p95WaitTimeMs);
    expect(adaptive.maxWaitTimeMs).toBeLessThan(fixed.maxWaitTimeMs * 0.75);
    // It does not achieve that by starving the workload it ignores.
    expect(adaptive.maxApproachWaitMs).toBeLessThan(fixed.maxApproachWaitMs);
    // Throughput is at least as good.
    expect(adaptive.completedTrips).toBeGreaterThanOrEqual(fixed.completedTrips * 0.9);
    // Both runs are legal.
    expect(checkTrafficInvariants(city, fixedEngine.traffic)).toEqual([]);
    expect(checkTrafficInvariants(city, adaptiveEngine.traffic)).toEqual([]);
  }, 300_000);

  it("is deterministic, legal and competitive on the generated workload", () => {
    const city = generateCity("medium", 42);
    const spawns = generateDemand({ city, level: "rush-hour" as TrafficLevel, seed: 42, durationMs: 300_000 });

    const fixedEngine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(fixedEngine, 300_000);

    const adaptiveEngine = createEngine({ city, controller: createAdaptiveController(), spawns });
    let maxGreenSeen = 0;
    while (adaptiveEngine.traffic.timeMs < 300_000) {
      stepEngine(adaptiveEngine);
      if (adaptiveEngine.ticks % 25 === 0) {
        for (const [, s] of adaptiveEngine.traffic.signals) {
          expect(validateSignalState(s)).toEqual([]);
          // Mechanics bound: a green can never outlive max green unseen.
          if (s.stage === "green") {
            maxGreenSeen = Math.max(maxGreenSeen, s.stageElapsedMs);
          }
        }
        expect(checkTrafficInvariants(city, adaptiveEngine.traffic)).toEqual([]);
      }
    }
    expect(maxGreenSeen).toBeLessThanOrEqual(DEFAULT_SIGNAL_TIMING.maxGreenMs + 100);

    // Same inputs, same outputs: a second Adaptive run is byte-identical.
    const replay = createEngine({ city, controller: createAdaptiveController(), spawns });
    runEngine(replay, 300_000);
    expect(JSON.stringify(takeSnapshot(replay))).toBe(JSON.stringify(takeSnapshot(adaptiveEngine)));

    const fixed = metricsOf(fixedEngine);
    const adaptive = metricsOf(adaptiveEngine);

    // Meaningfully different behavior on identical demand.
    expect(JSON.stringify(takeSnapshot(adaptiveEngine))).not.toBe(JSON.stringify(takeSnapshot(fixedEngine)));

    // Sane, finite metrics; no catastrophic regression (this is a guard, not
    // a requirement that Adaptive wins every metric).
    for (const [key, value] of Object.entries(adaptive)) {
      if (typeof value === "number") {
        expect(Number.isFinite(value), `${key} finite`).toBe(true);
      }
    }
    expect(adaptive.completedTrips).toBeGreaterThan(0);
    expect(adaptive.completedTrips).toBeGreaterThanOrEqual(fixed.completedTrips * 0.75);
    expect(adaptive.maxApproachWaitMs).toBeLessThanOrEqual(fixed.maxApproachWaitMs * 1.5);
    expect(checkTrafficInvariants(city, adaptiveEngine.traffic)).toEqual([]);
    expect(checkTrafficInvariants(city, fixedEngine.traffic)).toEqual([]);
  }, 300_000);
});
