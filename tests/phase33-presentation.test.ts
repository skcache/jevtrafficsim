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
import { buildSignalLayers, buildSignalPlans, buildVehicleLayers } from "@/render/deck-layers";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { carriagewayPairs } from "@/render/road-presentation";
import type { PresentationSnapshot, PresentationSignal } from "@/worker/presentation-snapshot";
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
    expect(roadPresentationClass({ osmClass: "secondary_link", name: "West Harrison Street", length: 80 })).toBe("secondary");
    // Long or grade-separated surface links are real road geometry. Hiding one
    // would leave a vehicle floating with no road under it.
    expect(roadPresentationClass({ osmClass: "secondary_link", length: 180 })).toBe("secondary");
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
    // Only junction-scale links disappear. Longer/structural surface links stay
    // visible so a live vehicle never floats without roadway support.
    expect(
      visible.some((feature) => String(feature.properties.osmClass) === "secondary_link"),
    ).toBe(true);
  });

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

describe("vehicle presentation stays coherent", () => {
  it("renders the full active fleet once individual vehicles are visible", () => {
    const vehicles = Array.from({ length: 24 }, (_, id) => ({
      id,
      roadId: 0,
      type: "car" as const,
      state: "moving" as const,
      x: model.city.intersections[0].x,
      y: model.city.intersections[0].y,
      headingRadians: 0,
      blockedWaitMs: 0,
      fade: 1,
      queueRank: -1,
    }));
    const icons = {
      atlas: "data:image/png;base64,",
      mapping: {
        car: { x: 0, y: 0, width: 128, height: 64, anchorX: 64, anchorY: 32, mask: false },
        truck: { x: 128, y: 0, width: 128, height: 64, anchorX: 64, anchorY: 32, mask: false },
        bicycle: { x: 256, y: 0, width: 128, height: 64, anchorX: 64, anchorY: 32, mask: false },
      },
    } as never;
    const layers = buildVehicleLayers(model.projection, vehicles, icons, 16);
    const car = layers.find((layer) => layer.id === "vehicle-body-car") as unknown as {
      props: { data: unknown[]; sizeUnits: string; getSize: number };
    };
    expect(car.props.data).toHaveLength(vehicles.length);
    expect(car.props.sizeUnits).toBe("meters");
    expect(car.props.getSize).toBeGreaterThan(0);
  });
});

describe("signal presentation stays simulation-first", () => {
  const indexes = buildDirectedPathIndexes(model);
  const plans = buildSignalPlans(model);

  it("never draws signal furniture on a hidden micro-connector", () => {
    const pairs = carriagewayPairs(model);
    for (const plan of plans.values()) {
      for (const arms of plan.groupArms) {
        for (const arm of arms) {
          const pieceIndex = pairs.pieceOf[arm.roadId] ?? -1;
          if (pieceIndex < 0) {
            continue;
          }
          expect(roadPresentationClass(model.streets[pieceIndex])).not.toBe("hidden");
        }
      }
    }
  });

  it("draws one colored state gate per physical approach arm", () => {
    const entry = [...plans.entries()].find(([, plan]) => plan.groupIncoming.length >= 2)!;
    const signals: PresentationSignal[] = [
      { intersectionId: entry[0], phaseIndex: 0, stage: "green" },
    ];
    const snapshot = { sequence: 1, timeMs: 1000, vehicles: [], signals } as unknown as PresentationSnapshot;
    const sprites = {
      atlas: "data:image/png;base64,",
      mapping: Object.fromEntries(
        ["signal-red", "signal-yellow", "signal-green"].map((id) => [
          id,
          { x: 0, y: 0, width: 10, height: 10, anchorX: 5, anchorY: 5, mask: false },
        ]),
      ),
    } as never;
    const layers = buildSignalLayers(model.projection, model, snapshot, plans, indexes, 17.5, sprites);
    const ids = layers.map((layer) => layer.id).sort();
    expect(ids).toEqual(["signals-heads", "signals-state-gate-backing", "signals-state-gates"]);
    const bars = (layers.find((layer) => layer.id === "signals-state-gates") as unknown as {
      props: { data: unknown[] };
    }).props.data;
    const heads = (layers.find((layer) => layer.id === "signals-heads") as unknown as {
      props: { data: unknown[] };
    }).props.data;
    // State gates and optional housings share the same deduped physical arms.
    expect(bars.length).toBe(heads.length);
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
  const metrics = readFileSync(new URL("../components/MetricsHUD.tsx", import.meta.url), "utf8");
  const dock = readFileSync(new URL("../components/IncidentBar.tsx", import.meta.url), "utf8");
  const map = readFileSync(new URL("../components/CityMap.tsx", import.meta.url), "utf8");

  it("names the real city in the run identity, never the rejected one", () => {
    expect(chrome).toContain("Chicago");
    expect(chrome).not.toContain("Central");
  });

  it("groups the metrics into one surface and has no sparkline", () => {
    expect(metrics).toContain("surface");
    expect(metrics).not.toContain("sparkline");
    expect(metrics).toContain("tabular");
    // One panel, not a stack of loose rows: a single wrapper carries the surface.
    expect(metrics.match(/className="surface/g)?.length).toBe(1);
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
