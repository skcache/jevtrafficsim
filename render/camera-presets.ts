/**
 * Camera presets: the compositions this map is designed to be seen from.
 *
 * A generic `fitBounds` over every polygon, label anchor and district cell is
 * how Chicago ended up as a postage stamp in a blank frame — the bounds were
 * pulled east across the empty lake by geometry that is not the city. Fit and
 * landing are therefore derived from the ACTIVE ROAD NETWORK, and the landing
 * uses an explicit composition rather than whatever fitBounds decides.
 *
 * Padding is chosen so the fitted city fills roughly 75–90% of the useful
 * viewport: too little and the map bleeds off the edges, too much and it floats.
 */
import type { MapModel } from "@/cities/map-model";
import { metricToLngLat } from "@/cities/map-model";

export interface CameraPose {
  readonly center: readonly [number, number];
  readonly zoom: number;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** Padding (px) that leaves the fitted network filling the frame. */
export const FIT_PADDING = 28;
/** Padding (px) for the composed presets, which want more air. */
export const PRESET_PADDING = 12;

/**
 * Bounds of the driving network: the city as the simulation sees it. Labels and
 * district cells are deliberately excluded — they extend past the streets and
 * would drag the frame out over the lake.
 */
export function networkBounds(model: MapModel): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const intersection of model.city.intersections) {
    minX = Math.min(minX, intersection.x);
    minY = Math.min(minY, intersection.y);
    maxX = Math.max(maxX, intersection.x);
    maxY = Math.max(maxY, intersection.y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Bounds of the dense downtown core, derived from the network rather than
 * authored: the central third of the fitted box, which on this extent is the
 * Loop, River North and the West Loop.
 */
export function centralBounds(model: MapModel): Bounds {
  const bounds = networkBounds(model);
  const insetX = (bounds.maxX - bounds.minX) * 0.28;
  const insetY = (bounds.maxY - bounds.minY) * 0.24;
  return {
    minX: bounds.minX + insetX,
    minY: bounds.minY + insetY,
    maxX: bounds.maxX - insetX,
    maxY: bounds.maxY - insetY,
  };
}

/** A neighbourhood window: roughly the Loop plus one ring of streets. */
export function neighborhoodBounds(model: MapModel): Bounds {
  const central = centralBounds(model);
  const width = (central.maxX - central.minX) * 0.55;
  const height = (central.maxY - central.minY) * 0.55;
  const cx = (central.minX + central.maxX) / 2;
  const cy = (central.minY + central.maxY) / 2;
  return { minX: cx - width, minY: cy - height, maxX: cx + width, maxY: cy + height };
}

/**
 * The four compositions. HERO is the landing: the river meeting the Loop, with
 * the bridges and the downtown grid in frame — the view that says "Chicago"
 * before any label does.
 */
export const CAMERA_PRESETS = {
  /** Landing composition: Loop edge and the river, deliberately off-centre. */
  hero: { anchor: [-87.6308, 41.8874], zoom: 14.1 },
  /** About four to seven city blocks of street. */
  street: { anchor: [-87.6294, 41.8825], zoom: 16.6 },
  /** The Loop and River North. */
  neighborhood: { anchor: [-87.6338, 41.8855], zoom: 14.6 },
  /** The whole active city. */
  city: { anchor: [-87.6375, 41.881], zoom: 12.6 },
} as const satisfies Record<string, { anchor: readonly [number, number]; zoom: number }>;

export type CameraPresetName = keyof typeof CAMERA_PRESETS;

export function presetPose(name: CameraPresetName): CameraPose {
  const preset = CAMERA_PRESETS[name];
  return { center: [preset.anchor[0], preset.anchor[1]], zoom: preset.zoom };
}

/** Lng/lat corner pair for `fitBounds`, from a metric bounds box. */
export function boundsLngLat(
  model: MapModel,
  bounds: Bounds,
): [[number, number], [number, number]] {
  const [west, south] = metricToLngLat(model.projection, bounds.minX, bounds.minY);
  const [east, north] = metricToLngLat(model.projection, bounds.maxX, bounds.maxY);
  return [
    [west, south],
    [east, north],
  ];
}
