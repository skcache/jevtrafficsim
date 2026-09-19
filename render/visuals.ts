/**
 * Presentation logic (Task 11 polish pass): pure helpers that the deck.gl
 * layers and chrome consume. Framework-free and unit-testable — no deck.gl,
 * no DOM, no React.
 *
 * What survives here is what production still uses: class sizing, the signal
 * tier fade, closure hatching and the metrics sparkline. The Phase-2 wait-heat
 * ring/halo language, the signal axis bars and the event egress arrows were
 * deleted with the layers that drew them.
 */
import type { Point } from "@/cities/paths";
import type { VehicleType } from "@/sim/types";

/* ------------------------------------------------------------------ */
/* Vehicles                                                            */
/* ------------------------------------------------------------------ */

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

