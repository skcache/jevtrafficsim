import { describe, expect, it } from "vitest";
import {
  CHALLENGE_CITY_SIZE,
  CHALLENGE_SCALE_INDEX,
  CURATED_TRIPS,
  DEFAULT_CURATED_TRIP_ID,
  challengeScenarioKey,
  materializeCuratedTrip,
  type MaterializedCuratedTrip,
} from "@/cities/curated-trips";
import { chicagoModel } from "./chicago-support";

const model = chicagoModel(CHALLENGE_SCALE_INDEX);

function routeDiagnostics(run: MaterializedCuratedTrip): string {
  return JSON.stringify({
    id: run.trip.id,
    distanceKm: Number((run.metadata.distanceM / 1000).toFixed(2)),
    freeFlowMin: Number((run.metadata.freeFlowTimeMs / 60_000).toFixed(2)),
    hops: run.route.roadIds.length,
    originSnapM: Math.round(run.originSnapDistanceM),
    destinationSnapM: Math.round(run.destinationSnapDistanceM),
    roadKinds: run.metadata.roadKinds,
    roadClasses: run.metadata.roadClassFamilies,
    corridorKinds: run.metadata.corridorKinds,
    controls: run.metadata.controlledIntersections,
    signals: run.metadata.signalIntersections,
    stops: run.metadata.stopIntersections,
    bridges: run.metadata.bridgeNames,
    names: run.metadata.namedRoads.slice(0, 12),
    coverage: run.metadata.coverageKinds,
  });
}

function materializeAll(seed = 42) {
  return CURATED_TRIPS.map((trip) =>
    materializeCuratedTrip(model, {
      tripId: trip.id,
      trafficLevel: "everyday",
      seed,
    }),
  );
}

describe("curated Chicago challenge trips", () => {
  it("ships exactly six stable, unique trips on Metro Chicago", () => {
    expect(CHALLENGE_SCALE_INDEX).toBe(4);
    expect(CHALLENGE_CITY_SIZE).toBe("large");
    expect(CURATED_TRIPS).toHaveLength(6);
    expect(new Set(CURATED_TRIPS.map((trip) => trip.id)).size).toBe(6);
    expect(DEFAULT_CURATED_TRIP_ID).toBe(CURATED_TRIPS[0].id);

    for (const trip of CURATED_TRIPS) {
      expect(trip.label).toContain("→");
      expect(trip.origin.label).not.toBe(trip.destination.label);
      expect(Number.isFinite(trip.origin.lon)).toBe(true);
      expect(Number.isFinite(trip.origin.lat)).toBe(true);
      expect(Number.isFinite(trip.destination.lon)).toBe(true);
      expect(Number.isFinite(trip.destination.lat)).toBe(true);
      expect(trip.camera.overviewPaddingM).toBeGreaterThan(0);
      expect(trip.camera.followZoom).toBeGreaterThanOrEqual(16);
    }
  });

  it("snaps every researched landmark onto nearby real road topology", () => {
    for (const run of materializeAll()) {
      expect(run.originSnapDistanceM, routeDiagnostics(run)).toBeLessThan(250);
      expect(run.destinationSnapDistanceM, routeDiagnostics(run)).toBeLessThan(250);
    }
  });

  it("keeps every trip non-trivial, controlled, and structurally varied", () => {
    for (const run of materializeAll()) {
      expect(run.route.roadIds.length, routeDiagnostics(run)).toBeGreaterThanOrEqual(8);
      expect(run.metadata.distanceM, routeDiagnostics(run)).toBeGreaterThan(1_000);
      expect(run.metadata.controlledIntersections, routeDiagnostics(run)).toBeGreaterThanOrEqual(3);
      expect(run.metadata.coverageKinds.length, routeDiagnostics(run)).toBeGreaterThanOrEqual(3);
    }
  });

  it("covers downtown streets, bridges/river approaches, and an expressway across the catalog", () => {
    const runs = materializeAll();
    const roadClasses = new Set(runs.flatMap((run) => run.metadata.roadClassFamilies));
    const roadKinds = new Set(runs.flatMap((run) => run.metadata.roadKinds));
    const corridorKinds = new Set(runs.flatMap((run) => run.metadata.corridorKinds));
    const bridgeTrips = runs.filter(
      (run) =>
        run.metadata.roadClassFamilies.includes("bridge") ||
        run.metadata.bridgeNames.length > 0,
    );

    expect(roadClasses.has("local")).toBe(true);
    expect(
      roadClasses.has("primary") || roadClasses.has("secondary") || roadClasses.has("tertiary"),
    ).toBe(true);
    expect(
      roadClasses.has("expressway") ||
        roadKinds.has("highway") ||
        corridorKinds.has("highway"),
      runs.map(routeDiagnostics).join("\n"),
    ).toBe(true);
    expect(bridgeTrips.length, runs.map(routeDiagnostics).join("\n")).toBeGreaterThanOrEqual(2);
  });

  it("materializes byte-identically for the same trip, traffic level, and seed", () => {
    for (const trip of CURATED_TRIPS) {
      const selection = { tripId: trip.id, trafficLevel: "rush-hour" as const, seed: 2026 };
      const first = materializeCuratedTrip(model, selection);
      const second = materializeCuratedTrip(model, selection);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first.scenarioKey).toBe(challengeScenarioKey(selection));
    }
  });

  it("keeps different trip ids materially different", () => {
    const runs = materializeAll();
    const signatures = runs.map((run) => run.route.roadIds.join(","));
    expect(new Set(signatures).size).toBe(CURATED_TRIPS.length);
  });

  it("never mutates the frozen city graph while resolving a trip", () => {
    const before = JSON.stringify(model.city);
    for (const trip of CURATED_TRIPS) {
      materializeCuratedTrip(model, {
        tripId: trip.id,
        trafficLevel: "light",
        seed: 7,
      });
    }
    expect(JSON.stringify(model.city)).toBe(before);
  });

  it("keeps controller identity out of the scenario fingerprint", () => {
    const selection = {
      tripId: DEFAULT_CURATED_TRIP_ID,
      trafficLevel: "everyday" as const,
      seed: 42,
    };
    expect(challengeScenarioKey(selection)).toBe(
      `${DEFAULT_CURATED_TRIP_ID}|everyday|42`,
    );
    expect(challengeScenarioKey(selection)).not.toContain("fixed");
    expect(challengeScenarioKey(selection)).not.toContain("adaptive");
    expect(challengeScenarioKey(selection)).not.toContain("jev");
  });
});
