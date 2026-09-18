/**
 * Pure path mathematics for the showcase city (Task 11 correction).
 *
 * The showcase city separates SIMULATION topology (straight intersection A→B
 * with a length) from PRESENTATION geometry (polylines with curves). Road
 * length equals the presentation path length, so vehicle progress maps
 * naturally onto visual distance. Framework-free and deterministic.
 */
export type Point = readonly [number, number];

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface PathIndex {
  readonly points: readonly Point[];
  /** cumulative[i] = distance from points[0] to points[i]. */
  readonly cumulative: readonly number[];
  readonly total: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

export function pathLength(points: readonly Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    total += distance(points[i - 1], points[i]);
  }
  return total;
}

export function buildPathIndex(points: readonly Point[]): PathIndex {
  const cumulative: number[] = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  }
  return { points, cumulative, total: cumulative[cumulative.length - 1] ?? 0 };
}

export interface PathSample {
  readonly x: number;
  readonly y: number;
  /** Heading in radians along the path direction (atan2(dy, dx)). */
  readonly heading: number;
}

/** Samples a point + heading at `atDistance` along the indexed path (clamped). */
export function samplePathIndex(index: PathIndex, atDistance: number): PathSample {
  const { points, cumulative, total } = index;
  if (points.length === 0) {
    return { x: 0, y: 0, heading: 0 };
  }
  if (points.length === 1 || total <= 0) {
    return { x: points[0][0], y: points[0][1], heading: 0 };
  }
  const clamped = Math.min(Math.max(atDistance, 0), total);
  let segment = 0;
  while (segment < cumulative.length - 2 && cumulative[segment + 1] < clamped) {
    segment += 1;
  }
  const from = points[segment];
  const to = points[segment + 1];
  const segmentLength = cumulative[segment + 1] - cumulative[segment];
  const t = segmentLength > 0 ? (clamped - cumulative[segment]) / segmentLength : 0;
  return {
    x: from[0] + (to[0] - from[0]) * t,
    y: from[1] + (to[1] - from[1]) * t,
    heading: Math.atan2(to[1] - from[1], to[0] - from[0]),
  };
}

export function samplePath(points: readonly Point[], atDistance: number): PathSample {
  return samplePathIndex(buildPathIndex(points), atDistance);
}

/** Distance along the path of the projection of `point` (clamped). */
export function projectPointOntoPath(index: PathIndex, point: Point): number {
  const { points, cumulative } = index;
  let bestDistance = 0;
  let bestOffset = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t =
      lengthSquared > 0
        ? Math.min(Math.max(((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared, 0), 1)
        : 0;
    const px = a[0] + dx * t;
    const py = a[1] + dy * t;
    const offset = Math.hypot(point[0] - px, point[1] - py);
    if (offset < bestOffset) {
      bestOffset = offset;
      bestDistance = cumulative[i - 1] + Math.sqrt(lengthSquared) * t;
    }
  }
  return bestDistance;
}

/** Splits a polyline at the given distances along it. */
export function splitPathAt(points: readonly Point[], cuts: readonly number[]): Point[][] {
  const index = buildPathIndex(points);
  const ordered = [...new Set(cuts.map((cut) => Math.round(cut * 1000) / 1000))]
    .filter((cut) => cut > 0.5 && cut < index.total - 0.5)
    .sort((a, b) => a - b);
  const parts: Point[][] = [];
  let current: Point[] = [points[0]];
  for (const cut of ordered) {
    const sample = samplePathIndex(index, cut);
    current.push([sample.x, sample.y]);
    parts.push(current);
    current = [[sample.x, sample.y]];
  }
  current.push(points[points.length - 1]);
  parts.push(current);
  return parts.filter((part) => part.length >= 2 && pathLength(part) > 1);
}

/** Catmull-Rom smoothing through the given points (deterministic, open curve). */
export function smoothPath(points: readonly Point[], subdivisions = 8): Point[] {
  if (points.length < 3 || subdivisions < 2) {
    return points.map((point) => [point[0], point[1]] as Point);
  }
  const result: Point[] = [[points[0][0], points[0][1]]];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    for (let step = 1; step <= subdivisions; step += 1) {
      const t = step / subdivisions;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1[0] +
          (-p0[0] + p2[0]) * t +
          (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 +
          (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y =
        0.5 *
        (2 * p1[1] +
          (-p0[1] + p2[1]) * t +
          (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 +
          (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      result.push([x, y]);
    }
  }
  return result;
}

/** Offsets a polyline sideways (positive = left of travel direction). */
export function offsetPath(points: readonly Point[], offset: number): Point[] {
  const result: Point[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[Math.max(0, i - 1)];
    const next = points[Math.min(points.length - 1, i + 1)];
    const dx = next[0] - previous[0];
    const dy = next[1] - previous[1];
    const length = Math.hypot(dx, dy) || 1;
    result.push([
      points[i][0] + (-dy / length) * offset,
      points[i][1] + (dx / length) * offset,
    ]);
  }
  return result;
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const [xi, yi] = polygon[i];
    const [xj, yj] = polygon[j];
    const intersects =
      yi > point[1] !== yj > point[1] &&
      point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi || 1e-9) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

export function boundsOfPoints(points: readonly Point[]): Bounds {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

export function expandBounds(bounds: Bounds, amount: number): Bounds {
  return {
    minX: bounds.minX - amount,
    minY: bounds.minY - amount,
    maxX: bounds.maxX + amount,
    maxY: bounds.maxY + amount,
  };
}

/** Rectangle polygon helper (counter-clockwise). */
export function rectPolygon(minX: number, minY: number, maxX: number, maxY: number): Point[] {
  return [
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
  ];
}

/** Ellipse polygon helper (sampled, closed). */
export function ellipsePolygon(
  centerX: number,
  centerY: number,
  radiusX: number,
  radiusY: number,
  segments = 24,
): Point[] {
  const points: Point[] = [];
  for (let i = 0; i < segments; i += 1) {
    const angle = (i / segments) * Math.PI * 2;
    points.push([centerX + Math.cos(angle) * radiusX, centerY + Math.sin(angle) * radiusY]);
  }
  return points;
}
