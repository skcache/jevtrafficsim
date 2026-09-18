import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { showcaseCity } from "@/cities/showcase-city";
import { generateDemand } from "@/sim/demand";
import { createEngine, queueIncident, runEngine, stepEngine } from "@/sim/engine";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { validatePartition } from "@/sim/regions";
import { computeMetrics } from "@/sim/metrics";

/**
 * The showcase city must satisfy the REAL engine (Task-11 correction §22):
 * routing, signals, stops, spillback, Adaptive observations, regions /
 * corridors, incidents, bridge closure, event release, deterministic demand.
 */
describe("showcase city + engine integration", () => {
  it("runs demand end to end on the showcase city", () => {
    const { city } = showcaseCity(2);
    const spawns = generateDemand({ city, level: "everyday", seed: 42, durationMs: 180_000 });
    const engine = createEngine({ city, controller: createFixedController(), spawns });
    runEngine(engine, 180_000);
    const metrics = computeMetrics(engine.metrics, engine.traffic);
    expect(metrics.completedTrips).toBeGreaterThan(5);
    expect(Number.isFinite(metrics.averageTripTimeMs)).toBe(true);
    expect(engine.metrics.failedSpawns).toBeLessThan(spawns.length);
  });

  it("supports Adaptive control, observations, partitions and corridors", () => {
    const { city } = showcaseCity(3);
    const spawns = generateDemand({ city, level: "light", seed: 7, durationMs: 120_000 });
    const engine = createEngine({ city, controller: createAdaptiveController(), spawns });
    runEngine(engine, 120_000);
    // The engine built its own partition and observation frames every tick.
    expect(validatePartition(city, engine.partition).length).toBe(0);
    expect(city.corridors.length).toBeGreaterThanOrEqual(4);
    const metrics = computeMetrics(engine.metrics, engine.traffic);
    expect(metrics.completedTrips).toBeGreaterThan(0);
    expect(metrics.signalPhaseChanges).toBeGreaterThan(0);
  });

  it("is deterministic for identical inputs", () => {
    const build = () => {
      const { city } = showcaseCity(2);
      const spawns = generateDemand({ city, level: "light", seed: 11, durationMs: 20_000 });
      return createEngine({ city, controller: createAdaptiveController(), spawns });
    };
    const a = build();
    const b = build();
    runEngine(a, 20_000);
    runEngine(b, 20_000);
    expect(JSON.stringify(buildPresentationSnapshot(a, 0))).toBe(
      JSON.stringify(buildPresentationSnapshot(b, 0)),
    );
  });

  it("supports every incident kind, including bridge targeting", () => {
    const { city } = showcaseCity(2);
    const spawns = generateDemand({ city, level: "light", seed: 5, durationMs: 60_000 });
    const engine = createEngine({
      city,
      controller: createAdaptiveController(),
      spawns,
      incidents: {
        seed: 99,
        script: [
          { atMs: 5_000, kind: "crash" },
          { atMs: 10_000, kind: "close-road" },
          { atMs: 15_000, kind: "bridge-closed" },
          { atMs: 20_000, kind: "traffic-burst", durationMs: 10_000 },
          { atMs: 25_000, kind: "event-release" },
        ],
      },
    });
    runEngine(engine, 60_000);
    const records = engine.incidents.records;
    expect(records.length).toBe(5);
    const bridge = records.find((record) => record.kind === "bridge-closed")!;
    expect(bridge.roadIds.length).toBeGreaterThan(0);
    expect(city.roads[bridge.roadIds[0]].kind).toBe("bridge");
    const event = records.find((record) => record.kind === "event-release")!;
    expect(event.eventCenterIntersectionId).not.toBeNull();
    // The arena plaza is a strong candidate for event traffic but the stream
    // decides; what matters is that the center is a real, connected node.
    expect(city.intersections[event.eventCenterIntersectionId!]).toBeDefined();
    const closed = records.find((record) => record.kind === "close-road")!;
    expect(closed.roadIds.length).toBeGreaterThan(0);
    // Runtime city isolation: the compiled showcase city is never mutated.
    const fresh = showcaseCity(2).city;
    expect(city.roads.every((road, index) => road.closed === fresh.roads[index].closed)).toBe(true);
  });

  it("keeps live runtime injection working on the showcase city", () => {
    const { city } = showcaseCity(3);
    const engine = createEngine({
      city,
      controller: createFixedController(),
      spawns: [],
      incidents: { seed: 3, script: [] },
    });
    stepEngine(engine);
    queueIncident(engine, { kind: "bridge-closed" });
    runEngine(engine, 1_000);
    const record = engine.incidents.records[0];
    expect(record.kind).toBe("bridge-closed");
    expect(["active", "expired"]).toContain(record.status);
  });
});
