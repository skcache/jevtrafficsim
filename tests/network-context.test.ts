import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { chicagoModel } from "./chicago-support";
import { networkSignalMarkers, buildNetworkSignalLayers } from "@/render/network-controls";
import { createControlSprites } from "@/render/control-sprites";
import { NETWORK_CONTROL_SCALE } from "@/render/scale";
import { roadPressure } from "@/render/congestion";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";

describe("citywide traffic-system presentation", () => {
  const model = chicagoModel(4);

  it("derives neutral signal markers from static Chicago controls", () => {
    const markers = networkSignalMarkers(model);
    const allSignals = model.city.intersections.filter(
      (node) => node.control === "signal",
    ).length;
    expect(markers.length).toBeGreaterThan(100);
    expect(markers.length).toBeLessThanOrEqual(allSignals);
    expect(new Set(markers.map((marker) => marker.intersectionId)).size).toBe(markers.length);
  });

  it("keeps network signals tiny and map-scaled", () => {
    const sprites = {
      atlas: "data:,",
      mapping: {
        "control-signal-neutral": {
          x: 0,
          y: 0,
          width: 8,
          height: 20,
          anchorX: 4,
          anchorY: 20,
          mask: false,
        },
      },
    } as never;
    const markers = networkSignalMarkers(model).slice(0, 5);
    const layers = buildNetworkSignalLayers(
      model.projection,
      markers,
      sprites,
      NETWORK_CONTROL_SCALE.minZoom,
    );
    expect(layers.map((layer) => layer.id)).toEqual(["network-signals"]);
    const props = (layers[0] as unknown as { props: Record<string, unknown> }).props;
    expect(props.sizeUnits).toBe("meters");
    expect(props.getSize).toBe(NETWORK_CONTROL_SCALE.signalHeightM);
    expect(props.sizeMinPixels).toBe(NETWORK_CONTROL_SCALE.minPixels);
    expect(props.sizeMaxPixels).toBe(NETWORK_CONTROL_SCALE.maxPixels);
    expect(NETWORK_CONTROL_SCALE.maxPixels).toBeLessThan(20);
  });

  it("hides network controls below the city-context zoom threshold", () => {
    expect(
      buildNetworkSignalLayers(
        model.projection,
        networkSignalMarkers(model).slice(0, 1),
        { atlas: "data:,", mapping: {} } as never,
        NETWORK_CONTROL_SCALE.minZoom - 0.1,
      ),
    ).toEqual([]);
    expect(createControlSprites).toBeTypeOf("function");
  });

  it("is not wired into the public map (issue #46)", () => {
    // The module still defines the citywide network, and the measurement
    // tooling still counts it - but the product must never build these layers:
    // 44 heads inside the follow viewport at zoom 15 is the forest of lights the
    // live view rejects. The map draws contextual controls instead.
    const map = readFileSync(new URL("../components/CityMap.tsx", import.meta.url), "utf8");
    expect(map).not.toContain("buildNetworkSignalLayers");
    expect(map).not.toContain("networkSignalMarkers");
    expect(map).not.toContain("NetworkSignalMarker");
    expect(map).toContain("deriveContextualControls");
  });

  it("shows moving dense traffic before a queue forms", () => {
    const snapshot = {
      roadTraffic: [
        {
          roadId: 12,
          occupancy: 8,
          capacity: 10,
          vehicleCount: 8,
          queuedCount: 0,
          maxBlockedWaitMs: 0,
          // The simulation's own flow state is what the overlay paints from.
          speedFactor: 0.5,
          severity: "slower",
        },
      ],
    } as unknown as PresentationSnapshot;
    const pressure = roadPressure(snapshot);
    expect(pressure).toHaveLength(1);
    expect(pressure[0].roadId).toBe(12);
    expect(pressure[0].occupancyRatio).toBeCloseTo(0.8, 6);
    expect(pressure[0].level).toBe("warm");
  });

  it("leaves lightly-loaded traffic NEUTRAL instead of painting it green", () => {
    // Traffic pressure is amber/red only: a road that is merely carrying a
    // moving car is not a problem, so it is not painted at all.
    const snapshot = {
      roadTraffic: [
        {
          roadId: 4,
          occupancy: 1,
          capacity: 10,
          vehicleCount: 1,
          queuedCount: 0,
          maxBlockedWaitMs: 0,
        },
      ],
    } as unknown as PresentationSnapshot;
    expect(roadPressure(snapshot)).toEqual([]);
  });

  it("leaves a truly empty road out of the sparse traffic overlay", () => {
    const snapshot = {
      roadTraffic: [
        {
          roadId: 4,
          occupancy: 0,
          capacity: 10,
          vehicleCount: 0,
          queuedCount: 0,
          maxBlockedWaitMs: 0,
        },
      ],
    } as unknown as PresentationSnapshot;
    expect(roadPressure(snapshot)).toEqual([]);
  });
});
