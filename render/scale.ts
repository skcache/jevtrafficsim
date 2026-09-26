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
  /**
   * How far ahead of the car the camera centre sits, in metres. Pulled in from
   * 85 m for the wider follow framing: at zoom ~15.4 the same metres cover far
   * more screen, and 85 m pushed the car uncomfortably low in the frame.
   */
  lookAheadM: 55,
  /** Time constant for the smoothed travel direction. */
  directionHalfLifeMs: 420,
  /** Below this speed the car has no meaningful direction: keep the last one. */
  minSpeedMps: 0.4,
  /** One-shot ease when the user presses Follow/Recenter. */
  recenterEaseMs: 650,
  /**
   * Time constants for the camera's own state. Both are deliberately slower than
   * the direction: the camera must feel HEAVIER than the car, so it absorbs the
   * car's small position changes instead of reproducing them.
   */
  centreHalfLifeMs: 520,
  lookAheadHalfLifeMs: 900,
  /**
   * Target changes below this distance do not move the camera at all. A car
   * creeping in a queue, or a worker frame landing a few ms late, must not
   * produce visible motion — and a stopped car must be perfectly still.
   */
  deadZoneM: 2.5,
} as const;

/**
 * Contextual road controls (Issue #26). The head and the sign are WORLD
 * objects: sized in metres, with a pixel floor so they stay readable at
 * follow-camera zoom and a cap so they never smear when the camera descends.
 * The preview band is deliberately smaller and quieter than the primary one.
 *
 * These are the ONLY controls the public map draws (issue #46): the citywide
 * network of tiny neutral heads is gone, so the preview size is no longer a
 * handoff from anything — it is simply the quiet end of this one control's own
 * approach animation.
 */
export const CONTROL_SCALE = {
  /**
   * A contextual control starts small and grows continuously as the ego
   * approaches. This is the important bit: no 100px traffic-light teleport, no
   * tiny unreadable dot.
   */
  signalBaseHeightM: 6.2,
  signalHeightM: 13.5,
  stopBaseHeightM: 5.6,
  stopHeightM: 11,
  // The pixel FLOOR is what makes a control readable, and it is also what keeps
  // it readable at a distance: measured at the follow zoom the map is
  // 0.5615 px per metre, so even a 13.5 m signal is only 7.6 px without it. 18 px
  // is ~3x the previous rendered size (5.9 px) and holds out to the zoom levels
  // a viewer actually uses (issue #56).
  minPixels: 18,
  maxPixels: 56,
  // Quiet at the preview boundary, full strength as the ego approaches. A
  // passed control fades to zero from here (see control-layers' opacityFor).
  opacityFloor: 0.3,
} as const;

/**
 * The citywide network of tiny neutral heads (Issue #27).
 *
 * NOT drawn on the public map any more: issue #46 requires the live view to
 * show a control ONLY where the ego is about to meet one, and 44 of these fell
 * inside the follow viewport at zoom 15 (753 when zoomed out), which is exactly
 * the "forest of lights" the issue rejects. The module stays because the
 * measurement tooling still counts the network it describes; nothing in the
 * product wires it into a layer.
 */
export const NETWORK_CONTROL_SCALE = {
  signalHeightM: 5.6,
  minPixels: 6,
  maxPixels: 16,
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
  /**
   * A little over two car lengths: big enough to read as the protagonist at
   * follow zoom, small enough to still look like a vehicle ON a road rather
   * than a blob covering it. The floor keeps it findable when zoomed out; the
   * cap stops it swallowing the block when zoomed in.
   */
  lengthScale: 2.2,
  minPixelsByClass: { car: 26, truck: 34, bicycle: 15 } as const,
  maxPixelsByClass: { car: 88, truck: 110, bicycle: 52 } as const,
} as const;

/**
 * Background traffic (presentation-only) is drawn at its TRUE physical size, with
 * a small pixel floor so a car stays findable when zoomed out and a modest cap so
 * a long truck at close zoom cannot swallow the block. The protagonist's
 * oversized EGO_SCALE must never apply here: a fleet of 2.2x cars reads as a car
 * park, which is exactly the failure this pass exists to fix.
 */
export const TRAFFIC_SCALE = {
  minPixelsByClass: { car: 10, truck: 13, bicycle: 5 } as const,
  maxPixelsByClass: { car: 26, truck: 40, bicycle: 14 } as const,
} as const;
