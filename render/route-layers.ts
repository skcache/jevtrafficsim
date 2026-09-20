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
 * One continuous-looking route band.
 *
 * The old casing + core design doubled the visual stroke and, because route
 * geometry arrives per directed road, round caps stacked into visible circles
 * at intersections. We now coalesce consecutive roads with the same traffic
 * class and draw ONE band with butt caps. Traffic can still transition
 * blue/amber/red, but there is never a second outline colour underneath it.
 */
interface RouteRun {
  readonly traffic: RouteSegment["traffic"];
  readonly path: readonly LngLat[];
}

export function buildRouteRuns(segments: readonly RouteSegment[]): RouteRun[] {
  const runs: Array<{ traffic: RouteSegment["traffic"]; path: LngLat[] }> = [];
  for (const segment of segments) {
    const path = segment.path as readonly LngLat[];
    if (path.length < 2) continue;
    const previous = runs[runs.length - 1];
    if (previous && previous.traffic === segment.traffic) {
      const a = previous.path[previous.path.length - 1];
      const b = path[0];
      const joined = Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
      previous.path.push(...(joined ? path.slice(1) : path));
    } else {
      runs.push({ traffic: segment.traffic, path: [...path] });
    }
  }
  return runs;
}

export function buildRouteLayers(segments: readonly RouteSegment[]): Layer[] {
  const runs = buildRouteRuns(segments);
  if (runs.length === 0) return [];
  return [
    new PathLayer<RouteRun>({
      id: "route-band",
      data: runs,
      getPath: (run) => run.path as LngLat[],
      getColor: (run) =>
        color(
          ROUTE_TRAFFIC_COLORS[run.traffic],
          Math.round(ROUTE_SCALE.opacity * 255),
        ),
      getWidth: ROUTE_SCALE.widthM,
      widthUnits: "meters",
      widthMinPixels: ROUTE_SCALE.minPixels,
      widthMaxPixels: ROUTE_SCALE.maxPixels,
      // Butt caps are intentional: round caps on per-road paths were the
      // mysterious circles visible at intersections.
      capRounded: false,
      jointRounded: true,
      pickable: false,
    }),
  ];
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
