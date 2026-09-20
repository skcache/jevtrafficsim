import { describe, expect, it } from "vitest";
import {
  CURATED_TRIPS,
  CURATED_TRIP_IDS,
  curatedTrip,
  materializeCuratedTrip,
} from "@/cities/chicago-trips";
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
      tripId: "united-center-to-navy-pier",
      seed: 42,
    });
    expect(JSON.stringify(model.city)).toBe(before);
  });

  it("requires Metro so curated anchors cannot silently snap to a smaller boundary", () => {
    expect(() =>
      materializeCuratedTrip(chicagoModel(3), {
        tripId: "united-center-to-navy-pier",
        seed: 42,
      }),
    ).toThrow(/require Metro Chicago/);
  });

  it("looks up trip metadata without exposing controller policy", () => {
    const trip = curatedTrip("streeterville-to-united-center");
    expect(trip.label).toBe("Streeterville → United Center");
    expect(Object.keys(trip)).not.toContain("controller");
    expect(Object.keys(trip)).not.toContain("priority");
  });
});
