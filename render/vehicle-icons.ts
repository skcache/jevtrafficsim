/**
 * Vehicle icon atlas (Task 11 polish pass): clean top-down silhouettes
 * generated locally on an offscreen canvas — no image assets, no network.
 *
 * Icons are drawn as WHITE masks so deck.gl can tint them: the body layer
 * paints class colours and the ring layer (the same sprite, drawn slightly
 * larger) paints the wait-heat halo. Browser-only (document); returns null
 * when there is no DOM.
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
}

const CELL_WIDTH = 96;
const CELL_HEIGHT = 48;

function drawCar(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.beginPath();
  ctx.roundRect(cx - 37, cy - 14.5, 74, 29, 10);
  ctx.fill();
  // Glass cut-outs: a car reads from above by its windshield and rear window.
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.roundRect(cx + 4, cy - 12, 15, 24, 4);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx - 24, cy - 11, 11, 22, 3);
  ctx.fill();
  // Roof line: one thin transverse cut keeps the cabin from reading as a slab.
  ctx.beginPath();
  ctx.rect(cx - 8, cy - 13, 3, 26);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

function drawTruck(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.beginPath();
  ctx.roundRect(cx - 43, cy - 16.5, 86, 33, 6);
  ctx.fill();
  ctx.globalCompositeOperation = "destination-out";
  // Cab / trailer split — the whole point of a truck silhouette.
  ctx.beginPath();
  ctx.rect(cx + 2, cy - 16, 5, 32);
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(cx + 9, cy - 13, 12, 26, 3);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

function drawBicycle(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
  ctx.lineWidth = 3.6;
  ctx.strokeStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx - 12, cy, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + 12, cy, 9, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - 12, cy);
  ctx.lineTo(cx - 1, cy - 8);
  ctx.lineTo(cx + 12, cy);
  ctx.moveTo(cx - 1, cy - 8);
  ctx.lineTo(cx - 1, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(cx - 5, cy - 14.5, 9, 7, 3);
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
  const cell = (index: number): VehicleIconDefinition => ({
    x: CELL_WIDTH * index,
    y: 0,
    width: CELL_WIDTH,
    height: CELL_HEIGHT,
    anchorX: CELL_WIDTH / 2,
    anchorY: CELL_HEIGHT / 2,
    mask: true,
  });
  return {
    atlas: canvas.toDataURL("image/png"),
    mapping: {
      car: cell(0),
      truck: cell(1),
      bicycle: cell(2),
    },
  };
}
