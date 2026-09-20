/**
 * Route-first deck.gl layers (Issue #25): the ego's remaining route and the
 * destination marker.
 *
 * Both are world-bound: widths and sizes are in MAP METRES so they grow as the
 * camera descends, with pixel values only as legibility floors and safety caps
 * (see render/scale.ts). The route is painted per road from the centralized
 * classifier, so a rerouted or congested trip repaints immediately and
 * deterministically.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Projection } from "@/cities/map-model";
import { ROUTE_TRAFFIC_COLORS } from "./route-traffic";
import type { RouteSegment } from "./route-path";
import { DESTINATION_SCALE, ROUTE_SCALE } from "./scale";
import type { LngLat } from "./deck-layers";
import { toLngLat } from "./deck-layers";
import { DESTINATION_SPRITE_ID, type DestinationSpriteSet } from "./destination-sprite";

function color(hex: readonly [number, number, number], alpha = 255): [number, number, number, number] {
  return [hex[0], hex[1], hex[2], alpha];
}

/**
 * Casing under core: the casing separates the route from blocks and other
 * roads, the coloured core carries traffic state.
 */
export function buildRouteLayers(segments: readonly RouteSegment[]): Layer[] {
  if (segments.length === 0) {
    return [];
  }
  const casing = new PathLayer<RouteSegment>({
    id: "route-casing",
    data: segments as RouteSegment[],
    getPath: (segment) => segment.path as unknown as LngLat[],
    getColor: [33, 29, 24, Math.round(ROUTE_SCALE.casingOpacity * 255)],
    getWidth: ROUTE_SCALE.casingWidthM,
    widthUnits: "meters",
    widthMinPixels: ROUTE_SCALE.casingMinPixels,
    widthMaxPixels: ROUTE_SCALE.coreMaxPixels * 2,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  });
  const core = new PathLayer<RouteSegment>({
    id: "route-core",
    data: segments as RouteSegment[],
    getPath: (segment) => segment.path as unknown as LngLat[],
    getColor: (segment) => color(ROUTE_TRAFFIC_COLORS[segment.traffic], Math.round(ROUTE_SCALE.coreOpacity * 255)),
    getWidth: ROUTE_SCALE.coreWidthM,
    widthUnits: "meters",
    widthMinPixels: ROUTE_SCALE.coreMinPixels,
    widthMaxPixels: ROUTE_SCALE.coreMaxPixels,
    capRounded: true,
    jointRounded: true,
    pickable: false,
  });
  return [casing, core];
}

export interface DestinationAnchor {
  /** Local map metres of the destination intersection. */
  readonly x: number;
  readonly y: number;
  /** True once the trip is complete: the pin turns into a settled mark. */
  readonly completed: boolean;
}

/**
 * One destination pin, anchored at its tip, plus a soft ground ring so the
 * marker reads as a place on the map rather than a floating sticker.
 */
export function buildDestinationLayers(
  projection: Projection,
  anchor: DestinationAnchor | null,
  sprites: DestinationSpriteSet | null,
): Layer[] {
  if (!anchor || !sprites) {
    return [];
  }
  const position = toLngLat(projection, anchor.x, anchor.y);
  const ring = new ScatterplotLayer<DestinationAnchor>({
    id: "destination-ring",
    data: [anchor],
    getPosition: () => position,
    getRadius: DESTINATION_SCALE.ringM,
    radiusUnits: "meters",
    radiusMinPixels: DESTINATION_SCALE.ringMinPixels,
    radiusMaxPixels: DESTINATION_SCALE.ringMaxPixels,
    filled: false,
    stroked: true,
    lineWidthUnits: "meters",
    getLineWidth: 4,
    lineWidthMinPixels: 1.4,
    getLineColor: [33, 29, 24, Math.round(DESTINATION_SCALE.ringOpacity * 255)],
    pickable: false,
  });
  const pin = new IconLayer<DestinationAnchor>({
    id: "destination-pin",
    data: [anchor],
    iconAtlas: sprites.atlas,
    iconMapping: sprites.mapping,
    getIcon: () => DESTINATION_SPRITE_ID,
    getPosition: () => position,
    getSize: DESTINATION_SCALE.sizeM,
    sizeUnits: "meters",
    sizeMinPixels: DESTINATION_SCALE.minPixels,
    sizeMaxPixels: DESTINATION_SCALE.maxPixels,
    billboard: false,
    pickable: false,
  });
  return [ring, pin];
}
