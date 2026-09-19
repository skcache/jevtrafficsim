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
 *   vehicles in flow, road congestion, bridges and ramps, district and street
 *   labels. Signals stay off: a field of dots is not information.
 *
 * CLOSE (street)
 *   full vehicle glyphs at lane centres, queues, approach signal heads with
 *   stop lines, restrained crosswalks at the closest zoom, buildings, street
 *   names, incident detail.
 */
export type DetailTier = "far" | "mid" | "close";

/** Below this the camera is looking at a neighborhood or a whole city. */
export const CLOSE_TIER_MINZOOM = 14.6;
/** Below this it is the whole city. */
export const MID_TIER_MINZOOM = 11.8;
/** Crosswalk hints only appear at the closest zoom. */
export const CROSSWALK_MINZOOM = 16.6;
/** Wait-heat halos are a close-zoom instrument; further out they are confetti. */
export const WAIT_HEAT_MINZOOM = 14.2;

export function detailTier(zoom: number): DetailTier {
  if (zoom >= CLOSE_TIER_MINZOOM) {
    return "close";
  }
  return zoom >= MID_TIER_MINZOOM ? "mid" : "far";
}
