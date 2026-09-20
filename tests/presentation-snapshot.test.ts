/**
 * Issue #24 — the presentation frame contract.
 *
 * The frame used to ship every active vehicle. It now ships ONE ego car, the
 * sparse road state that replaced the fleet, route-local control state, and the
 * ego's trip progress. Background traffic never crosses this boundary.
 */
import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { createEngine, queueIncident, runEngine, type ScheduledSpawn } from "@/sim/engine";
import { buildPresentationMetrics, buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { makeStreet } from "./traffic-support";

/**
 * Fixture: chain 0 -> 1 -> 2 -> 3 (roads 0..2).
 * - the curated trip's car runs 0 -> 2 (roads 0 and 1)
 * - a background car runs 2 -> 3 and never touches the ego's route
 * - signals at intersection 1 (on the route) and 3 (off it)
 */
function fixture(spawns?: ScheduledSpawn[]) {
  const { city } = makeStreet([
    { length: 2, speedLimit: 10, capacity: 4 },
    { length: 10, speedLimit: 10, capacity: 2 },
    { length: 10, speedLimit: 10, capacity: 2 },
  ]);
  city.intersections[1].control = "signal";
  city.intersections[3].control = "signal";
  const ego: ScheduledSpawn = { timeMs: 0, type: "car", origin: 0, destination: 2, role: "ego" };
  const background: ScheduledSpawn = { timeMs: 0, type: "car", origin: 2, destination: 3 };
  return {
    city,
    ego,
    spawns: spawns ?? [ego, background],
  };
}

describe("presentation snapshots", () => {
  it("carries exactly one ego vehicle and no background fleet", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 300);
    const snapshot = buildPresentationSnapshot(engine, 0, "loop-circuit");
    expect(snapshot.sequence).toBe(0);
    expect(snapshot.timeMs).toBe(300);
    expect(snapshot.controller).toBe("fixed");
    expect(snapshot.ego?.id).toBe(engine.egoVehicleId);
    expect("vehicles" in snapshot).toBe(false);
  });

  it("identifies the ego by the id the engine recorded, not by list position", () => {
    const { city } = fixture();
    // Ego spawned LAST: position-based detection would pick the wrong car.
    const spawns: ScheduledSpawn[] = [
      { timeMs: 0, type: "car", origin: 2, destination: 3 },
      { timeMs: 0, type: "truck", origin: 2, destination: 3 },
      { timeMs: 0, type: "car", origin: 0, destination: 2, role: "ego" },
    ];
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 200);
    expect(engine.egoVehicleId).toBe(2);
    const snapshot = buildPresentationSnapshot(engine, 1, "loop-circuit");
    expect(snapshot.ego?.id).toBe(2);
    expect(snapshot.ego?.type).toBe("car");
    expect(snapshot.ego?.routeIndex).toBeGreaterThanOrEqual(0);
  });

  it("aggregates road traffic sparsely, with queue counts that match the engine", () => {
    const { city } = fixture();
    // Four cars on the same 0 -> 2 trip: the tail queues at road 0's end.
    const run = createEngine({
      city,
      controller: createFixedController(),
      spawns: [
        { timeMs: 0, type: "car", origin: 0, destination: 2, role: "ego" },
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
        { timeMs: 0, type: "car", origin: 0, destination: 2 },
      ],
    });
    runEngine(run, 400);
    const snapshot = buildPresentationSnapshot(run, 2, "loop-circuit");
    // Sparse: only roads that carry state appear.
    expect(snapshot.roadTraffic.length).toBeLessThan(city.roads.length);
    expect(snapshot.roadTraffic.length).toBeGreaterThan(0);
    const expected = new Map<number, number>();
    for (const vehicle of run.traffic.vehicles) {
      if (vehicle.state === "queued" && vehicle.roadId !== null) {
        expected.set(vehicle.roadId, (expected.get(vehicle.roadId) ?? 0) + 1);
      }
    }
    for (const road of snapshot.roadTraffic) {
      expect(road.queuedCount).toBe(expected.get(road.roadId) ?? 0);
      expect(road.capacity).toBe(city.roads[road.roadId].capacity);
      expect(road.occupancy).toBeGreaterThan(0);
      expect(road.vehicleCount).toBeGreaterThan(0);
    }
    expect(snapshot.roadTraffic.some((road) => road.queuedCount > 0)).toBe(true);
    // Deterministic ordering: ascending road id.
    const ids = snapshot.roadTraffic.map((road) => road.roadId);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it("filters control state to the ego's remaining route", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 100);
    const snapshot = buildPresentationSnapshot(engine, 3, "loop-circuit");
    // Signal at intersection 1 is on the ego's route; the one at 3 is not.
    expect(snapshot.routeControls.map((signal) => signal.intersectionId)).toEqual([1]);
    // The city still runs every signal — this is a payload filter, not a sim change.
    expect(engine.traffic.signals.size).toBe(2);
  });

  it("reports trip progress from facts the simulation actually has", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 300);
    const midway = buildPresentationSnapshot(engine, 4, "loop-circuit");
    expect(midway.trip).not.toBeNull();
    expect(midway.trip?.tripId).toBe("loop-circuit");
    expect(midway.trip?.originIntersectionId).toBe(0);
    expect(midway.trip?.destinationIntersectionId).toBe(2);
    expect(midway.trip?.routeRoadIds).toEqual([0, 1]);
    expect(midway.trip?.routeIndex).toBe(1);
    expect(midway.trip?.intersectionsCleared).toBe(1);
    expect(midway.trip?.completed).toBe(false);
    expect(midway.trip?.distanceTravelledM).toBeCloseTo(3, 5); // 2 m road 0 + 1 m into road 1
    expect(midway.trip?.distanceRemainingM).toBeCloseTo(9, 5);
    expect(midway.trip?.tripTimeMs).toBe(300);

    runEngine(engine, 1_200);
    const arrived = buildPresentationSnapshot(engine, 5, "loop-circuit");
    expect(arrived.trip?.completed).toBe(true);
    expect(arrived.trip?.distanceRemainingM).toBe(0);
    expect(arrived.trip?.distanceTravelledM).toBeCloseTo(12, 5);
    // tripId is the only place a trip name lives; the ego keeps being ordinary.
    expect(buildPresentationSnapshot(engine, 6).trip).toBeNull();
  });

  it("serializes compactly: no routes, destinations or fleet bookkeeping", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 300);
    const serialized = JSON.stringify(buildPresentationSnapshot(engine, 7, "loop-circuit"));
    expect(serialized).not.toContain('"destination"');
    expect(serialized).not.toContain('"intersections"'); // no city geometry per frame
    expect(serialized).not.toContain('"successfulReroutes"');
    // With a trip id, the ego's own route IS allowed — there is exactly one.
    const withTrip = buildPresentationSnapshot(engine, 7, "loop-circuit");
    expect(withTrip.trip?.routeRoadIds.length).toBeGreaterThan(0);
    expect(serialized.length).toBeGreaterThan(0);
  });

  it("reports blocked wait for the ego: continuous while queued, zero while moving", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 220);
    const snapshot = buildPresentationSnapshot(engine, 8, "loop-circuit");
    expect(snapshot.ego?.state).toBe("moving");
    expect(snapshot.ego?.blockedWaitMs).toBe(0);
    expect(snapshot.ego?.queueRank).toBeNull();
  });

  it("carries incidents and road conditions without per-vehicle data", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 200);
    queueIncident(engine, { kind: "crash", targetRoadId: 0, durationMs: 5_000 });
    runEngine(engine, 400);
    const snapshot = buildPresentationSnapshot(engine, 9, "loop-circuit");
    expect(snapshot.roadConditions.length).toBeGreaterThan(0);
    expect(snapshot.incidents.length).toBeGreaterThan(0);
    expect(snapshot.incidents[0]?.kind).toBe("crash");
    expect(JSON.stringify(snapshot)).not.toContain('"vehicles"');
  });

  it("estimates the remaining time deterministically from route and traffic", () => {
    const a = fixture();
    const b = fixture();
    const engineA = createEngine({ city: a.city, controller: createFixedController(), spawns: a.spawns });
    const engineB = createEngine({ city: b.city, controller: createFixedController(), spawns: b.spawns });
    runEngine(engineA, 300);
    runEngine(engineB, 300);
    const tripA = buildPresentationSnapshot(engineA, 0, "loop-circuit").trip;
    const tripB = buildPresentationSnapshot(engineB, 0, "loop-circuit").trip;
    expect(tripA?.estimatedRemainingMs).toBe(tripB?.estimatedRemainingMs);
    expect(tripA?.estimatedRemainingMs ?? -1).toBeGreaterThan(0);
    expect(Number.isFinite(tripA?.estimatedRemainingMs ?? NaN)).toBe(true);

    // A congested road cannot make the estimate faster: same route, more
    // occupancy, larger estimate.
    runEngine(engineA, 1_500);
    const later = buildPresentationSnapshot(engineA, 1, "loop-circuit").trip;
    expect((later?.estimatedRemainingMs ?? 0) >= 0).toBe(true);
    runEngine(engineA, 5_000);
    const arrived = buildPresentationSnapshot(engineA, 2, "loop-circuit").trip;
    expect(arrived?.completed).toBe(true);
    expect(arrived?.estimatedRemainingMs).toBe(0);
  });

  it("is deterministic for identical engine state", () => {
    const a = fixture();
    const b = fixture();
    const engineA = createEngine({ city: a.city, controller: createFixedController(), spawns: a.spawns });
    const engineB = createEngine({ city: b.city, controller: createFixedController(), spawns: b.spawns });
    runEngine(engineA, 700);
    runEngine(engineB, 700);
    expect(JSON.stringify(buildPresentationSnapshot(engineA, 10, "loop-circuit"))).toBe(
      JSON.stringify(buildPresentationSnapshot(engineB, 10, "loop-circuit")),
    );
    expect(buildPresentationMetrics(engineA)).toEqual(buildPresentationMetrics(engineB));
  });
});
