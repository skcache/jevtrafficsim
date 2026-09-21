/**
 * Route-first deck.gl layers (Issue #25): the ego's remaining route and the
 * destination marker.
 *
 * Both are world-bound: widths and sizes are in MAP METRES so they grow as the
 * camera descends, with pixel values only as legibility floors and safety caps
 * (see render/scale.ts). The route is painted per road from the centralized
 * current-route payload, so reroutes repaint immediately — including traffic
 * pressure ON the route: contiguous same-state roads merge into one run, so the
 * band stays a single smooth stroke while congested stretches show amber/red.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { Projection } from "@/cities/map-model";
import type { RouteSegment } from "./route-path";
import { DESTINATION_SCALE, ROUTE_SCALE } from "./scale";
import { ROUTE_TRAFFIC_COLORS } from "./route-traffic";
import type { LngLat } from "./deck-layers";
import { toLngLat } from "./deck-layers";
import { DESTINATION_SPRITE_ID, type DestinationSpriteSet } from "./destination-sprite";

function color(hex: readonly [number, number, number], alpha = 255): [number, number, number, number] {
  return [hex[0], hex[1], hex[2], alpha];
}

/**
 * One visually continuous route band, in as few strokes as the traffic state
 * allows: consecutive roads of the SAME state merge into a single run, so a
 * free route is one stroke and a partly-congested route is two or three, never
 * one-per-road. Runs meet at shared junction points with equal width, so the
 * band reads as one object rather than stacked slop.
 */
interface RouteRun {
  readonly path: readonly LngLat[];
  readonly traffic: RouteSegment["traffic"];
}

/** Draw order: the more severe state paints last, so it owns the junction. */
const RUN_DRAW_ORDER: readonly RouteSegment["traffic"][] = ["free", "slowed", "congested"];

const ROUTE_JOIN_EPSILON_DEG = 2e-6;

function sameRoutePoint(a: LngLat, b: LngLat): boolean {
  return (
    Math.abs(a[0] - b[0]) <= ROUTE_JOIN_EPSILON_DEG &&
    Math.abs(a[1] - b[1]) <= ROUTE_JOIN_EPSILON_DEG
  );
}

function cleanRoutePath(path: readonly LngLat[]): LngLat[] {
  const cleaned: LngLat[] = [];
  for (const point of path) {
    if (cleaned.length === 0 || !sameRoutePoint(cleaned[cleaned.length - 1], point)) {
      cleaned.push(point);
    }
  }
  return cleaned;
}

export function buildRouteRuns(segments: readonly RouteSegment[]): RouteRun[] {
  const runs: Array<{ path: LngLat[]; traffic: RouteSegment["traffic"] }> = [];
  for (const segment of segments) {
    const path = cleanRoutePath(segment.path as readonly LngLat[]);
    if (path.length < 2) continue;
    const previous = runs[runs.length - 1];
    if (
      previous &&
      previous.traffic === segment.traffic &&
      sameRoutePoint(previous.path[previous.path.length - 1], path[0])
    ) {
      // The junction point exists exactly once. Removing near-duplicate
      // consecutive points also prevents zero-length vertices from turning
      // into round/dot artifacts in deck.gl.
      for (const point of path.slice(1)) {
        if (!sameRoutePoint(previous.path[previous.path.length - 1], point)) {
          previous.path.push(point);
        }
      }
      continue;
    }
    runs.push({ path, traffic: segment.traffic });
  }
  return runs;
}

export function buildRouteLayers(segments: readonly RouteSegment[]): Layer[] {
  const runs = buildRouteRuns(segments);
  if (runs.length === 0) return [];
  return RUN_DRAW_ORDER.flatMap((traffic) => {
    const ofState = runs.filter((run) => run.traffic === traffic);
    if (ofState.length === 0) return [];
    return [
      new PathLayer<RouteRun>({
        id: `route-band-${traffic}`,
        data: ofState,
        getPath: (run) => run.path as LngLat[],
        getColor: () =>
          color(ROUTE_TRAFFIC_COLORS[traffic], Math.round(ROUTE_SCALE.opacity * 255)),
        getWidth: ROUTE_SCALE.widthM,
        widthUnits: "meters",
        widthMinPixels: ROUTE_SCALE.minPixels,
        widthMaxPixels: ROUTE_SCALE.maxPixels,
        // Runs already merge every contiguous same-state stretch, so rounded
        // joins smooth the stroke without stacking caps per road.
        capRounded: true,
        jointRounded: true,
        pickable: false,
      }),
    ];
  });
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
