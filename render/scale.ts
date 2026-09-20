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
  // Wide enough that the (deliberately huge) ego car reads as ON the route.
  casingWidthM: 30,
  coreWidthM: 21,
  casingMinPixels: 9,
  coreMinPixels: 6,
  coreMaxPixels: 60,
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
   * Legibility floor while a control is primary / preview. Deliberately huge:
   * a traffic light the user cannot read is not a traffic light. At most two
   * controls are ever on screen, so a big head cannot flood the map.
   */
  minPixels: 104,
  previewMinPixels: 74,
  /** Safety cap: never larger than this on screen. */
  maxPixels: 300,
  /** Preview controls draw at this fraction of their primary size. */
  previewSizeScale: 0.78,
  previewOpacity: 0.72,
} as const;

/**
 * The ego car is the protagonist, and it is drawn comically large on purpose:
 * a 4.5 m car at a real scale is a few pixels at follow zoom, which is neither
 * visible nor fun to watch. Map metres first, with a big pixel floor so it is
 * unmistakable at every zoom the challenge uses.
 */
export const EGO_SCALE = {
  /** Multiplier applied to the physical vehicle length, in map metres. */
  lengthScale: 4.2,
  minPixels: 44,
  previewMinPixels: 44,
  maxPixels: 260,
  /** Per class, so a truck still out-sizes a car and a bicycle stays smallest. */
  minPixelsByClass: { car: 44, truck: 62, bicycle: 26 } as const,
  maxPixelsByClass: { car: 260, truck: 340, bicycle: 130 } as const,
} as const;
