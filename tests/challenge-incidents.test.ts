import { describe, expect, it } from "vitest";
import { chicagoModel } from "./chicago-support";
import { materializeCuratedTrip } from "@/cities/chicago-trips";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import {
  CHALLENGE_INCIDENT_COUNTS,
  automaticTargetRoads,
  buildChallengeIncidentPlan,
  challengeIncidentFingerprintInput,
  resolveManualChallengeIncident,
  tripReachableExcluding,
  type ResolvedChallengeIncident,
} from "@/worker/challenge-incidents";
import { physicalSegments, reachableIntersectionCount } from "@/sim/incidents";
import { createEngine, runEngine, setEngineController } from "@/sim/engine";
import { createFixedController } from "@/controllers/fixed";
import { createAdaptiveController } from "@/controllers/adaptive";

describe("Issue #27 challenge incident planning", () => {
  const model = chicagoModel(4);
  const trip = materializeCuratedTrip(model, {
    tripId: "united-center-to-navy-pier",
    seed: 42,
  });

  it("uses a tiny deterministic traffic-level difficulty table", () => {
    expect(CHALLENGE_INCIDENT_COUNTS).toEqual({
      light: 0,
      everyday: 1,
      "rush-hour": 2,
    });
    expect(buildChallengeIncidentPlan(model, trip, "light", 42).entries).toEqual([]);
    expect(buildChallengeIncidentPlan(model, trip, "everyday", 42).entries).toHaveLength(1);
    expect(buildChallengeIncidentPlan(model, trip, "rush-hour", 42).entries).toHaveLength(2);
  });

  it("is byte-identical for the same controller-neutral inputs", () => {
    const a = buildChallengeIncidentPlan(model, trip, "rush-hour", 2026);
    const b = buildChallengeIncidentPlan(model, trip, "rush-hour", 2026);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(challengeIncidentFingerprintInput(a)).toBe(
      challengeIncidentFingerprintInput(b),
    );
    expect(Object.keys(a)).not.toContain("controller");
  });

  it("changes deterministically with the scenario seed", () => {
    const a = buildChallengeIncidentPlan(model, trip, "rush-hour", 42);
    const b = buildChallengeIncidentPlan(model, trip, "rush-hour", 43);
    expect(a.seed).toBe(42);
    expect(b.seed).toBe(43);
    expect(challengeIncidentFingerprintInput(a)).not.toBe(
      challengeIncidentFingerprintInput(b),
    );
  });

  it("targets automatic road adversity ahead on the canonical route", () => {
    const first = automaticTargetRoads(trip.route.roadIds, 0);
    const second = automaticTargetRoads(trip.route.roadIds, 1);
    const indexOf = new Map(trip.route.roadIds.map((roadId, index) => [roadId, index]));
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    expect(Math.min(...first.map((roadId) => indexOf.get(roadId) ?? -1))).toBeGreaterThan(
      trip.route.roadIds.length * 0.3,
    );
    expect(Math.min(...second.map((roadId) => indexOf.get(roadId) ?? -1))).toBeGreaterThan(
      trip.route.roadIds.length * 0.6,
    );
  });

  it("fully resolves automatic incidents before engine execution", () => {
    const plan = buildChallengeIncidentPlan(model, trip, "rush-hour", 77);
    for (const entry of plan.entries) {
      expect(entry.atMs).toBeGreaterThan(0);
      if (
        entry.kind === "crash" ||
        entry.kind === "close-road" ||
        entry.kind === "bridge-closed"
      ) {
        expect(entry.targetRoadId).toBeTypeOf("number");
      }
      if (entry.kind === "event-release") {
        expect(entry.centerIntersectionId).toBeTypeOf("number");
      }
    }
  });

  it("keeps automatic road targets on the canonical trip structure", () => {
    const route = new Set(trip.route.roadIds);
    const segmentByRoad = new Map<number, readonly number[]>();
    for (const segment of physicalSegments(model.city)) {
      for (const roadId of segment.roadIds) {
        segmentByRoad.set(roadId, segment.roadIds);
      }
    }

    for (let seed = 0; seed < 20; seed += 1) {
      const plan = buildChallengeIncidentPlan(model, trip, "rush-hour", seed);
      for (const entry of plan.entries) {
        if (entry.targetRoadId === undefined) continue;
        const physical = segmentByRoad.get(entry.targetRoadId) ?? [entry.targetRoadId];
        expect(
          physical.some((roadId) => route.has(roadId)),
          `${entry.kind} target ${entry.targetRoadId}`,
        ).toBe(true);
      }
    }
  });

  it("never plans an automatic closure that destroys the selected OD", () => {
    for (let seed = 0; seed < 30; seed += 1) {
      const plan = buildChallengeIncidentPlan(model, trip, "rush-hour", seed);
      for (const entry of plan.entries) {
        if (
          (entry.kind !== "close-road" && entry.kind !== "bridge-closed") ||
          entry.targetRoadId === undefined
        ) {
          continue;
        }
        const segment = physicalSegments(model.city).find((candidate) =>
          candidate.roadIds.includes(entry.targetRoadId!),
        );
        expect(segment).toBeDefined();
        const excluded = new Set(segment?.roadIds ?? []);
        expect(
          reachableIntersectionCount(model.city, excluded),
        ).toBe(reachableIntersectionCount(model.city));
        expect(
          tripReachableExcluding(
            model.city,
            trip.originIntersectionId,
            trip.destinationIntersectionId,
            excluded,
          ),
        ).toBe(true);
      }
    }
  });

  it("never stacks two automatic closures in one Rush scenario", () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const plan = buildChallengeIncidentPlan(model, trip, "rush-hour", seed);
      const closures = plan.entries.filter(
        (entry) => entry.kind === "close-road" || entry.kind === "bridge-closed",
      );
      expect(closures.length).toBeLessThanOrEqual(1);
    }
  });

  it("gives Fixed and Adaptive the exact same automatic script", () => {
    const plan = buildChallengeIncidentPlan(model, trip, "rush-hour", 91);
    const { spawn } = materializeChallengeTrip(
      model,
      "united-center-to-navy-pier",
      91,
    );
    const fixed = createEngine({
      city: model.city,
      controller: createFixedController(),
      spawns: [spawn],
      incidents: { seed: plan.incidentSeed, script: [...plan.entries] },
    });
    const adaptive = createEngine({
      city: model.city,
      controller: createAdaptiveController(),
      spawns: [spawn],
      incidents: { seed: plan.incidentSeed, script: [...plan.entries] },
    });
    expect(fixed.incidentConfig.script).toEqual(adaptive.incidentConfig.script);
    expect(fixed.incidentConfig.seed).toBe(adaptive.incidentConfig.seed);
  });

  it("keeps the incident plan unchanged across an in-place controller switch", () => {
    const plan = buildChallengeIncidentPlan(model, trip, "everyday", 17);
    const { spawn } = materializeChallengeTrip(
      model,
      "united-center-to-navy-pier",
      17,
    );
    const engine = createEngine({
      city: model.city,
      controller: createFixedController(),
      spawns: [spawn],
      incidents: { seed: plan.incidentSeed, script: [...plan.entries] },
    });
    const before = JSON.stringify(engine.incidentConfig.script);
    setEngineController(engine, createAdaptiveController());
    expect(JSON.stringify(engine.incidentConfig.script)).toBe(before);
  });
});

describe("Issue #27 manual route-relevant chaos", () => {
  const model = chicagoModel(4);
  const trip = materializeCuratedTrip(model, {
    tripId: "united-center-to-navy-pier",
    seed: 42,
  });

  const base = {
    model,
    city: model.city,
    atMs: 25_430,
    seed: 42,
    sequence: 0,
    routeRoadIds: trip.route.roadIds,
    routeIndex: 0,
    egoRoadId: trip.route.roadIds[0],
    destinationIntersectionId: trip.destinationIntersectionId,
  } as const;

  it("records a concrete current-route crash target and simulation time", () => {
    const resolved = resolveManualChallengeIncident({
      ...base,
      kind: "crash",
    });
    expect(resolved.entry?.kind).toBe("crash");
    expect(resolved.entry?.atMs).toBe(25_400);
    expect(resolved.entry?.targetRoadId).toBeTypeOf("number");
    expect(trip.route.roadIds).toContain(resolved.entry?.targetRoadId);
  });

  it("chooses a safe future route segment for Close Road", () => {
    const resolved = resolveManualChallengeIncident({
      ...base,
      kind: "close-road",
    });
    expect(resolved.entry).not.toBeNull();
    const target = resolved.entry?.targetRoadId;
    expect(target).toBeTypeOf("number");
    const segment = physicalSegments(model.city).find((candidate) =>
      candidate.roadIds.includes(target!),
    );
    expect(segment).toBeDefined();
    const rerouteOrigin = model.city.roads[base.egoRoadId].to;
    expect(
      tripReachableExcluding(
        model.city,
        rerouteOrigin,
        trip.destinationIntersectionId,
        new Set(segment?.roadIds ?? []),
      ),
    ).toBe(true);
  });

  it("resolves Event Lets Out to an explicit route-relevant venue", () => {
    const resolved = resolveManualChallengeIncident({
      ...base,
      kind: "event-release",
    });
    expect(resolved.entry?.centerIntersectionId).toBeTypeOf("number");
  });

  it("serializes exact resolved manual entries for later replay", () => {
    const plan = buildChallengeIncidentPlan(model, trip, "everyday", 42);
    const resolution = resolveManualChallengeIncident({
      ...base,
      kind: "crash",
    });
    expect(resolution.entry).not.toBeNull();
    const history: ResolvedChallengeIncident[] = [
      ...plan.entries.map((entry, id) => ({ id, source: "automatic" as const, entry })),
      {
        id: plan.entries.length,
        source: "manual",
        entry: resolution.entry!,
      },
    ];
    const fingerprint = challengeIncidentFingerprintInput(plan, history);
    expect(fingerprint).toContain('"manual"');
    expect(fingerprint).toContain('"targetRoadId"');
    expect(fingerprint).not.toContain('"controller"');
  });

  it("a resolved future closure uses the existing reroute engine path", () => {
    const resolution = resolveManualChallengeIncident({
      ...base,
      kind: "close-road",
      atMs: 100,
    });
    expect(resolution.entry).not.toBeNull();

    const { spawn } = materializeChallengeTrip(
      model,
      "united-center-to-navy-pier",
      42,
    );
    const engine = createEngine({
      city: model.city,
      controller: createFixedController(),
      spawns: [spawn],
      incidents: { seed: 42, script: [resolution.entry!] },
    });
    runEngine(engine, 500);
    expect(engine.incidents.records[0].status).toBe("active");
    expect(engine.rerouteStats.attempted).toBeGreaterThan(0);
    expect(engine.rerouteStats.succeeded).toBeGreaterThan(0);
  });
});
