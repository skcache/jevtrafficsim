/**
 * The zoom/detail grammar: which simulation primitives belong at which camera
 * height. Kept in one place so the map style, the deck layers and the HUD all
 * agree, and so the rule is auditable rather than scattered through the
 * renderer.
 *
 * FAR (city / Metro)
 *   road hierarchy, water, parks, buildings as mass, major labels, simplified
 *   traffic, road-level congestion, major incidents.
 *   NO signals, NO stop bars, NO crosswalks, NO per-lane detail.
 *
 * MID (neighborhood)
 *   sampled vehicles, road congestion, bridges/ramps and district labels.
 *   The basemap stays muted; simulation state earns the contrast.
 *
 * CLOSE (street)
 *   full vehicle glyphs at lane centres, queue order, one signal-state gate per
 *   physical approach arm, optional traffic-light housings, street names and
 *   incident detail. Raw GIS decoration never becomes the product.
 */
export type DetailTier = "far" | "mid" | "close";

/** Below this the camera is looking at a neighborhood or a whole city. */
export const CLOSE_TIER_MINZOOM = 14.6;
/** Below this it is the whole city. */
export const MID_TIER_MINZOOM = 11.8;
/** Crosswalk hints only appear at the closest zoom. */
/** Wait-heat halos are a close-zoom instrument; further out they are confetti. */
/**
 * Individual vehicles start here. At city zoom they are noise: the road-level
 * congestion overlay carries the same information without the confetti, which
 * is the whole point of the far band.
 */
export const VEHICLE_MINZOOM = 14.4;

export function detailTier(zoom: number): DetailTier {
  if (zoom >= CLOSE_TIER_MINZOOM) {
    return "close";
  }
  return zoom >= MID_TIER_MINZOOM ? "mid" : "far";
}
