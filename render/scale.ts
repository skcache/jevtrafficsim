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

/** The route band: a casing that separates it from the basemap, a coloured core. */
export const ROUTE_SCALE = {
  casingWidthM: 17,
  coreWidthM: 11,
  casingMinPixels: 5.5,
  coreMinPixels: 3.5,
  coreMaxPixels: 30,
  /** Opacity of the painted route over the basemap. */
  casingOpacity: 0.5,
  coreOpacity: 0.92,
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
   * Legibility floor while a control is primary / preview. Sized so all three
   * lamp positions resolve at follow-camera zoom, not just the lit one.
   */
  minPixels: 36,
  previewMinPixels: 26,
  /** Safety cap: never larger than this on screen. */
  maxPixels: 96,
  /** Preview controls draw at this fraction of their primary size. */
  previewSizeScale: 0.78,
  previewOpacity: 0.72,
} as const;
