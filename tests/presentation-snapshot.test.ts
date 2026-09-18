import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { createEngine, queueIncident, runEngine, type ScheduledSpawn } from "@/sim/engine";
import {
  buildPresentationMetrics,
  buildPresentationSnapshot,
} from "@/worker/presentation-snapshot";
import { makeStreet } from "./traffic-support";

/**
 * Fixture: road 0 (cap 4, len 2) feeding road 1 (cap 2, len 10).
 * - parker: enters road 1 and drives away
 * - A + B: reach road 0's end at t=200 and queue (road 1 admits only one)
 * - C: parked on road 1's start fills the headroom, so a late entrant waits
 *   as pending
 */
function fixture(): { city: ReturnType<typeof makeStreet>["city"]; spawns: ScheduledSpawn[] } {
  const { city } = makeStreet([
    { length: 2, speedLimit: 10, capacity: 4 },
    { length: 10, speedLimit: 10, capacity: 2 },
  ]);
  const spawns: ScheduledSpawn[] = [
    { timeMs: 0, type: "car", origin: 1, destination: 2 }, // parker on road 1
    { timeMs: 0, type: "car", origin: 0, destination: 2 }, // A
    { timeMs: 0, type: "car", origin: 0, destination: 2 }, // B
  ];
  return { city, spawns };
}

describe("presentation snapshots", () => {
  it("includes only active vehicles and never routes or destinations", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 300);
    const snapshot = buildPresentationSnapshot(engine, 0);
    expect(snapshot.sequence).toBe(0);
    expect(snapshot.timeMs).toBe(300);
    expect(snapshot.controller).toBe("fixed");
    expect(snapshot.vehicles.length).toBe(3);
    expect(snapshot.vehicles.every((vehicle) => vehicle.state !== "arrived")).toBe(true);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('"route"');
    expect(serialized).not.toContain('"destination"');
    expect(serialized).not.toContain('"intersections"'); // no city geometry per frame
    // The parker is on road 1, A and B are queued at road 0's end.
    expect(snapshot.vehicles.map((vehicle) => vehicle.state)).toEqual([
      "moving",
      "queued",
      "queued",
    ]);
  });

  it("drops arrived vehicles as the run progresses", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 1_200); // parker finishes road 1 at t=1000
    const snapshot = buildPresentationSnapshot(engine, 1);
    expect(snapshot.vehicles.some((vehicle) => vehicle.id === 0)).toBe(false);
    expect(snapshot.vehicles.every((vehicle) => vehicle.state !== "arrived")).toBe(true);
  });

  it("uses continuous queue wait for queued vehicles and zero for moving ones", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 300);
    const snapshot = buildPresentationSnapshot(engine, 2);
    const byId = new Map(snapshot.vehicles.map((vehicle) => [vehicle.id, vehicle]));
    expect(byId.get(0)?.blockedWaitMs).toBe(0); // moving: never "waiting"
    expect(byId.get(1)?.blockedWaitMs).toBe(100); // queued since t=200
    expect(byId.get(2)?.blockedWaitMs).toBe(100);
    // Moving vehicles stay neutral after release: run until A is released.
    runEngine(engine, 1_300);
    const later = buildPresentationSnapshot(engine, 3);
    const moving = later.vehicles.find((vehicle) => vehicle.id === 1);
    expect(moving?.state).toBe("moving");
    expect(moving?.blockedWaitMs).toBe(0);
  });

  it("reports pending wait for vehicles that never entered a road", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [...spawns, { timeMs: 0, type: "car", origin: 1, destination: 2 }],
    });
    // The fourth car targets road 1 (cap 2): parker occupies it, so the second
    // entrant parks as pending.
    runEngine(engine, 400);
    const snapshot = buildPresentationSnapshot(engine, 4);
    const pending = snapshot.vehicles.find((vehicle) => vehicle.state === "pending");
    expect(pending).toBeDefined();
    expect(pending?.roadId).toBeNull();
    expect(pending?.blockedWaitMs).toBe(400); // all of its time is pending wait
  });

  it("serializes signals, road conditions and incident markers compactly", () => {
    const { city, spawns } = fixture();
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 200);
    queueIncident(engine, { kind: "crash", targetRoadId: 0, durationMs: 5_000 });
    runEngine(engine, 400);
    const snapshot = buildPresentationSnapshot(engine, 5);
    // Road conditions are compact and only carry roads that differ from base.
    expect(snapshot.roadConditions.length).toBe(1);
    expect(snapshot.roadConditions[0]).toEqual({
      roadId: 0,
      closed: false,
      capacity: 2, // max(desired 2, resident 2)
    });
    // Incident markers carry status/targets but no internal bookkeeping.
    expect(snapshot.incidents).toEqual([
      {
        id: 0,
        kind: "crash",
        status: "active",
        roadIds: [0],
        eventCenterIntersectionId: null,
        expiresAtMs: 5_200,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("successfulReroutes");
  });

  it("is deterministic for identical engine state", () => {
    const a = fixture();
    const b = fixture();
    const engineA = createEngine({ city: a.city, controller: createFixedController(), spawns: a.spawns });
    const engineB = createEngine({ city: b.city, controller: createFixedController(), spawns: b.spawns });
    runEngine(engineA, 700);
    runEngine(engineB, 700);
    expect(JSON.stringify(buildPresentationSnapshot(engineA, 7))).toBe(
      JSON.stringify(buildPresentationSnapshot(engineB, 7)),
    );
    expect(buildPresentationMetrics(engineA)).toEqual(buildPresentationMetrics(engineB));
    const metrics = buildPresentationMetrics(engineA);
    expect(metrics.activeVehicles).toBe(3);
    expect(Number.isFinite(metrics.averageWaitTimeMs)).toBe(true);
  });
});
