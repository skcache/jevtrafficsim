/**
 * Vehicle icon atlas (Task 11 visual correction): clean top-down silhouettes
 * generated locally on an offscreen canvas — no image assets, no network.
 *
 * Icons are drawn as WHITE masks so deck.gl can tint them with wait-heat
 * colors. Browser-only (document); returns null when there is no DOM.
 */
import type { VehicleType } from "@/sim/types";

export interface VehicleIconDefinition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly mask: boolean;
}

export interface VehicleIconSet {
  readonly atlas: string;
  readonly mapping: Record<VehicleType, VehicleIconDefinition>;
  /** Pixel length of each class at reference zoom (car / truck / bicycle). */
  readonly lengths: Record<VehicleType, number>;
}

const CELL_WIDTH = 96;
const CELL_HEIGHT = 48;

function drawCar(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.beginPath();
  ctx.roundRect(cx - 37, cy - 15, 74, 30, 10);
  ctx.fill();
  // Windshield + rear window cut-outs make the silhouette read as a car.
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.roundRect(cx - 6, cy - 12, 16, 24, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - 26, cy - 11, 12, 22, 3);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

function drawTruck(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.beginPath();
  ctx.roundRect(cx - 43, cy - 17, 86, 34, 7);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  // Cab / trailer split.
  ctx.beginPath();
  ctx.rect(cx + 6, cy - 16, 5, 32);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - 36, cy - 13, 10, 26, 3);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

function drawBicycle(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.lineWidth = 3.4;
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx - 12, cy, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 12, cy, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx, cy - 9);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx, cy - 9);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(cx - 4, cy - 15, 9, 7, 3);
  ctx.fill();
}

export function createVehicleIcons(): VehicleIconSet | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = CELL_WIDTH * 3;
  canvas.height = CELL_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = "#ffffff";
  drawCar(ctx, CELL_WIDTH * 0.5, CELL_HEIGHT / 2);
  drawTruck(ctx, CELL_WIDTH * 1.5, CELL_HEIGHT / 2);
  drawBicycle(ctx, CELL_WIDTH * 2.5, CELL_HEIGHT / 2);
  const mapping: Record<VehicleType, VehicleIconDefinition> = {
    car: {
      x: 0,
      y: 0,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      anchorX: CELL_WIDTH / 2,
      anchorY: CELL_HEIGHT / 2,
      mask: true,
    },
    truck: {
      x: CELL_WIDTH,
      y: 0,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      anchorX: CELL_WIDTH / 2,
      anchorY: CELL_HEIGHT / 2,
      mask: true,
    },
    bicycle: {
      x: CELL_WIDTH * 2,
      y: 0,
      width: CELL_WIDTH,
      height: CELL_HEIGHT,
      anchorX: CELL_WIDTH / 2,
      anchorY: CELL_HEIGHT / 2,
      mask: true,
    },
  };
  return {
    atlas: canvas.toDataURL("image/png"),
    mapping,
    // Screen-space goals at close zoom: car 10-12 px, truck 15-18 px, bike 6-8 px.
    lengths: { car: 12, truck: 18, bicycle: 8 },
  };
}

/** Zoom-dependent icon scale with readable minimums at whole-city zoom. */
export function vehicleSizeScale(zoom: number): number {
  const t = Math.min(Math.max((zoom - 12) / 4.5, 0), 1);
  return 0.62 + 0.38 * t;
}
