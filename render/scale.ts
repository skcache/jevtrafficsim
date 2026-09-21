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
 * The ego route is ONE clean navigation-blue band. No casing/core double
 * stroke and no per-road colour switching: both produced seams/bulbous
 * intersection artifacts and made the route read as multiple objects.
 */
export const ROUTE_SCALE = {
  /** Colours come from ROUTE_TRAFFIC_COLORS (blue / amber / red). */
  widthM: 15,
  minPixels: 5,
  maxPixels: 36,
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
   * A contextual control starts at the same physical scale as the quiet
   * network marker and grows continuously as the ego approaches. This is the
   * important bit: no 100px traffic-light teleport, no tiny unreadable dot.
   */
  signalBaseHeightM: 4.8,
  signalHeightM: 13.5,
  stopBaseHeightM: 4.4,
  stopHeightM: 10.5,
  minPixels: 4,
  maxPixels: 72,
  // Match the quiet network marker at emphasis=0, then fade to full strength
  // as the ego approaches. This makes the handoff visually continuous.
  opacityFloor: 0.3,
} as const;

/** Tiny neutral signal heads that prove the whole-city control system exists. */
export const NETWORK_CONTROL_SCALE = {
  signalHeightM: 4.8,
  minPixels: 3.5,
  maxPixels: 12,
  opacity: 0.3,
  minZoom: 12.8,
} as const;

/**
 * The ego is intentionally easier to track than a physically exact 4.6 m car:
 * it reads like the car in a navigation app, filling most of its lane. It is
 * still a map object (metres first) with a pixel FLOOR so it never shrinks away
 * when the camera pulls back and a CAP so it never smears when it descends —
 * which is what keeps the scale stable across zoom.
 */
export const EGO_SCALE = {
  lengthScale: 4.5,
  minPixelsByClass: { car: 58, truck: 76, bicycle: 34 } as const,
  maxPixelsByClass: { car: 260, truck: 320, bicycle: 150 } as const,
} as const;
