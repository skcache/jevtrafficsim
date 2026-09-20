/**
 * Route-first deck.gl layers (Issue #25): the ego's remaining route and the
 * destination marker.
 *
 * Both are world-bound: widths and sizes are in MAP METRES so they grow as the
 * camera descends, with pixel values only as legibility floors and safety caps
 * (see render/scale.ts). The route is painted per road from the centralized
 * current-route payload, so reroutes repaint immediately. Traffic state is
 * rendered by the separate citywide traffic layer; the route stays one colour.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Projection } from "@/cities/map-model";
import type { RouteSegment } from "./route-path";
import { DESTINATION_SCALE, ROUTE_SCALE } from "./scale";
import type { LngLat } from "./deck-layers";
import { toLngLat } from "./deck-layers";
import { DESTINATION_SPRITE_ID, type DestinationSpriteSet } from "./destination-sprite";

function color(hex: readonly [number, number, number], alpha = 255): [number, number, number, number] {
  return [hex[0], hex[1], hex[2], alpha];
}

/**
 * One visually continuous route band.
 *
 * The route is deliberately ONE colour now. Traffic pressure belongs to the
 * citywide traffic layer underneath the trip experience; changing the route
 * stroke itself at every road boundary created visual seams and bulbous
 * intersection artefacts. We still keep per-road traffic classes in
 * RouteSegment for ETA/debugging, but the navigation path itself reads as one
 * coherent object.
 */
interface RouteRun {
  readonly path: readonly LngLat[];
}

const ROUTE_JOIN_EPSILON_DEG = 2e-6;

export function buildRouteRuns(segments: readonly RouteSegment[]): RouteRun[] {
  const runs: Array<{ path: LngLat[] }> = [];
  for (const segment of segments) {
    const path = segment.path as readonly LngLat[];
    if (path.length < 2) continue;
    const previous = runs[runs.length - 1];
    if (previous) {
      const a = previous.path[previous.path.length - 1];
      const b = path[0];
      const joined =
        Math.abs(a[0] - b[0]) <= ROUTE_JOIN_EPSILON_DEG &&
        Math.abs(a[1] - b[1]) <= ROUTE_JOIN_EPSILON_DEG;
      if (joined) {
        // Use the next road's first point as the shared junction exactly once.
        // This avoids stacked caps/circles while never inventing a connector
        // across a genuine geometry gap.
        previous.path.push(...path.slice(1));
        continue;
      }
    }
    runs.push({ path: [...path] });
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
      getColor: () =>
        color(
          ROUTE_SCALE.color,
          Math.round(ROUTE_SCALE.opacity * 255),
        ),
      getWidth: ROUTE_SCALE.widthM,
      widthUnits: "meters",
      widthMinPixels: ROUTE_SCALE.minPixels,
      widthMaxPixels: ROUTE_SCALE.maxPixels,
      // One run spans contiguous intersections, so there are no stacked
      // per-road end caps to turn into the old mystery circles.
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
