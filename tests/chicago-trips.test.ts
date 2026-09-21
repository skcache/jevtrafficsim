import { describe, expect, it } from "vitest";
import {
  CURATED_TRIPS,
  CURATED_TRIP_IDS,
  curatedTrip,
  materializeCuratedTrip,
} from "@/cities/chicago-trips";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";
import { generateDemand } from "@/sim/demand";
import { createEngine, runEngine, type ScheduledSpawn } from "@/sim/engine";
import { createAdaptiveController } from "@/controllers/adaptive";
import { chicagoModel } from "./chicago-support";

describe("curated Chicago challenge trips", () => {
  const model = chicagoModel(4);

  it("ships exactly six stable Metro trips", () => {
    expect(CURATED_TRIP_IDS).toHaveLength(6);
    expect(CURATED_TRIPS).toHaveLength(6);
    expect(new Set(CURATED_TRIP_IDS).size).toBe(6);
    expect(CURATED_TRIPS.map((trip) => trip.id)).toEqual([...CURATED_TRIP_IDS]);
  });

  it("materializes every trip into a non-trivial controlled route", () => {
    for (const trip of CURATED_TRIPS) {
      const run = materializeCuratedTrip(model, { tripId: trip.id, seed: 42 });
      expect(run.route.roadIds.length, trip.id).toBeGreaterThanOrEqual(12);
      expect(run.coverage.lengthM, trip.id).toBeGreaterThan(1_000);
      expect(run.coverage.roadKinds.length, trip.id).toBeGreaterThanOrEqual(
        trip.expected.minRoadKinds,
      );
      expect(run.coverage.signalCount + run.coverage.stopCount, trip.id).toBeGreaterThan(0);
      expect(run.originIntersectionId, trip.id).not.toBe(run.destinationIntersectionId);

      const roadIds = run.route.roadIds;
      roadIds.forEach((roadId, index) => {
        const road = model.city.roads[roadId];
        expect(road, `${trip.id} road ${roadId}`).toBeTruthy();
        if (index > 0) {
          expect(model.city.roads[roadIds[index - 1]].to, trip.id).toBe(road.from);
        }
      });
    }
  });

  it("verifies the intended road/corridor coverage against the real graph", () => {
    for (const trip of CURATED_TRIPS) {
      const { coverage } = materializeCuratedTrip(model, { tripId: trip.id, seed: 42 });
      for (const feature of trip.expected.features) {
        switch (feature) {
          case "local-streets":
            expect(coverage.roadKinds, trip.id).toContain("local");
            break;
          case "major-arterial":
            expect(coverage.roadKinds, trip.id).toContain("arterial");
            break;
          case "expressway":
            expect(coverage.roadKinds, trip.id).toContain("highway");
            break;
          case "river-crossing":
            expect(coverage.waterCrossingCount, trip.id).toBeGreaterThan(0);
            break;
          case "diagonal-corridor":
            expect(coverage.corridorKinds, trip.id).toContain("diagonal");
            break;
          case "lakefront":
            expect(
              coverage.streetNames.some(
                (name) => name.includes("Lake Shore Drive") || name.includes("DuSable"),
              ),
              trip.id,
            ).toBe(true);
            break;
          case "downtown-grid":
            expect(coverage.signalCount, trip.id).toBeGreaterThanOrEqual(10);
            expect(coverage.streetNames.length, trip.id).toBeGreaterThanOrEqual(4);
            break;
        }
      }
    }

    const allKinds = new Set(
      CURATED_TRIPS.flatMap((trip) =>
        materializeCuratedTrip(model, { tripId: trip.id, seed: 42 }).coverage.roadKinds,
      ),
    );
    expect(allKinds).toEqual(new Set(["arterial", "bridge", "highway", "local"]));
  });

  it("is exactly reproducible for the same trip, seed, and traffic state", () => {
    for (const trip of CURATED_TRIPS) {
      const a = materializeCuratedTrip(model, { tripId: trip.id, seed: 2026 });
      const b = materializeCuratedTrip(model, { tripId: trip.id, seed: 2026 });
      expect(b).toEqual(a);
      expect(b.routeKey).toBe(a.routeKey);
    }
  });

  it("keeps the six canonical routes materially distinct", () => {
    const routes = CURATED_TRIPS.map((trip) => ({
      id: trip.id,
      roads: new Set(
        materializeCuratedTrip(model, { tripId: trip.id, seed: 42 }).route.roadIds,
      ),
    }));

    for (let i = 0; i < routes.length; i += 1) {
      for (let j = i + 1; j < routes.length; j += 1) {
        const a = routes[i];
        const b = routes[j];
        let intersection = 0;
        for (const roadId of a.roads) {
          if (b.roads.has(roadId)) intersection += 1;
        }
        const union = new Set([...a.roads, ...b.roads]).size;
        expect(intersection / union, `${a.id} vs ${b.id}`).toBeLessThan(0.25);
      }
    }
  });

  it("never mutates Chicago while snapping or routing", () => {
    const before = JSON.stringify(model.city);
    materializeCuratedTrip(model, {
      tripId: "soldier-field-to-navy-pier",
      seed: 42,
    });
    expect(JSON.stringify(model.city)).toBe(before);
  });

  it("requires Metro so curated anchors cannot silently snap to a smaller boundary", () => {
    expect(() =>
      materializeCuratedTrip(chicagoModel(3), {
        tripId: "soldier-field-to-navy-pier",
        seed: 42,
      }),
    ).toThrow(/require Metro Chicago/);
  });

  it("looks up trip metadata without exposing controller policy", () => {
    const trip = curatedTrip("streeterville-to-south-loop");
    expect(trip.label).toBe("Streeterville → South Loop");
    expect(Object.keys(trip)).not.toContain("controller");
    expect(Object.keys(trip)).not.toContain("priority");
  });

  it("completes every curated trip comfortably inside the live horizon", () => {
    // The product contract: a run is watched in 30-60 s of wall clock
    // (PLAYBACK_STEPS_PER_TICK = 8x), so every trip must ARRIVE well inside the
    // 600 s simulated horizon. A trip that needs the whole horizon leaves the
    // user with an unfinished run — which is what the six were re-curated for.
    //
    // Worst case on purpose: rush-hour demand, the app's default driver and
    // controller (tourist + adaptive), the app's default seed. Measured
    // arrival times (seed 42, rush-hour) are 227-400 s; the 540 s bound is the
    // "comfortably inside" line, not the measured values.
    const arrival = (tripId: (typeof CURATED_TRIP_IDS)[number]): number => {
      const seed = 42;
      const durationMs = 540_000;
      const trafficLevel = "rush-hour" as const;
      const challenge = materializeChallengeTrip(model, tripId, seed);
      const scenario = buildChallengeScenario({
        tripId,
        trafficLevel,
        driver: "tourist",
        seed,
        durationMs,
      });
      const world = resolveScenarioWorld(model, challenge.trip, scenario);
      const spawns: ScheduledSpawn[] = [
        challenge.spawn,
        ...generateDemand({ city: model.city, level: trafficLevel, seed: world.demandSeed, durationMs }),
      ];
      const engine = createEngine({
        city: model.city,
        controller: createAdaptiveController(),
        spawns,
        driver: "tourist",
        incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
      });
      const egoAt = () =>
        engine.egoVehicleId === null
          ? undefined
          : engine.traffic.vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId);
      for (let t = 1_000; t <= durationMs; t += 1_000) {
        runEngine(engine, t);
        const ego = egoAt();
        if (ego && ego.state === "arrived") {
          return engine.traffic.timeMs;
        }
      }
      return -1;
    };

    for (const tripId of CURATED_TRIP_IDS) {
      const arrivalMs = arrival(tripId);
      expect(arrivalMs, `${tripId} arrived`).toBeGreaterThan(0);
      expect(arrivalMs, `${tripId} inside the horizon`).toBeLessThan(540_000);
    }
  }, 900_000);
});
