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
 * Individual vehicles start here.
 *
 * This used to sit at 14.4, just above the framing the app opens on (the title
 * city view is ~14.1) — so the first thing any visitor saw was a city with no
 * traffic on it at all, and the follow view only came alive after clicking
 * through onboarding. The map is not decoration: it is the product. Vehicles now
 * start at the zoom the product actually opens at, and the road-level congestion
 * overlay keeps carrying the far band beyond that.
 */
export const VEHICLE_MINZOOM = 13.0;

export function detailTier(zoom: number): DetailTier {
  if (zoom >= CLOSE_TIER_MINZOOM) {
    return "close";
  }
  return zoom >= MID_TIER_MINZOOM ? "mid" : "far";
}
