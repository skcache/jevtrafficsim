/**
 * Static render model (Task 11): converts a generated City into
 * renderer-friendly data ONCE per run. Pure module — no canvas, no React.
 *
 * Physical geometry is deduplicated through the Task-10 structural segment
 * resolver: the two directed roads of one physical segment are drawn as ONE
 * line, never over each other. The simulation still operates on directed
 * roads; `directedToSegment` maps every directed road id to its rendered
 * segment for deterministic vehicle placement.
 *
 * Also hosts the small pure rendering helpers: the world -> screen fit
 * transform, the wait-heat buckets and the lane-offset sign.
 */
import { physicalSegments } from "@/sim/incidents";
import type { City, IntersectionControl, RoadId, RoadKind } from "@/sim/types";

export interface WorldPoint {
  readonly x: number;
  readonly y: number;
}

export interface WorldBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface RenderSegment {
  /** Stable id: sorted directed road ids joined with ":". */
  readonly id: string;
  readonly roadIds: readonly RoadId[];
  readonly kind: RoadKind;
  readonly from: WorldPoint;
  readonly to: WorldPoint;
  readonly isBridge: boolean;
  /** Unit direction from -> to; stable across runs for lane-offset math. */
  readonly dx: number;
  readonly dy: number;
  readonly length: number;
}

export interface RenderBlock {
  readonly points: readonly WorldPoint[];
}

export interface RenderIntersection {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly control: IntersectionControl;
  readonly regionId: number;
}

export interface RenderDirectedRoad {
  readonly fromId: number;
  readonly toId: number;
  readonly from: WorldPoint;
  readonly to: WorldPoint;
  readonly length: number;
}

export interface StaticRenderModel {
  readonly bounds: WorldBounds;
  readonly intersections: readonly RenderIntersection[];
  readonly segments: readonly RenderSegment[];
  /** Quiet lattice blocks; empty for non-lattice fixtures. */
  readonly blocks: readonly RenderBlock[];
  /** Directed road id -> index into `segments`. */
  readonly directedToSegment: readonly number[];
  /** Directed road id -> directional geometry (vehicle placement). */
  readonly roads: readonly RenderDirectedRoad[];
}

/** Fraction of a lattice cell removed to keep blocks visually quiet. */
const BLOCK_INSET = 0.16;

function isLattice(city: City): boolean {
  return (
    city.gridWidth >= 2 &&
    city.gridHeight >= 2 &&
    city.gridWidth * city.gridHeight === city.intersections.length
  );
}

function buildBlocks(city: City): RenderBlock[] {
  if (!isLattice(city)) {
    return [];
  }
  const width = city.gridWidth;
  const blocks: RenderBlock[] = [];
  for (let row = 0; row < city.gridHeight - 1; row += 1) {
    for (let col = 0; col < width - 1; col += 1) {
      const corners = [
        row * width + col,
        row * width + col + 1,
        (row + 1) * width + col + 1,
        (row + 1) * width + col,
      ].map((id) => city.intersections[id]);
      if (corners.some((corner) => corner === undefined)) {
        continue; // skip malformed cells instead of inventing geometry
      }
      const cx = corners.reduce((sum, corner) => sum + corner.x, 0) / corners.length;
      const cy = corners.reduce((sum, corner) => sum + corner.y, 0) / corners.length;
      blocks.push({
        points: corners.map((corner) => ({
          x: cx + (corner.x - cx) * (1 - BLOCK_INSET),
          y: cy + (corner.y - cy) * (1 - BLOCK_INSET),
        })),
      });
    }
  }
  return blocks;
}

export function buildRenderModel(city: City): StaticRenderModel {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const intersections: RenderIntersection[] = city.intersections.map((intersection) => {
    minX = Math.min(minX, intersection.x);
    minY = Math.min(minY, intersection.y);
    maxX = Math.max(maxX, intersection.x);
    maxY = Math.max(maxY, intersection.y);
    return {
      id: intersection.id,
      x: intersection.x,
      y: intersection.y,
      control: intersection.control,
      regionId: intersection.regionId,
    };
  });
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 0;
    maxY = 0;
  }

  const roads: RenderDirectedRoad[] = city.roads.map((road) => {
    const fromNode = city.intersections[road.from];
    const toNode = city.intersections[road.to];
    return {
      fromId: road.from,
      toId: road.to,
      from: { x: fromNode.x, y: fromNode.y },
      to: { x: toNode.x, y: toNode.y },
      length: road.length,
    };
  });
  const physical = physicalSegments(city);
  const directedToSegment = new Array<number>(city.roads.length).fill(-1);
  const segments: RenderSegment[] = physical.map((segment, index) => {
    const fromNode = city.intersections[segment.from];
    const toNode = city.intersections[segment.to];
    const dxRaw = toNode.x - fromNode.x;
    const dyRaw = toNode.y - fromNode.y;
    const length = Math.hypot(dxRaw, dyRaw) || 1;
    for (const roadId of segment.roadIds) {
      directedToSegment[roadId] = index;
    }
    return {
      id: segment.key,
      roadIds: segment.roadIds,
      kind: segment.kind,
      from: { x: fromNode.x, y: fromNode.y },
      to: { x: toNode.x, y: toNode.y },
      isBridge: segment.kind === "bridge",
      dx: dxRaw / length,
      dy: dyRaw / length,
      length,
    };
  });

  return {
    bounds: { minX, minY, maxX, maxY },
    intersections,
    segments,
    blocks: buildBlocks(city),
    directedToSegment,
    roads,
  };
}

/* ------------------------------- transforms ------------------------------- */

export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/**
 * Fits the world bounds into the canvas with uniform scale (aspect preserved;
 * x and y are never stretched independently) and stable padding.
 */
export function fitTransform(
  bounds: WorldBounds,
  cssWidth: number,
  cssHeight: number,
  paddingPx: number,
): ViewTransform {
  const worldWidth = Math.max(1e-6, bounds.maxX - bounds.minX);
  const worldHeight = Math.max(1e-6, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, cssWidth - paddingPx * 2);
  const availableHeight = Math.max(1, cssHeight - paddingPx * 2);
  const scale = Math.min(availableWidth / worldWidth, availableHeight / worldHeight);
  const offsetX = (cssWidth - worldWidth * scale) / 2 - bounds.minX * scale;
  const offsetY = (cssHeight - worldHeight * scale) / 2 - bounds.minY * scale;
  return { scale, offsetX, offsetY };
}

export function worldToScreen(transform: ViewTransform, point: WorldPoint): WorldPoint {
  return {
    x: transform.offsetX + point.x * transform.scale,
    y: transform.offsetY + point.y * transform.scale,
  };
}

/* ------------------------------- wait heat -------------------------------- */

/** 0 neutral · 1 warm · 2 orange · 3 red · 4 deep red. */
export type WaitHeatBucket = 0 | 1 | 2 | 3 | 4;

export const WAIT_HEAT_THRESHOLDS_MS = [5_000, 15_000, 30_000, 60_000] as const;

/** Semantic colors only: neutral grays through deep red. */
export const WAIT_HEAT_COLORS = [
  "#9aa1ab",
  "#d8a13d",
  "#e07b2f",
  "#d94a33",
  "#a01f1f",
] as const;

export function waitHeatBucket(blockedWaitMs: number): WaitHeatBucket {
  if (!Number.isFinite(blockedWaitMs) || blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[0]) {
    return 0;
  }
  if (blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[1]) {
    return 1;
  }
  if (blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[2]) {
    return 2;
  }
  if (blockedWaitMs < WAIT_HEAT_THRESHOLDS_MS[3]) {
    return 3;
  }
  return 4;
}

/**
 * Stable lane side for a directed road: +1 when it runs low-id -> high-id,
 * -1 for its structural reverse. Keeps opposite directions from overlapping.
 */
export function laneSignForRoad(road: { from: number; to: number } | undefined): 1 | -1 {
  if (!road) {
    return 1;
  }
  return road.from <= road.to ? 1 : -1;
}

export function laneOffsetSign(city: City, roadId: RoadId): 1 | -1 {
  return laneSignForRoad(city.roads[roadId]);
}
