/**
 * Issue #25 — route-first presentation.
 *
 * The route is the product: one deterministic classifier decides its colours,
 * its geometry is the ego's CURRENT route, the destination is a map-anchored
 * marker, and everything geographic scales in map metres.
 */
import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import { createEngine, runEngine } from "@/sim/engine";
import { buildPresentationSnapshot, type PresentationRoadTraffic } from "@/worker/presentation-snapshot";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { metricToLngLat } from "@/cities/map-model";
import {
  ROUTE_TRAFFIC_COLORS,
  ROUTE_TRAFFIC_RULES,
  classifyRoadTraffic,
  classifySnapshotRoads,
} from "@/render/route-traffic";
import { buildRouteSegments, trimPathFrom } from "@/render/route-path";
import { buildDestinationLayers, buildRouteLayers } from "@/render/route-layers";
import { createDestinationSprites } from "@/render/destination-sprite";
import { ROUTE_SCALE, DESTINATION_SCALE } from "@/render/scale";
import { chicagoModel } from "./chicago-support";
import { tripHudView, formatDistance, formatSpeed, tripStateLabel } from "@/components/ui-model";

function road(partial: Partial<PresentationRoadTraffic>): PresentationRoadTraffic {
  return {
    roadId: 1,
    occupancy: 0,
    capacity: 10,
    vehicleCount: 0,
    queuedCount: 0,
    maxBlockedWaitMs: 0,
    ...partial,
  };
}

describe("route traffic classification", () => {
  it("classifies by the stable quantities, never by controller or clock", () => {
    expect(classifyRoadTraffic(undefined)).toBe("free");
    expect(classifyRoadTraffic(road({ occupancy: 1, queuedCount: 0 }))).toBe("free");
    // Occupancy ratio crosses into slowdown, then congestion.
    expect(classifyRoadTraffic(road({ occupancy: 6, capacity: 10 }))).toBe("slowed");
    expect(classifyRoadTraffic(road({ occupancy: 9, capacity: 10 }))).toBe("congested");
    // Queue depth alone is enough.
    expect(classifyRoadTraffic(road({ occupancy: 1, queuedCount: ROUTE_TRAFFIC_RULES.slowedQueued }))).toBe("slowed");
    expect(classifyRoadTraffic(road({ occupancy: 1, queuedCount: ROUTE_TRAFFIC_RULES.congestedQueued }))).toBe("congested");
    // Longest blocked wait alone is enough.
    expect(classifyRoadTraffic(road({ occupancy: 0, maxBlockedWaitMs: ROUTE_TRAFFIC_RULES.slowedWaitMs }))).toBe("slowed");
    expect(classifyRoadTraffic(road({ occupancy: 0, maxBlockedWaitMs: ROUTE_TRAFFIC_RULES.congestedWaitMs }))).toBe("congested");
    // A closed road can never be free.
    expect(classifyRoadTraffic(road({ occupancy: 0 }), true)).toBe("congested");
    expect(classifyRoadTraffic(undefined, true)).toBe("congested");
  });

  it("gives absent sparse roads the free baseline", () => {
    const classes = classifySnapshotRoads({
      sequence: 0,
      timeMs: 0,
      controller: "fixed",
      ego: null,
      roadTraffic: [road({ roadId: 7, occupancy: 9, capacity: 10 })],
      routeControls: [],
      trip: null,
      roadConditions: [],
      incidents: [],
    });
    expect(classes.get(7)).toBe("congested");
    // Road 8 is missing from the frame: free, not unknown, not red.
    expect(classes.has(8)).toBe(false);
  });

  it("is deterministic and keeps one colour per class", () => {
    const entries = [road({ roadId: 1, occupancy: 5 }), road({ roadId: 2, queuedCount: 6 })];
    const first = entries.map((entry) => classifyRoadTraffic(entry));
    const second = entries.map((entry) => classifyRoadTraffic(entry));
    expect(first).toEqual(second);
    expect(first).toEqual(["free", "congested"]);
    expect(ROUTE_TRAFFIC_COLORS.free).not.toEqual(ROUTE_TRAFFIC_COLORS.slowed);
    expect(ROUTE_TRAFFIC_COLORS.slowed).not.toEqual(ROUTE_TRAFFIC_COLORS.congested);
    // Blue reads blue and red reads red: sanity on the channels.
    expect(ROUTE_TRAFFIC_COLORS.free[2]).toBeGreaterThan(ROUTE_TRAFFIC_COLORS.free[0]);
    expect(ROUTE_TRAFFIC_COLORS.congested[0]).toBeGreaterThan(ROUTE_TRAFFIC_COLORS.congested[2]);
  });
});

describe("route geometry", () => {
  const model = chicagoModel(4);

  function tripFrame(seed = 42) {
    const { trip, spawn } = materializeChallengeTrip(model, "united-center-to-navy-pier", seed);
    const engine = createEngine({
      city: model.city,
      controller: createFixedController(),
      spawns: [spawn],
    });
    runEngine(engine, 600);
    return { trip, snapshot: buildPresentationSnapshot(engine, 0, trip.trip.id) };
  }

  it("trims the current road at the car and keeps the tail", () => {
    const straight: [number, number][] = [
      [0, 0],
      [100, 0],
    ];
    expect(trimPathFrom(straight, 0)).toEqual(straight);
    const half = trimPathFrom(straight, 50);
    expect(half.length).toBeGreaterThanOrEqual(2);
    expect(half[0][0]).toBeCloseTo(50, 6);
    expect(half[half.length - 1][0]).toBeCloseTo(100, 6);
    // Beyond the end: the tail collapses to the final point, never throws.
    const beyond = trimPathFrom(straight, 500);
    expect(beyond[beyond.length - 1][0]).toBeCloseTo(100, 6);
  });

  it("draws the ego's CURRENT route, in driving order", () => {
    const { snapshot } = tripFrame();
    const trip = snapshot.trip;
    expect(trip).not.toBeNull();
    const segments = buildRouteSegments(model, trip!, snapshot.ego, new Map());
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.length).toBeLessThanOrEqual(trip!.routeRoadIds.length);
    const routeSet = new Set(trip!.routeRoadIds);
    for (const segment of segments) {
      expect(routeSet.has(segment.roadId)).toBe(true);
      expect(segment.path.length).toBeGreaterThanOrEqual(2);
      expect(segment.traffic).toBe("free"); // no aggregates supplied -> baseline
    }
    // The order is the remaining route's order.
    const expected = trip!.routeRoadIds.slice(trip!.routeIndex, trip!.routeIndex + segments.length);
    expect(segments.map((segment) => segment.roadId)).toEqual(expected);
  });

  it("repaints from the payload when the ego is rerouted", () => {
    const { snapshot } = tripFrame();
    const trip = snapshot.trip!;
    const original = buildRouteSegments(model, trip, snapshot.ego, new Map());
    // An incident reroute changes the vehicle's route; the payload carries it.
    const detoured = { ...trip, routeRoadIds: [...trip.routeRoadIds.slice(0, trip.routeIndex), ...trip.routeRoadIds.slice(0, 3).map((id) => id + 1)], routeIndex: trip.routeIndex };
    const rerouted = buildRouteSegments(model, detoured, snapshot.ego, new Map());
    expect(rerouted.map((segment) => segment.roadId)).toEqual(detoured.routeRoadIds.slice(detoured.routeIndex));
    expect(original.map((segment) => segment.roadId)).not.toEqual(rerouted.map((segment) => segment.roadId));
  });

  it("colours segments from the classifier, deterministically", () => {
    const { snapshot } = tripFrame();
    const trip = snapshot.trip!;
    const target = trip.routeRoadIds[trip.routeIndex];
    const classes = new Map([[target, "congested" as const]]);
    const segments = buildRouteSegments(model, trip, snapshot.ego, classes);
    expect(segments[0].traffic).toBe("congested");
    expect(segments.slice(1).every((segment) => segment.traffic === "free")).toBe(true);
  });
});

describe("route-first layers", () => {
  const model = chicagoModel(4);

  it("sizes the route and destination in map metres with pixel floors", () => {
    const segments = [
      {
        roadId: 1,
        path: [
          [0, 0],
          [1, 1],
        ] as [number, number][],
        traffic: "free" as const,
      },
    ];
    const routeLayers = buildRouteLayers(segments);
    expect(routeLayers.map((layer) => layer.id)).toEqual(["route-casing", "route-core"]);
    for (const layer of routeLayers) {
      const props = (layer as unknown as { props: Record<string, unknown> }).props;
      expect(props.widthUnits).toBe("meters");
      expect(props.widthMinPixels).toBeGreaterThan(0);
      expect(props.widthMaxPixels).toBeGreaterThan(props.widthMinPixels as number);
    }
    const core = (routeLayers[1] as unknown as { props: Record<string, unknown> }).props;
    expect(core.getWidth).toBe(ROUTE_SCALE.coreWidthM);
    expect(ROUTE_SCALE.casingWidthM).toBeGreaterThan(ROUTE_SCALE.coreWidthM);

    const sprites = { atlas: "data:,", mapping: { "destination-pin": { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: false } } };
    const destLayers = buildDestinationLayers(model.projection, { x: 100, y: 100, completed: false }, sprites);
    expect(destLayers.map((layer) => layer.id)).toEqual(["destination-ring", "destination-pin"]);
    const pin = (destLayers[1] as unknown as { props: Record<string, unknown> }).props;
    expect(pin.sizeUnits).toBe("meters");
    expect(pin.getSize).toBe(DESTINATION_SCALE.sizeM);
    expect(pin.sizeMinPixels).toBeGreaterThan(0);
  });

  it("places the destination pin on the destination intersection", () => {
    const { trip, snapshot } = (() => {
      const { trip, spawn } = materializeChallengeTrip(model, "united-center-to-navy-pier", 7);
      const engine = createEngine({ city: model.city, controller: createFixedController(), spawns: [spawn] });
      runEngine(engine, 300);
      return { trip, snapshot: buildPresentationSnapshot(engine, 0, trip.trip.id) };
    })();
    const node = model.city.intersections[trip.destinationIntersectionId];
    const [lng, lat] = metricToLngLat(model.projection, node.x, node.y);
    expect(Number.isFinite(lng)).toBe(true);
    expect(Number.isFinite(lat)).toBe(true);
    expect(snapshot.trip?.destinationIntersectionId).toBe(trip.destinationIntersectionId);
    // The pin disappears only when the frame has no trip.
    expect(buildDestinationLayers(model.projection, null, null)).toEqual([]);
  });

  it("has no sprite when there is no DOM, and never draws a dot fallback", () => {
    const savedDocument = globalThis.document;
    // @ts-expect-error deliberate: simulate a non-DOM environment
    delete globalThis.document;
    expect(createDestinationSprites()).toBeNull();
    globalThis.document = savedDocument;
  });
});

describe("trip HUD", () => {
  it("reports exactly the payload's numbers", () => {
    const view = tripHudView({
      trip: {
        tripId: "united-center-to-navy-pier",
        originIntersectionId: 1,
        destinationIntersectionId: 2,
        routeRoadIds: [1, 2, 3, 4],
        routeIndex: 1,
        tripTimeMs: 134_000,
        waitTimeMs: 21_000,
        distanceRemainingM: 3_250,
        distanceTravelledM: 1_100,
        intersectionsCleared: 1,
        completed: false,
        estimatedRemainingMs: 480_000,
      },
      egoState: "queued",
      egoSpeedMps: 0,
    });
    expect(view).not.toBeNull();
    expect(view?.state).toBe("Stopped");
    expect(view?.tripName.length).toBeGreaterThan(0);
    const byLabel = new Map(view?.rows.map((row) => [row.label, row.value]));
    expect(byLabel.get("Elapsed")).toBe("2m 14s");
    expect(byLabel.get("Remaining")).toBe("3.3 km");
    expect(byLabel.get("Stopped")).toBe("21.0s");
    expect(byLabel.get("Cleared")).toBe("1 / 4");
    expect(byLabel.get("Est. remaining")).toBe("8m 00s");
    expect(tripHudView({ trip: null, egoState: null, egoSpeedMps: 0 })).toBeNull();
  });

  it("labels trip state consistently", () => {
    expect(tripStateLabel("moving", false)).toBe("Moving");
    expect(tripStateLabel("queued", false)).toBe("Stopped");
    expect(tripStateLabel("pending", false)).toBe("Waiting");
    expect(tripStateLabel("arrived", true)).toBe("Arrived");
    // Completion wins even if a stale ego state arrives.
    expect(tripStateLabel("moving", true)).toBe("Arrived");
    expect(formatDistance(740)).toBe("740 m");
    expect(formatDistance(0)).toBe("0 m");
    expect(formatSpeed(8.4)).toBe("30 km/h");
  });

  it("reports completion when the trip finishes", () => {
    const view = tripHudView({
      trip: {
        tripId: "x",
        originIntersectionId: 1,
        destinationIntersectionId: 2,
        routeRoadIds: [1],
        routeIndex: 1,
        tripTimeMs: 900_000,
        waitTimeMs: 60_000,
        distanceRemainingM: 0,
        distanceTravelledM: 5_000,
        intersectionsCleared: 1,
        completed: true,
        estimatedRemainingMs: 0,
      },
      egoState: "arrived",
      egoSpeedMps: 0,
    });
    expect(view?.completed).toBe(true);
    expect(view?.state).toBe("Arrived");
    expect(view?.rows.find((row) => row.label === "Remaining")?.value).toBe("0 m");
    // A finished trip has nothing left to estimate.
    expect(view?.rows.find((row) => row.label === "Est. remaining")?.value).toBe("—");
  });
});
