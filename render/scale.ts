/**
 * World-bound presentation sizes (Issue #25).
 *
 * The route-first view has one rule about scale: geographic things are sized in
 * MAP METRES and grow as the camera descends. Pixel values appear only as
 * minimum legibility floors (nothing may vanish when the camera pulls back) and
 * maximum safety caps (nothing may smear across the screen when it descends).
 *
 * Keeping the numbers here means the route, the destination marker and the
 * camera bias can never drift apart, and it gives tests one place to assert the
 * map-space policy.
 */

/**
 * The ego route is ONE clean band. No casing/core double stroke: that produced
 * bulbous circles where per-road paths met and made the route look like two
 * unrelated lines. Traffic state may still change the band colour by segment.
 */
export const ROUTE_SCALE = {
  widthM: 15,
  minPixels: 5.5,
  maxPixels: 38,
  opacity: 0.96,
} as const;

/** The destination marker: map-anchored, with a pixel floor so it stays findable. */
export const DESTINATION_SCALE = {
  /** Sprite length in metres (a pin is taller than its footprint). */
  sizeM: 30,
  minPixels: 16,
  maxPixels: 72,
  /** Soft ground ring under the pin, in metres. */
  ringM: 16,
  ringMinPixels: 8,
  ringMaxPixels: 46,
  ringOpacity: 0.3,
} as const;

/**
 * Follow camera (north-up). The bias is measured ALONG the direction of travel,
 * so the user sees the road ahead; the direction is exponentially smoothed so a
 * single noisy sample (a junction turn, a reroute) cannot swing the camera.
 */
export const FOLLOW_SCALE = {
  /** How far ahead of the car the camera centre sits, in metres. */
  lookAheadM: 85,
  /** Time constant for the smoothed travel direction. */
  directionHalfLifeMs: 420,
  /** Below this speed the car has no meaningful direction: keep the last one. */
  minSpeedMps: 0.4,
  /** One-shot ease when the user presses Follow/Recenter. */
  recenterEaseMs: 650,
} as const;

/**
 * Contextual road controls (Issue #26). The head and the sign are WORLD
 * objects: sized in metres, with a pixel floor so they stay readable at
 * follow-camera zoom and a cap so they never smear when the camera descends.
 * The preview band is deliberately smaller and quieter than the primary one.
 */
export const CONTROL_SCALE = {
  /**
   * Contextual controls are deliberately larger than the background system
   * markers, but no longer billboard-sized. Map metres remain authoritative.
   */
  signalHeightM: 20,
  stopHeightM: 15,
  minPixels: 30,
  previewMinPixels: 22,
  maxPixels: 112,
  previewSizeScale: 0.72,
  previewOpacity: 0.78,
} as const;

/** Tiny neutral signal heads that prove the whole-city control system exists. */
export const NETWORK_CONTROL_SCALE = {
  signalHeightM: 6,
  minPixels: 5,
  maxPixels: 18,
  opacity: 0.42,
  minZoom: 13.2,
} as const;

/**
 * The ego is intentionally easier to track than a physically exact 4.6 m car,
 * but remains a map object rather than a fixed-size UI badge.
 */
export const EGO_SCALE = {
  lengthScale: 2.15,
  minPixelsByClass: { car: 22, truck: 30, bicycle: 14 } as const,
  maxPixelsByClass: { car: 150, truck: 190, bicycle: 90 } as const,
} as const;
