/**
 * Whole-city signal context (Issue #27).
 *
 * These tiny neutral heads are intentionally STATIC presentation metadata. They
 * show that Chicago contains a real signal network without shipping hundreds of
 * dynamic signal states across the worker boundary again. The ego's upcoming
 * signal is still rendered by the authoritative contextual-control path, where
 * its live red/yellow/green state matters.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer } from "@deck.gl/layers";
import type { MapModel, Projection } from "@/cities/map-model";
import { NETWORK_CONTROL_SCALE } from "./scale";
import type { ControlSpriteSet } from "./control-sprites";
import { toLngLat, type LngLat } from "./deck-layers";

export interface NetworkSignalMarker {
  readonly intersectionId: number;
  readonly x: number;
  readonly y: number;
}

export function networkSignalMarkers(model: MapModel): NetworkSignalMarker[] {
  return model.city.intersections
    .filter((intersection) => intersection.control === "signal")
    .map((intersection) => ({
      intersectionId: intersection.id,
      x: intersection.x,
      y: intersection.y,
    }));
}

export function buildNetworkSignalLayers(
  projection: Projection,
  markers: readonly NetworkSignalMarker[],
  sprites: ControlSpriteSet | null,
  zoom: number,
): Layer[] {
  if (!sprites || markers.length === 0 || zoom < NETWORK_CONTROL_SCALE.minZoom) {
    return [];
  }
  return [
    new IconLayer<NetworkSignalMarker>({
      id: "network-signals",
      data: markers as NetworkSignalMarker[],
      iconAtlas: sprites.atlas,
      iconMapping: sprites.mapping,
      getIcon: () => "control-signal-neutral",
      getPosition: (marker) => toLngLat(projection, marker.x, marker.y) as LngLat,
      getSize: NETWORK_CONTROL_SCALE.signalHeightM,
      sizeUnits: "meters",
      sizeMinPixels: NETWORK_CONTROL_SCALE.minPixels,
      sizeMaxPixels: NETWORK_CONTROL_SCALE.maxPixels,
      billboard: true,
      opacity: NETWORK_CONTROL_SCALE.opacity,
      pickable: false,
    }),
  ];
}
