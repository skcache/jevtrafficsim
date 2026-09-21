/**
 * Issue #28 — driver strategies, scenario fairness and the comparison guard.
 *
 * The two axes must never mix: WHO drives (tourist / local) and WHAT controls
 * the city (fixed / adaptive) are independent, the scenario describes only the
 * world, and a comparison is only shown when both results describe the same one.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createEngine, runEngine, stepEngine, type ScheduledSpawn } from "@/sim/engine";
import { createFixedController } from "@/controllers/fixed";
import { createAdaptiveController } from "@/controllers/adaptive";
import {
  DRIVER_CHOICES,
  LOCAL_REPLAN,
  createDriverState,
  decideReplan,
  remainingRouteSeconds,
} from "@/sim/driver";
import type { City, Intersection, Road } from "@/sim/types";
import { chicagoModel } from "./chicago-support";
import {
  buildChallengeScenario,
  resolveScenarioWorld,
  sameScenario,
  scenarioFingerprint,
} from "@/worker/challenge-scenario";
import { buildChallengeResult, comparisonVerdict } from "@/worker/challenge-result";
import { runComparison } from "@/worker/challenge-compare";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { generateDemand } from "@/sim/demand";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function road(id: number, from: number, to: number, length: number): Road {
  return { id, from, to, length, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false };
}

function intersection(
  id: number,
  x: number,
  y: number,
  incoming: number[],
  outgoing: number[],
): Intersection {
  return { id, x, y, incoming, outgoing, control: "uncontrolled", regionId: 0 };
}

/**
 * Two ways across: the direct chain (roads 0,1) and a longer detour
 * (roads 2,3,4). Both start at node 0 and end at node 3, so A* can choose.
 */
function twoRouteCity(): City {
  // Nodes must be dense (id === index): the router indexes intersections by id.
  // Road 0 is long, so the car is still on it when the local driver looks; from
  // node 1 there are two ways to the destination — the direct road 1 and the
  // detour through node 3.
  const roads: Road[] = [
    road(0, 0, 1, 2_000),
    road(1, 1, 2, 400),
    road(2, 1, 3, 300),
    road(3, 3, 2, 300),
  ];
  const intersections: Intersection[] = [
    intersection(0, 0, 0, [], [0]),
    intersection(1, 2_000, 0, [0], [1, 2]),
    intersection(2, 2_300, 0, [1, 3], []),
    intersection(3, 2_000, -300, [2], [3]),
  ];
  return {
    size: "medium",
    seed: 0,
    gridWidth: 0,
    gridHeight: 0,
    corridors: [],
    intersections,
    roads,
  };
}

const EGO: ScheduledSpawn = { timeMs: 0, type: "car", origin: 0, destination: 2, role: "ego" };

/* ------------------------------------------------------------------ */
/* Driver policy (pure)                                                */
/* ------------------------------------------------------------------ */

describe("driver strategies", () => {
  it("offers exactly the two axes the challenge supports", () => {
    expect([...DRIVER_CHOICES]).toEqual(["tourist", "local"]);
  });

  it("never lets a tourist replan for congestion alone", () => {
    const state = createDriverState();
    // A route that would save two minutes: still not the tourist's business.
    const decision = decideReplan("tourist", state, 600_000, 900, 780);
    expect(decision.replan).toBe(false);
    expect(decision.reason).toBe("tourist");
  });

  it("lets a local replan only when the improvement is material", () => {
    const state = { ...createDriverState(), lastCheckMs: 0 };
    // 5% and 8 seconds better: noise, not a reason to churn the route.
    const small = decideReplan("local", state, LOCAL_REPLAN.intervalMs, 600, 570);
    expect(small.replan).toBe(false);
    expect(small.reason).toBe("not-better");
    // 20% and 120 seconds better: worth switching.
    const big = decideReplan("local", state, LOCAL_REPLAN.intervalMs, 600, 480);
    expect(big.replan).toBe(true);
    expect(big.reason).toBe("switch");
    expect(big.improvementSeconds).toBe(120);
  });

  it("does not look again before the interval has passed", () => {
    const state = { ...createDriverState(), lastCheckMs: 0 };
    const early = decideReplan("local", state, LOCAL_REPLAN.intervalMs - 1, 600, 100);
    expect(early.replan).toBe(false);
    expect(early.reason).toBe("not-due");
  });

  it("holds the cooldown after a switch, so the route cannot oscillate", () => {
    const state = { lastCheckMs: 0, lastSwitchMs: 0, switches: 1 };
    const inside = decideReplan("local", state, LOCAL_REPLAN.cooldownMs - 1, 600, 100);
    expect(inside.replan).toBe(false);
    expect(inside.reason).toBe("cooldown");
    // Due again and out of cooldown: the same improvement now goes through.
    const after = decideReplan("local", state, LOCAL_REPLAN.cooldownMs, 600, 100);
    expect(after.replan).toBe(true);
  });

  it("is deterministic: identical inputs give identical decisions", () => {
    const make = () => ({ ...createDriverState(), lastCheckMs: 0 });
    const a = decideReplan("local", make(), 20_000, 500, 400);
    const b = decideReplan("local", make(), 20_000, 500, 400);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

/* ------------------------------------------------------------------ */
/* Driver behaviour in the engine                                      */
/* ------------------------------------------------------------------ */

describe("driver behaviour", () => {
  it("keeps a tourist on a congested route and reroutes only on a hard closure", () => {
    const city = twoRouteCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [EGO],
      driver: "tourist",
      // A real closure lands on the road ahead at t=10s, through the same
      // script seam the challenge incidents use.
      incidents: {
        seed: 0,
        script: [{ kind: "close-road", atMs: 10_000, targetRoadId: 1, durationMs: 600_000 }],
      },
    });
    runEngine(engine, 5_000);
    const ego = engine.traffic.vehicles[engine.egoVehicleId!];
    const routeBefore = [...ego.route];
    expect(routeBefore).toContain(1);

    // Congestion on the road ahead changes nothing for a tourist.
    engine.traffic.occupancy.set(1, 999);
    runEngine(engine, 4_000);
    expect([...ego.route]).toEqual(routeBefore);
    expect(ego.rerouteCount).toBe(0);

    // The closure does move them, onto the detour.
    runEngine(engine, 40_000);
    expect(ego.rerouteCount).toBeGreaterThan(0);
    expect(ego.route).toContain(2);
    expect(ego.route).not.toContain(1);
  });

  it("lets a local driver switch, and counts it as a reroute", () => {
    const city = twoRouteCity();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [EGO],
      driver: "local",
    });
    runEngine(engine, 5_000);
    const ego = engine.traffic.vehicles[engine.egoVehicleId!];
    // Jam the road the local driver is heading for (not the one it is on — the
    // two options share that, so congestion there would rightly cancel out).
    engine.traffic.occupancy.set(ego.route[ego.routeIndex + 1], 999);
    runEngine(engine, LOCAL_REPLAN.intervalMs + 10_000);
    expect(engine.driverState.switches).toBe(1);
    expect(ego.rerouteCount).toBe(1);
    // The new route still starts on the road the car is physically on.
    expect(ego.route[0]).toBe(ego.roadId);
    expect(ego.routeIndex).toBe(0);
    // …and it never switches again inside the cooldown, however bad it looks.
    for (const roadId of ego.route) {
      engine.traffic.occupancy.set(roadId, 999);
    }
    runEngine(engine, LOCAL_REPLAN.cooldownMs - 20_000);
    expect(engine.driverState.switches).toBe(1);
  });

  it("replays the same scenario identically, driver switches included", () => {
    const build = () => {
      const engine = createEngine({
        city: twoRouteCity(),
        controller: createFixedController(),
        spawns: [EGO],
        driver: "local",
      });
      runEngine(engine, 5_000);
      const ego = engine.traffic.vehicles[engine.egoVehicleId!];
      engine.traffic.occupancy.set(ego.route[ego.routeIndex + 1], 999);
      runEngine(engine, 60_000);
      return engine;
    };
    const a = build();
    const b = build();
    expect(a.driverState.switches).toBe(b.driverState.switches);
    expect(JSON.stringify(a.traffic.vehicles)).toBe(JSON.stringify(b.traffic.vehicles));
  });
});

/* ------------------------------------------------------------------ */
/* Scenario and fairness                                               */
/* ------------------------------------------------------------------ */

describe("challenge scenario", () => {
  const model = chicagoModel(4);

  it("carries no controller identity and fingerprints deterministically", () => {
    const scenario = buildChallengeScenario({
      tripId: "soldier-field-to-navy-pier",
      trafficLevel: "everyday",
      driver: "local",
      seed: 42,
      durationMs: 600_000,
    });
    expect(Object.keys(scenario).sort()).toEqual(
      ["driver", "durationMs", "seed", "trafficLevel", "tripId"].sort(),
    );
    expect(scenarioFingerprint(scenario)).toMatch(/^[0-9a-f]{8}$/);
    expect(scenarioFingerprint(scenario)).toBe(scenarioFingerprint({ ...scenario }));
    // A different driver is a different scenario; so is a different seed.
    expect(sameScenario(scenario, { ...scenario, driver: "tourist" })).toBe(false);
    expect(sameScenario(scenario, { ...scenario, seed: 43 })).toBe(false);
    expect(sameScenario(scenario, { ...scenario })).toBe(true);
  });

  it("resolves the same world inputs for both controllers", () => {
    const scenario = buildChallengeScenario({
      tripId: "soldier-field-to-navy-pier",
      trafficLevel: "rush-hour",
      driver: "tourist",
      seed: 7,
      durationMs: 600_000,
    });
    const trip = materializeChallengeTrip(model, scenario.tripId, scenario.seed).trip;
    const a = resolveScenarioWorld(model, trip, scenario);
    const b = resolveScenarioWorld(model, trip, { ...scenario });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Demand is a pure function of the scenario too.
    const demandA = generateDemand({
      city: model.city,
      level: scenario.trafficLevel,
      seed: a.demandSeed,
      durationMs: scenario.durationMs,
    });
    const demandB = generateDemand({
      city: model.city,
      level: scenario.trafficLevel,
      seed: b.demandSeed,
      durationMs: scenario.durationMs,
    });
    expect(JSON.stringify(demandA)).toBe(JSON.stringify(demandB));
  });

  it("runs one scenario under both controllers and only then compares", () => {
    const outcome = runComparison(model, {
      tripId: "soldier-field-to-navy-pier",
      trafficLevel: "everyday",
      driver: "tourist",
      seed: 11,
      durationMs: 60_000,
    });
    expect(outcome.fixed.controller).toBe("fixed");
    expect(outcome.adaptive.controller).toBe("adaptive");
    expect(outcome.fixed.fingerprint).toBe(outcome.adaptive.fingerprint);
    expect(outcome.fixed.driver).toBe("tourist");
    expect(outcome.verdict.comparable).toBe(true);
    // Both runs played the same scenario and the same incident script.
    expect(outcome.incidentEntries).toBeGreaterThanOrEqual(0);
    expect(outcome.fixed.trip.distanceM).toBeGreaterThan(0);
    expect(outcome.adaptive.trip.distanceM).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Fairness: the ego never reaches the controller                      */
/* ------------------------------------------------------------------ */

describe("controller fairness", () => {
  it("never leaks ego identity into controller inputs", () => {
    for (const file of [
      "../controllers/fixed.ts",
      "../controllers/adaptive.ts",
      "../sim/observations.ts",
      "../sim/controller.ts",
    ]) {
      let source: string;
      try {
        source = readFileSync(new URL(file, import.meta.url), "utf8");
      } catch {
        continue; // module may not exist under that name
      }
      expect(source).not.toContain("egoVehicleId");
      expect(source).not.toContain("driverState");
      expect(source).not.toMatch(/\bdriver\b/);
      expect(source).not.toContain("role: \"ego\"");
    }
  });

  it("produces identical controller behaviour whether or not the car is the ego", () => {
    // Same world, same spawns, same driver — only the ego LABEL differs. Every
    // signal state must evolve identically, which is only possible if the
    // controller never sees the label.
    const build = (tagged: boolean) => {
      const spawns: ScheduledSpawn[] = [
        { timeMs: 0, type: "car", origin: 0, destination: 2, ...(tagged ? { role: "ego" as const } : {}) },
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
        { timeMs: 2_000, type: "truck", origin: 0, destination: 2 },
      ];
      return createEngine({
        city: twoRouteCity(),
        controller: createAdaptiveController(),
        spawns,
        // Tourist: no proactive replanning, so any difference between the two
        // engines could only come from the controller seeing the ego label.
        driver: "tourist",
      });
    };
    const plain = build(false);
    const tagged = build(true);
    for (let step = 0; step < 200; step += 1) {
      stepEngine(plain);
      stepEngine(tagged);
      expect(JSON.stringify([...tagged.traffic.signals])).toBe(JSON.stringify([...plain.traffic.signals]));
    }
    expect(tagged.egoVehicleId).not.toBeNull();
    expect(plain.egoVehicleId).toBeNull();
  });

  it("gives a future controller the same world contract, with no ego fields", () => {
    const engine = createEngine({
      city: twoRouteCity(),
      controller: createFixedController(),
      spawns: [EGO],
      driver: "tourist",
    });
    runEngine(engine, 1_000);
    // The engine's own state may know the ego; the CONTRACT a controller is
    // handed is (city, traffic, context). Identity lives on the engine, and the
    // only reader of it is presentation and the driver strategy.
    expect(Object.keys(engine).sort()).toEqual(
      expect.arrayContaining(["driver", "driverState", "egoVehicleId"]),
    );
    const observationSource = readFileSync(new URL("../sim/observations.ts", import.meta.url), "utf8");
    expect(observationSource).not.toContain("egoVehicleId");
    expect(observationSource).not.toMatch(/\bdriver\b/);
  });
});

/* ------------------------------------------------------------------ */
/* Results and the comparison guard                                    */
/* ------------------------------------------------------------------ */

describe("results and comparison guard", () => {
  const model = chicagoModel(4);

  function resultFor(driver: "tourist" | "local", seed: number, controller: "fixed" | "adaptive") {
    const scenario = buildChallengeScenario({
      tripId: "soldier-field-to-navy-pier",
      trafficLevel: "light",
      driver,
      seed,
      durationMs: 45_000,
    });
    const trip = materializeChallengeTrip(model, scenario.tripId, scenario.seed).trip;
    const world = resolveScenarioWorld(model, trip, scenario);
    const engine = createEngine({
      city: model.city,
      controller: controller === "fixed" ? createFixedController() : createAdaptiveController(),
      spawns: [
        materializeChallengeTrip(model, scenario.tripId, scenario.seed).spawn,
        ...generateDemand({
          city: model.city,
          level: scenario.trafficLevel,
          seed: world.demandSeed,
          durationMs: scenario.durationMs,
        }),
      ],
      driver,
      incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
    });
    runEngine(engine, scenario.durationMs);
    return buildChallengeResult(engine, scenario, controller, 0);
  }

  it("carries the fingerprint, controller and driver on every result", () => {
    const result = resultFor("local", 5, "fixed");
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(result.controller).toBe("fixed");
    expect(result.driver).toBe("local");
    expect(result.trip.distanceM).toBeGreaterThan(0);
    expect(Number.isFinite(result.trip.averageSpeedMps)).toBe(true);
    expect(result.city.completedTrips).toBeGreaterThanOrEqual(0);
  });

  it("refuses to compare results from different scenarios or the same controller", () => {
    const fixed = resultFor("tourist", 5, "fixed");
    const adaptiveSame = resultFor("tourist", 5, "adaptive");
    const adaptiveOtherSeed = resultFor("tourist", 6, "adaptive");
    const adaptiveOtherDriver = resultFor("local", 5, "adaptive");

    expect(comparisonVerdict(fixed, adaptiveSame)).toEqual({ comparable: true });
    expect(comparisonVerdict(fixed, adaptiveOtherSeed).comparable).toBe(false);
    expect(comparisonVerdict(fixed, adaptiveOtherDriver).comparable).toBe(false);
    expect(comparisonVerdict(fixed, { ...fixed }).comparable).toBe(false); // same controller
    expect(comparisonVerdict(fixed, { ...adaptiveSame, manualIncidents: 1 }).comparable).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Travel-time estimate                                                */
/* ------------------------------------------------------------------ */

describe("remaining travel time", () => {
  it("falls as the car progresses and rises with congestion", () => {
    const city = twoRouteCity();
    const engine = createEngine({ city, controller: createFixedController(), spawns: [EGO] });
    runEngine(engine, 1_000);
    const ego = engine.traffic.vehicles[engine.egoVehicleId!];
    const full = remainingRouteSeconds(city, engine.traffic, ego.route, ego.routeIndex, ego.progress);
    expect(full).toBeGreaterThan(0);
    const later = remainingRouteSeconds(city, engine.traffic, ego.route, ego.routeIndex, ego.progress + 100);
    expect(later).toBeLessThan(full);
    // Congestion must reach the estimate through the AUTHORITATIVE traffic
    // state — the same per-road speed factor that slows vehicles and paints
    // the map. Occupancy is an input to that state, never a second slowdown
    // model (that was the point of the migration).
    const congestedRoad = ego.route[ego.routeIndex];
    engine.traffic.roadTraffic.factor.set(congestedRoad, 0.2);
    const congested = remainingRouteSeconds(city, engine.traffic, ego.route, ego.routeIndex, ego.progress);
    expect(congested).toBeGreaterThan(full);
  });
});
