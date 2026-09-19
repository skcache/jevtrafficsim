/**
 * Presentation logic (Task 11 polish pass): pure helpers that the deck.gl
 * layers and chrome consume. Framework-free and unit-testable — no deck.gl,
 * no DOM, no React.
 *
 * The vehicle language has two channels:
 *   body  = vehicle class (light, always legible on roads)
 *   state = wait heat (a warm outline + halo, drawn on top of the body)
 */
import type { Point } from "@/cities/paths";
import type { VehicleType } from "@/sim/types";
import { waitHeatBucket, WAIT_HEAT_COLORS, type WaitHeatBucket } from "./map-geometry";

/* ------------------------------------------------------------------ */
/* Vehicles                                                            */
/* ------------------------------------------------------------------ */

/** Class body colours: light chips with a dark outline read on any road. */
export const VEHICLE_BODY_COLORS: Record<VehicleType, [number, number, number]> = {
  car: [242, 243, 245],
  truck: [228, 231, 236],
  bicycle: [217, 230, 245],
};

/** The dark outline that makes light chips survive on light roads. */
export const VEHICLE_OUTLINE_COLOR: [number, number, number, number] = [38, 32, 26, 150];

/** Reference sprite length per class at the mid band (px). */
/**
 * Base glyph lengths in pixels at mid zoom. With the close-zoom scale below
 * these land at car ~12.7, truck ~19, bicycle ~7.4 px: readable class identity
 * without becoming dots, and the body still fits inside a 1-lane casing.
 */
export const VEHICLE_BASE_LENGTHS: Record<VehicleType, number> = {
  car: 12,
  truck: 18,
  bicycle: 7,
};

const FAR_SCALE = 0.58; // 7 px car at city zoom — a chip, never sub-pixel noise
const MID_SCALE = 1;
const CLOSE_SCALE = 1.06; // ~12.7 px car at maximum zoom

/**
 * Zoom → sprite scale. Three bands (city / district / street) with smooth
 * ramps: below 15.2 a chip, 15.2-16.2 to full size, then gently larger.
 */
export function vehicleSizeScale(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return MID_SCALE;
  }
  if (zoom <= 15.2) {
    return FAR_SCALE;
  }
  if (zoom <= 16.2) {
    return FAR_SCALE + ((zoom - 15.2) / 1) * (MID_SCALE - FAR_SCALE);
  }
  if (zoom >= 19.5) {
    return CLOSE_SCALE;
  }
  return MID_SCALE + ((zoom - 16.2) / 3.3) * (CLOSE_SCALE - MID_SCALE);
}

export function vehicleLengthPx(type: VehicleType, zoom: number): number {
  return VEHICLE_BASE_LENGTHS[type] * vehicleSizeScale(zoom);
}

/**
 * Ring growth (px) per heat bucket: the outline thickens as a vehicle waits,
 * so a queue reads as a warm band even at whole-city zoom.
 */
export function vehicleRingExtraPx(bucket: WaitHeatBucket): number {
  if (bucket === 0) {
    return 2.5;
  }
  if (bucket === 1) {
    return 6;
  }
  if (bucket === 2) {
    return 7.5;
  }
  return 9;
}

/**
 * Ring growth is scaled down at whole-city zoom so a congested map shows warm
 * bands without the chips turning into blobs.
 */
export function ringScaleForZoom(zoom: number): number {
  return Number.isFinite(zoom) && zoom < 15.2 ? 0.65 : 1;
}

/** Soft warm glow (px) behind the most patient vehicles only (30 s+). */
export function vehicleHaloExtraPx(bucket: WaitHeatBucket): number {
  return bucket >= 3 ? 8 : 0;
}

export function vehicleHaloColor(bucket: WaitHeatBucket): [number, number, number, number] {
  const [r, g, b] = WAIT_HEAT_COLORS[bucket];
  return [r, g, b, bucket >= 4 ? 120 : 95];
}

/** Vehicles split by heat bucket so warm chips are drawn last (never buried). */
export function groupByHeatBucket<T extends { readonly blockedWaitMs: number }>(
  vehicles: readonly T[],
): T[][] {
  const groups: T[][] = [[], [], [], [], []];
  for (const vehicle of vehicles) {
    groups[waitHeatBucket(vehicle.blockedWaitMs)].push(vehicle);
  }
  return groups;
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

export type SignalTier = "hidden" | "far" | "mid" | "close";

/**
 * Zoom tiers with generous fade bands (never a hard cut): city view keeps a
 * small dot, district view a disc plus the active axis, street view a head.
 */
export function signalTier(zoom: number): SignalTier {
  if (!Number.isFinite(zoom) || zoom < 13.0) {
    return "hidden";
  }
  if (zoom < 14.6) {
    return "far";
  }
  if (zoom < 16.4) {
    return "mid";
  }
  return "close";
}

/** 0..1 opacity for the tier, ramped over its first 0.6 zoom of existence. */
export function signalTierOpacity(zoom: number): number {
  const tier = signalTier(zoom);
  if (tier === "hidden") {
    return 0;
  }
  const start = tier === "far" ? 13.0 : tier === "mid" ? 14.6 : 16.4;
  return Math.min(1, Math.max(0, (zoom - start) / 0.6));
}

/** Reach (metres) of the active-axis bar per tier. */
export function signalAxisReachMetres(tier: SignalTier): number {
  return tier === "close" ? 26 : 40;
}

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

/**
 * Splits a closed road into alternating on/off dashes so the layer can draw
 * a hazard hatch on top of the closure band.
 */
export function hatchSegments(
  points: readonly Point[],
  dashMetres = 4,
  gapMetres = 5,
): Point[][] {
  const segments: Point[][] = [];
  if (points.length < 2) {
    return segments;
  }
  const period = dashMetres + gapMetres;
  let carry = 0;
  let current: Point[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length <= 0) {
      continue;
    }
    const dx = (b[0] - a[0]) / length;
    const dy = (b[1] - a[1]) / length;
    let travelled = 0;
    while (travelled < length) {
      const phase = (carry + travelled) % period;
      const on = phase < dashMetres;
      const step = Math.min(
        on ? dashMetres - phase : period - phase,
        length - travelled,
      );
      const from: Point = [a[0] + dx * travelled, a[1] + dy * travelled];
      const to: Point = [a[0] + dx * (travelled + step), a[1] + dy * (travelled + step)];
      if (on) {
        if (current.length === 0) {
          current.push(from);
        }
        current.push(to);
      } else if (current.length > 1) {
        segments.push(current);
        current = [];
      }
      travelled += step;
    }
    carry = (carry + length) % period;
  }
  if (current.length > 1) {
    segments.push(current);
  }
  return segments;
}

export interface StopBarGeometry {
  /** White stop bar across the approach at the intersection edge. */
  readonly bar: readonly [Point, Point];
  /** Three crosswalk ticks just before the bar. */
  readonly crosswalk: readonly (readonly [Point, Point])[];
}

/**
 * Stop bar + crosswalk ticks for one approach: perpendicular to the approach
 * direction, placed just inside the intersection.
 */
export function stopBarGeometry(
  center: Point,
  approachBearing: number,
  roadHalfWidth = 3.5,
): StopBarGeometry {
  const dx = Math.cos(approachBearing);
  const dy = Math.sin(approachBearing);
  const px = -dy;
  const py = dx;
  const inset = 2.5;
  const cx = center[0] - dx * inset;
  const cy = center[1] - dy * inset;
  const bar: [Point, Point] = [
    [cx - px * roadHalfWidth, cy - py * roadHalfWidth],
    [cx + px * roadHalfWidth, cy + py * roadHalfWidth],
  ];
  const crosswalk: [Point, Point][] = [];
  for (const offset of [-2.2, -3.6, -5.0]) {
    const bx = cx + dx * offset;
    const by = cy + dy * offset;
    crosswalk.push([
      [bx - px * roadHalfWidth, by - py * roadHalfWidth],
      [bx + px * roadHalfWidth, by + py * roadHalfWidth],
    ]);
  }
  return { bar, crosswalk };
}

/** Short egress arrows for an event release, one per outgoing road. */
export function egressArrows(
  center: Point,
  outgoingBearings: readonly number[],
  innerMetres = 16,
  outerMetres = 40,
): { source: Point; target: Point }[] {
  return outgoingBearings.map((bearing) => {
    const dx = Math.cos(bearing);
    const dy = Math.sin(bearing);
    return {
      source: [center[0] + dx * innerMetres, center[1] + dy * innerMetres] as Point,
      target: [center[0] + dx * outerMetres, center[1] + dy * outerMetres] as Point,
    };
  });
}

/* ------------------------------------------------------------------ */
/* Metrics                                                             */
/* ------------------------------------------------------------------ */

/**
 * SVG path for a metrics sparkline. Values are normalised to the series max;
 * an empty or flat series renders a flat line at the baseline.
 */
export function sparklinePath(
  values: readonly number[],
  width: number,
  height: number,
): string {
  if (values.length === 0) {
    return "";
  }
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - Math.min(1, Math.max(0, value / max)) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

/**
 * Coordinates of the newest sample on the sparkline, so the chart can mark it.
 */
export function sparklineLastPoint(
  values: readonly number[],
  width: number,
  height: number,
): { x: number; y: number } | null {
  if (values.length === 0) {
    return null;
  }
  const max = Math.max(...values, 1);
  const value = values[values.length - 1];
  return {
    x: width,
    y: height - Math.min(1, Math.max(0, value / max)) * height,
  };
}

/** Placeholder values shown before the first METRICS packet arrives. */
export const METRIC_PLACEHOLDER = "0.0s";

export type { WaitHeatBucket };
