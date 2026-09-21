/**
 * Ablation: a NEUTRAL Jev policy must be Adaptive (issue: "Jev neutral policy
 * MUST equal Adaptive").
 *
 * Two claims, both pinned here:
 *
 *   1. Mechanically, `hold` and "no opinion" are the same instruction. `stepSignal`
 *      switches when the directive is `advance` (with min green elapsed) or when
 *      max green forces it — an explicit `hold` only ever means the second case.
 *      So the two controllers' directive MAPS may differ in wording while the
 *      world they produce is identical, and the world is the comparison that
 *      matters.
 *   2. Therefore a neutral policy puts Jev in exactly Adaptive's world: same
 *      signal evolution, same vehicles, same arrivals, same everything.
 *
 * If a future policy addition breaks either claim, this file fails first — which
 * is the point: differentiation must come from information the policy carries,
 * never from Jev quietly doing something else.
 */
import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createJevController } from "@/controllers/jev";
import { createMockJevClient } from "@/jev/client";
import { neutralJevPolicy } from "@/jev/schema";
import { createEngine, stepEngine, type EngineState, type ScheduledSpawn } from "@/sim/engine";
import { buildObservationFrame, createApproachArrivalTracker } from "@/sim/observations";
import { stepSignal, type SignalDirective, type SignalState } from "@/sim/signals";
import { chicagoModel } from "./chicago-support";

/** "No opinion" and "hold" as one instruction; only "advance" is different. */
function instruction(directive: SignalDirective | undefined): "hold" | "advance" {
  return directive === "advance" ? "advance" : "hold";
}

/** Everything a signal's future depends on, and everything the world shows. */
function worldDigest(engine: EngineState): string {
  return JSON.stringify({
    timeMs: engine.traffic.timeMs,
    vehicles: engine.traffic.vehicles.map((vehicle) => [
      vehicle.id,
      vehicle.state,
      vehicle.roadId,
      Number(vehicle.progress.toFixed(4)),
      Math.round(vehicle.waitTimeMs),
      vehicle.routeIndex,
    ]),
    signals: [...engine.traffic.signals.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([id, signal]) => [
        id,
        signal.phaseIndex,
        signal.stage,
        Math.round(signal.stageElapsedMs),
      ]),
    arrivals: engine.metrics.arrivals.length,
  });
}

describe("signal mechanics: hold and no-opinion are the same instruction", () => {
  it("evolves a signal identically for undefined and hold, and differently for advance", () => {
    const model = chicagoModel(1);
    const trace = (directive: SignalDirective | undefined): string => {
      const engine = createEngine({
        city: model.city,
        controller: createAdaptiveController(),
        spawns: [],
      });
      // Signal states exist once the engine has stepped (they are created from
      // the city's control rules on the first movement tick).
      stepEngine(engine);
      // Any multi-group signal: the ones directives can actually speak to.
      const signal = [...engine.traffic.signals.values()].find(
        (candidate) => candidate.groups.length >= 2,
      );
      expect(signal).toBeDefined();
      const steps: string[] = [];
      for (let tick = 0; tick < 500; tick += 1) {
        stepSignal(signal as SignalState, 100, directive);
        steps.push(`${signal!.phaseIndex}:${signal!.stage}:${Math.round(signal!.stageElapsedMs)}`);
      }
      return steps.join("|");
    };

    const none = trace(undefined);
    expect(trace("hold")).toBe(none);
    expect(trace("advance")).not.toBe(none);
  });
});

describe("Jev with a neutral policy is Adaptive", () => {
  it(
    "makes identical decisions and steers an identical world",
    { timeout: 180_000 },
    () => {
      const model = chicagoModel(2);
      // A busy, deterministic sample of trips on the real Metro graph.
      const spawns: ScheduledSpawn[] = model.city.roads
        .filter((_road, index) => index % 37 === 0)
        .slice(0, 90)
        .map((road, index) => ({
          timeMs: index * 400,
          type: "car" as const,
          origin: road.from,
          destination: road.to,
        }));

      const adaptive = createAdaptiveController();
      const jev = createJevController({
        client: createMockJevClient({ respond: () => neutralJevPolicy() }),
        scenarioFingerprint: "neutral-ablation",
        refreshMs: 500,
      });

      const adaptiveEngine: EngineState = createEngine({
        city: model.city,
        controller: adaptive,
        spawns: [...spawns],
      });
      const jevEngine: EngineState = createEngine({
        city: model.city,
        controller: jev,
        spawns: [...spawns],
      });
      const adaptiveTracker = createApproachArrivalTracker();
      const jevTracker = createApproachArrivalTracker();

      let comparisons = 0;
      let decisionDifferences = 0;
      for (let tick = 0; tick < 600; tick += 1) {
        stepEngine(adaptiveEngine);
        stepEngine(jevEngine);

        const frameA = buildObservationFrame(
          adaptiveEngine.city,
          adaptiveEngine.traffic,
          adaptiveTracker,
        );
        const frameJ = buildObservationFrame(jevEngine.city, jevEngine.traffic, jevTracker);
        const mapA = adaptive.directives(adaptiveEngine.city, adaptiveEngine.traffic, {
          observations: frameA,
          partition: adaptiveEngine.partition,
        });
        const mapJ = jev.directives(jevEngine.city, jevEngine.traffic, {
          observations: frameJ,
          partition: jevEngine.partition,
        });
        for (const intersectionId of frameA.intersections.keys()) {
          comparisons += 1;
          if (instruction(mapA.get(intersectionId)) !== instruction(mapJ.get(intersectionId))) {
            decisionDifferences += 1;
          }
        }
      }

      // The policy really was neutral, and really was in force.
      const policy = jev.policy();
      expect(policy).not.toBeNull();
      expect(policy!.corridorWeights).toHaveLength(0);
      expect(policy!.regionWeights).toHaveLength(0);
      expect(policy!.pressureScale).toBe(1);

      // (1) No decision differed, at any intersection, at any tick.
      expect(comparisons).toBeGreaterThan(10_000);
      expect(decisionDifferences).toBe(0);
      // (2) The worlds are identical, vehicle for vehicle.
      expect(worldDigest(jevEngine)).toBe(worldDigest(adaptiveEngine));
    },
  );
});
