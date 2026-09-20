/**
 * Phase 3.3 presentation guards: road hierarchy, block fabric, polygon debris
 * rules, and the product shell's structural contracts.
 *
 * These are the rules that keep the map coherent: a stub stays out of mid zoom,
 * a ramp never does, a sliver never becomes "geography", and the chrome keeps
 * its one-surface discipline.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isExpresswayClass, roadPresentationClass, pieceCrossesWater, DETAIL_MAX_LENGTH_M } from "@/render/road-hierarchy";
import { buildShowcaseGeoJson } from "@/render/map-geojson";
import { buildChicagoStyle, AREA_MIN } from "@/render/chicago-style";
import { buildVehicleLayers } from "@/render/deck-layers";
import { carriagewayPairs } from "@/render/road-presentation";
import { buildPathIndex } from "@/cities/paths";
import { deriveContextualControls } from "@/render/contextual-controls";
import { createEngine, runEngine } from "@/sim/engine";
import { createFixedController } from "@/controllers/fixed";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { chicagoModel } from "./chicago-support";

const model = chicagoModel(2);

describe("road presentation hierarchy", () => {
  it("classifies the network the way the map draws it", () => {
    expect(roadPresentationClass({ osmClass: "motorway", length: 400 })).toBe("primary");
    expect(roadPresentationClass({ osmClass: "trunk", length: 400 })).toBe("primary");
    expect(roadPresentationClass({ osmClass: "secondary", name: "West Madison Street", length: 90 })).toBe("primary");
    // Ramps are structure, however short: they stay visible.
    expect(roadPresentationClass({ osmClass: "motorway_link", length: 40 })).toBe("primary");
    expect(roadPresentationClass({ osmClass: "trunk_link", length: 30 })).toBe("primary");
    // A surface-street link is a turn channel, not an expressway ramp.
    expect(roadPresentationClass({ osmClass: "secondary_link", length: 30 })).toBe("hidden");
    expect(roadPresentationClass({ osmClass: "secondary_link", name: "West Harrison Street", length: 80 })).toBe("hidden");
    // A long named connector can be a real street; unnamed routing plumbing
    // stays hidden even when OSM stretches it across most of a block.
    expect(roadPresentationClass({ osmClass: "secondary_link", length: 180 })).toBe("hidden");
    expect(roadPresentationClass({ osmClass: "secondary_link", name: "Connector Road", length: 180 })).toBe("secondary");
    expect(
      roadPresentationClass({
        osmClass: "secondary_link",
        length: 70,
        bridgeStructure: true,
      }),
    ).toBe("secondary");
    expect(isExpresswayClass("secondary_link")).toBe(false);
    expect(isExpresswayClass("motorway_link")).toBe(true);
    // Ordinary streets are secondary; short unnamed stubs are hidden visual topology.
    expect(roadPresentationClass({ osmClass: "residential", name: "West Polk Street", length: 80 })).toBe("secondary");
    expect(roadPresentationClass({ osmClass: "tertiary", length: 200 })).toBe("secondary");
    expect(roadPresentationClass({ osmClass: "tertiary", length: DETAIL_MAX_LENGTH_M - 5 })).toBe("hidden");
    // A named short piece is a real street: it stays.
    expect(roadPresentationClass({ osmClass: "tertiary", name: "Honoré Street", length: 20 })).toBe("secondary");
  });

  it("never renders micro-connectors, while real expressway ramps stay visible", () => {
    const geo = buildShowcaseGeoJson(model);
    const style = buildChicagoStyle(geo);
    const byId = new Map(style.layers.map((layer) => [layer.id, layer]));

    expect(byId.has("roads-detail")).toBe(false);

    for (const id of ["roads-highway", "roads-highway-casing"] as const) {
      const layer = byId.get(id)! as { minzoom?: number };
      expect(layer.minzoom ?? 0).toBeLessThanOrEqual(1);
    }
    const ramp = geo.roadsHighway.features.find((feature) =>
      ["motorway_link", "trunk_link"].includes(String(feature.properties.osmClass)),
    );
    expect(ramp).toBeTruthy();
  });

  it("keeps routing intact while hiding a piece from the map", () => {
    // Presentation and simulation stay separate: a detail piece still exists as
    // routed roads with capacity, it simply draws later. The audit found the
    // medium-scale network is clean enough that detail is nearly empty, so this
    // walks every scale rather than assuming one.
    const hidden = [];
    for (let scale = 0; scale < 5; scale += 1) {
      for (const piece of chicagoModel(scale).streets) {
        const presentation = roadPresentationClass(piece);
        if (presentation === "hidden") {
          hidden.push({ scale, piece });
        }
      }
    }
    for (const { scale, piece } of hidden.slice(0, 25)) {
      const city = chicagoModel(scale).city;
      expect(piece.roadIds.length).toBeGreaterThan(0);
      for (const roadId of piece.roadIds) {
        expect(city.roads[roadId]).toBeTruthy();
        expect(city.roads[roadId].capacity).toBeGreaterThan(0);
      }
    }
    // Surface-street links do not leak into any static road source. Pin this
    // against Metro, where the imported Chicago asset actually contains them,
    // so the assertion cannot pass vacuously on a smaller crop.
    const metro = chicagoModel(4);
    expect(metro.streets.some((piece) => piece.osmClass === "secondary_link")).toBe(true);
    const metroGeo = buildShowcaseGeoJson(metro);
    const visible = [
      ...metroGeo.roadsLocal.features,
      ...metroGeo.roadsArterial.features,
      ...metroGeo.roadsHighway.features,
    ];
    // Unnamed downtown turn channels never leak back into cartography.
    const visibleSecondaryLinks = visible.filter(
      (feature) => String(feature.properties.osmClass) === "secondary_link",
    );
    expect(
      visibleSecondaryLinks.every((feature) => String(feature.properties.name ?? "").length > 0),
    ).toBe(true);
  }, 10_000);

  it("gives bridge material only to pieces that cross water", () => {
    const geo = buildShowcaseGeoJson(model);
    const bridgePieces = model.streets.filter((piece) => piece.bridgeStructure);
    expect(bridgePieces.length).toBeGreaterThan(50);
    // Fewer bridges than bridge-tagged pieces: the viaducts and overpasses are
    // drawn as their own road class instead of as thick scraps.
    expect(geo.bridges.features.length).toBeGreaterThan(0);
    expect(geo.bridges.features.length).toBeLessThan(bridgePieces.length);
    for (const feature of geo.bridges.features) {
      const piece = model.streets.find((entry) => entry.streetId === feature.properties.streetId)!;
      expect(pieceCrossesWater(piece.points, model.water)).toBe(true);
    }
  });
});

describe("ego vehicle presentation stays coherent", () => {
  it("renders the supplied ego in map space without reintroducing a fleet contract", () => {
    const ego = [{
      id: 0,
      roadId: 0,
      type: "car" as const,
      state: "moving" as const,
      x: model.city.intersections[0].x,
      y: model.city.intersections[0].y,
      headingRadians: 0,
      blockedWaitMs: 0,
      fade: 1,
      queueRank: -1,
    }];
    const icons = {
      atlas: "data:image/png;base64,",
      mapping: {
        car: { x: 0, y: 0, width: 128, height: 64, anchorX: 64, anchorY: 32, mask: false },
        truck: { x: 128, y: 0, width: 128, height: 64, anchorX: 64, anchorY: 32, mask: false },
        bicycle: { x: 256, y: 0, width: 128, height: 64, anchorX: 64, anchorY: 32, mask: false },
      },
    } as never;
    const layers = buildVehicleLayers(model.projection, ego, icons, 16);
    const car = layers.find((layer) => layer.id === "vehicle-body-car") as unknown as {
      props: { data: unknown[]; sizeUnits: string; getSize: number; sizeMinPixels: number };
    };
    expect(car.props.data).toHaveLength(1);
    expect(car.props.sizeUnits).toBe("meters");
    expect(car.props.getSize).toBeGreaterThan(0);
    expect(car.props.sizeMinPixels).toBeLessThan(20);
  });
});

describe("signal presentation stays simulation-first", () => {
  it("never places a control on a hidden micro-connector", () => {
    // Issue #26 replacement for the old plan-arm guard: whatever the ego is
    // about to meet, the road carrying it must be one the presentation draws.
    const metro = chicagoModel(4);
    const { spawn } = materializeChallengeTrip(metro, "united-center-to-navy-pier", 5);
    const engine = createEngine({
      city: metro.city,
      controller: createFixedController(),
      spawns: [spawn],
    });
    runEngine(engine, 5_000);
    const snapshot = buildPresentationSnapshot(engine, 0, "united-center-to-navy-pier");
    const controls = deriveContextualControls({
      model: metro,
      indexes: metro.directedPaths.map((points) => (points ? buildPathIndex(points) : null)),
      laneOffsets: metro.city.roads.map(() => 0),
      trip: snapshot.trip,
      ego: snapshot.ego ? { roadId: snapshot.ego.roadId, progress: snapshot.ego.progress } : null,
      routeControls: snapshot.routeControls,
    });
    expect(controls.length).toBeGreaterThanOrEqual(0);
    const pairs = carriagewayPairs(metro);
    const route = snapshot.trip?.routeRoadIds ?? [];
    for (const control of controls) {
      const incoming = route.find((roadId) => metro.city.roads[roadId]?.to === control.intersectionId);
      expect(incoming).toBeDefined();
      const pieceIndex = pairs.pieceOf[incoming!] ?? -1;
      if (pieceIndex >= 0) {
        expect(roadPresentationClass(metro.streets[pieceIndex])).not.toBe("hidden");
      }
    }
  });

  it("challenge mode renders contextual controls, never the old signal stack", () => {
    // Issue #26: the citywide/route-wide gate + head layers are gone from
    // production. The map component builds contextual controls instead, and the
    // old modules no longer exist to be wired back in.
    const map = readFileSync(new URL("../components/CityMap.tsx", import.meta.url), "utf8");
    expect(map).toContain("buildControlLayers");
    expect(map).toContain("deriveContextualControls");
    expect(map).not.toContain("buildSignalLayers");
    expect(map).not.toContain("buildSignalPlans");
    expect(map).not.toContain("createSignalSprites");
    expect(() => readFileSync(new URL("../render/signal-sprites.ts", import.meta.url), "utf8")).toThrow();
  });
});

describe("block fabric", () => {
  const geo = buildShowcaseGeoJson(model);

  it("derives valid, substantial blocks", () => {
    expect(geo.blocks.features.length).toBeGreaterThan(50);
    for (const feature of geo.blocks.features) {
      const ring = feature.geometry.coordinates[0];
      expect(ring.length).toBeGreaterThanOrEqual(4);
      // Closed ring: MapLibre needs first === last.
      expect(ring[0]).toEqual(ring[ring.length - 1]);
      expect(Number(feature.properties.areaM2)).toBeGreaterThanOrEqual(600);
    }
  });

  it("draws blocks before water, parks and roads so the fabric reads as carved", () => {
    const style = buildChicagoStyle(geo);
    const ids = style.layers.map((layer) => layer.id);
    const at = (id: string) => ids.indexOf(id);
    expect(at("blocks")).toBeGreaterThan(at("land"));
    expect(at("blocks")).toBeLessThan(at("water"));
    expect(at("blocks")).toBeLessThan(at("parks"));
    expect(at("blocks")).toBeLessThan(at("roads-local"));
    expect(at("blocks-edge")).toBe(-1);
  });
});

describe("detail hierarchy by zoom", () => {
  const style = buildChicagoStyle(buildShowcaseGeoJson(model));
  const byId = new Map(style.layers.map((layer) => [layer.id, layer]));
  const minzoom = (id: string) => (byId.get(id) as { minzoom?: number } | undefined)?.minzoom ?? 0;

  it("uses block fabric instead of raw building footprints", () => {
    expect(minzoom("blocks")).toBeGreaterThan(0);
    expect(byId.has("buildings-prominent")).toBe(false);
    expect(byId.has("buildings")).toBe(false);
    expect(byId.has("buildings-outline")).toBe(false);
  });

  it("keeps green and blue out until they are meaningful", () => {
    expect(AREA_MIN.parkFar).toBeGreaterThan(AREA_MIN.parkMid);
    expect(AREA_MIN.parkMid).toBeGreaterThan(AREA_MIN.parkClose);
    expect(AREA_MIN.waterFar).toBeGreaterThan(AREA_MIN.waterMid);
    expect(AREA_MIN.waterMid).toBeGreaterThanOrEqual(AREA_MIN.waterClose);
    // Even at close zoom a scrap has a floor: no zero-area confetti.
    expect(AREA_MIN.parkClose).toBeGreaterThanOrEqual(500);
    expect(AREA_MIN.waterClose).toBeGreaterThanOrEqual(300);
  });
});

describe("product shell contracts", () => {
  const chrome = readFileSync(new URL("../components/SimChrome.tsx", import.meta.url), "utf8");
  // Issue #25 renamed the surface: the trip HUD is now the primary instrument.
  const tripHud = readFileSync(new URL("../components/TripHUD.tsx", import.meta.url), "utf8");
  const dock = readFileSync(new URL("../components/IncidentBar.tsx", import.meta.url), "utf8");
  const map = readFileSync(new URL("../components/CityMap.tsx", import.meta.url), "utf8");

  it("names the real city in the run identity, never the rejected one", () => {
    expect(chrome).toContain("Chicago");
    expect(chrome).not.toContain("Central");
  });

  it("groups the HUD into one surface and has no sparkline", () => {
    expect(tripHud).toContain("surface");
    expect(tripHud).not.toContain("sparkline");
    expect(tripHud).toContain("value-num");
    // One panel, not a stack of loose rows: a single wrapper carries the surface.
    expect(tripHud.match(/className="surface/g)?.length).toBe(1);
  });

  it("keeps the dock to one line per action", () => {
    expect(dock).toContain("whitespace-nowrap");
    // The acknowledgement lives inside the same surface as the buttons.
    const surface = dock.indexOf('className="surface');
    const ack = dock.indexOf("aria-live");
    const buttons = dock.indexOf("INCIDENTS.map");
    expect(surface).toBeGreaterThan(-1);
    expect(ack).toBeGreaterThan(surface);
    expect(buttons).toBeGreaterThan(ack);
  });

  it("keeps the controller switchable and the OSM attribution visible", () => {
    expect(chrome).toContain("CONTROLLER_OPTIONS");
    expect(chrome).toContain("Segmented");
    expect(map.toLowerCase()).toContain("attribution");
  });

  it("keeps onboarding traffic-free even while the worker is prewarmed", () => {
    expect(map).toContain("trafficHiddenRef.current || !liveRef.current");
    expect(map).toContain("visiblePlates = showDynamicMapState ? incidents.extras.plates : []");
  });

  it("swaps every presentation source when the city scale changes", () => {
    for (const source of [
      "blocks",
      "water",
      "parks",
      "roads-local",
      "roads-arterial",
      "roads-highway",
      "bridges",
      "labels",
      "street-labels",
    ]) {
      expect(map).toContain(`setData("${source}"`);
    }
  });
});
