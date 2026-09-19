/**
 * Vehicle sprites: a small hand-authored top-down atlas.
 *
 * The previous glyphs were rounded capsules — a car was a pill with two
 * cut-outs — which is why close zoom read as placeholders. These are drawn from
 * explicit vector paths, so each class has a silhouette you can identify at a
 * glance and a front you can point at:
 *
 *   car    tapered nose, windshield band, cabin, rear window, four wheel nubs
 *   truck  long box body, separate cab, five wheels, heavier rear
 *   bike   thin frame, two wire wheels, handlebar — nothing like a small car
 *
 * Shapes are SVG path data (the single source of truth for each part) drawn
 * through `Path2D`, which accepts SVG path strings directly: the atlas is
 * authored as SVG and rasterised synchronously, with no image loading and no
 * network. Colours are baked in per class — restrained graphite, warm grey and
 * muted blue-grey — so nothing is tinted at draw time and the palette cannot
 * drift into rainbow vehicles.
 *
 * Convention: every sprite points along +X (front at the right) and is centred
 * in its cell, which is what deck.gl's `getAngle` rotation expects.
 */
import type { VehicleType } from "@/sim/types";
import type { VehicleIconDefinition, VehicleIconSet } from "./vehicle-icons";

interface SpritePart {
  /** SVG path data. */
  readonly d: string;
  readonly fill: string;
}

/** Length/width of each class in sprite units (the cell is 128 × 64). */
const SPRITE_UNITS: Record<VehicleType, { length: number; width: number }> = {
  car: { length: 96, width: 34 },
  truck: { length: 120, width: 40 },
  bicycle: { length: 46, width: 14 },
};

export const VEHICLE_SPRITE_PATHS: Record<VehicleType, readonly SpritePart[]> = {
  // Front at +X: nose tapers, windshield sits behind it, cabin then rear glass.
  car: [
    {
      d: "M 44,0 L 36,-9 L 16,-14 L -34,-14 L -46,-8 L -46,8 L -34,14 L 16,14 L 36,9 Z",
      fill: "#3f4348",
    },
    // Windshield: a trapezoid, widest at the cabin side.
    { d: "M 34,-7 L 20,-11 L 20,11 L 34,7 Z", fill: "#7d8894" },
    // Roof panel, then the rear window.
    { d: "M 18,-11 L -14,-11 L -14,11 L 18,11 Z", fill: "#4a4f55" },
    { d: "M -16,-11 L -32,-10 L -32,10 L -16,11 Z", fill: "#6c7681" },
    // Wheels: four nubs that break the silhouette at the corners.
    { d: "M 24,-16 L 34,-16 L 34,-13 L 24,-13 Z", fill: "#23262a" },
    { d: "M 24,13 L 34,13 L 34,16 L 24,16 Z", fill: "#23262a" },
    { d: "M -30,-16 L -18,-16 L -18,-13 L -30,-13 Z", fill: "#23262a" },
    { d: "M -30,13 L -18,13 L -18,16 L -30,16 Z", fill: "#23262a" },
  ],
  // A truck is a cab and a box, not a longer car.
  truck: [
    // Box body (rear two thirds).
    { d: "M -58,-19 L 10,-19 L 10,19 L -58,19 Z", fill: "#55524c" },
    // Cab, narrower and set behind a short nose.
    { d: "M 12,-17 L 44,-14 L 50,-6 L 50,6 L 44,14 L 12,17 Z", fill: "#6a665e" },
    { d: "M 40,-11 L 47,-5 L 47,5 L 40,11 Z", fill: "#8792a0" },
    // Cargo ribs, so the box reads as a box.
    { d: "M -50,-17 L -47,-17 L -47,17 L -50,17 Z", fill: "#494640" },
    { d: "M -34,-18 L -31,-18 L -31,18 L -34,18 Z", fill: "#494640" },
    { d: "M -18,-18 L -15,-18 L -15,18 L -18,18 Z", fill: "#494640" },
    { d: "M -2,-18 L 1,-18 L 1,18 L -2,18 Z", fill: "#494640" },
    // Five wheels: two steer, four drive (paired).
    { d: "M 30,-21 L 42,-21 L 42,-17 L 30,-17 Z", fill: "#23262a" },
    { d: "M 30,17 L 42,17 L 42,21 L 30,21 Z", fill: "#23262a" },
    { d: "M -30,-22 L -14,-22 L -14,-18 L -30,-18 Z", fill: "#23262a" },
    { d: "M -30,18 L -14,18 L -14,22 L -30,22 Z", fill: "#23262a" },
    { d: "M -10,-22 L 6,-22 L 6,-18 L -10,-18 Z", fill: "#23262a" },
    { d: "M -10,18 L 6,18 L 6,22 L -10,22 Z", fill: "#23262a" },
  ],
  // Thin frame, wire wheels, handlebar. Deliberately nothing like a tiny car.
  bicycle: [
    { d: "M -16,-7 A 7,7 0 1 1 -16,7 A 7,7 0 1 1 -16,-7 Z", fill: "#4a5b6b" },
    { d: "M 16,-7 A 7,7 0 1 1 16,7 A 7,7 0 1 1 16,-7 Z", fill: "#4a5b6b" },
    { d: "M -16,-5 A 5,5 0 1 1 -16,5 A 5,5 0 1 1 -16,-5 Z", fill: "#e8e6e1" },
    { d: "M 16,-5 A 5,5 0 1 1 16,5 A 5,5 0 1 1 16,-5 Z", fill: "#e8e6e1" },
    // Frame: down tube, top tube, seat stay.
    { d: "M -14,0 L 0,-4 L 14,0 L 0,0 Z", fill: "#4a5b6b" },
    { d: "M -1,-4 L 1,-4 L 1,5 L -1,5 Z", fill: "#4a5b6b" },
    // Handlebar across the front, saddle behind the rider.
    { d: "M 12,-6 L 15,-6 L 15,6 L 12,6 Z", fill: "#33383f" },
    { d: "M -8,-4 L -5,-4 L -5,4 L -8,4 Z", fill: "#33383f" },
  ],
};

/** Body colours are restrained on purpose: no rainbow vehicles. */
export const VEHICLE_SPRITE_TINT: Record<VehicleType, string> = {
  car: "#3f4348",
  truck: "#55524c",
  bicycle: "#4a5b6b",
};

const CELL_WIDTH = 128;
const CELL_HEIGHT = 64;
/** Rasterise at 2× so sprites stay crisp when the camera is close. */
const SCALE = 2;

/**
 * Rasterise the atlas. Synchronous: `Path2D` takes the SVG path data directly,
 * so there is no image decode step and no network.
 */
export function createVehicleSprites(): VehicleIconSet | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = CELL_WIDTH * 3 * SCALE;
  canvas.height = CELL_HEIGHT * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.scale(SCALE, SCALE);
  const order: VehicleType[] = ["car", "truck", "bicycle"];
  order.forEach((type, index) => {
    const cx = CELL_WIDTH * (index + 0.5);
    const cy = CELL_HEIGHT / 2;
    ctx.save();
    ctx.translate(cx, cy);
    for (const part of VEHICLE_SPRITE_PATHS[type]) {
      ctx.fillStyle = part.fill;
      ctx.fill(new Path2D(part.d));
    }
    ctx.restore();
  });
  const cell = (index: number): VehicleIconDefinition => ({
    x: CELL_WIDTH * index * SCALE,
    y: 0,
    width: CELL_WIDTH * SCALE,
    height: CELL_HEIGHT * SCALE,
    anchorX: (CELL_WIDTH * SCALE) / 2,
    anchorY: (CELL_HEIGHT * SCALE) / 2,
    // Colours are baked in, so deck.gl must not tint the sprite.
    mask: false,
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

/** Sprite length in cell units, so callers can size glyphs proportionally. */
export function spriteLengthUnits(type: VehicleType): number {
  return SPRITE_UNITS[type].length;
}

/**
 * deck.gl sizes an icon by its HEIGHT, while a vehicle's size on screen is its
 * LENGTH along the road. This converts the target length into the value
 * `getSize` wants, from the sprite's own proportions.
 */
export function iconSizeForLengthPx(type: VehicleType, lengthPx: number): number {
  return (lengthPx * CELL_HEIGHT) / SPRITE_UNITS[type].length;
}

/** Aspect (length : height) of a class's sprite, for pixel sizing. */
export function spriteAspect(type: VehicleType): number {
  const { length, width } = SPRITE_UNITS[type];
  return length / width;
}

/**
 * Signal housing: a small dark body that reads as a traffic-light head from
 * above. Lamps are drawn as separate dots by the signal layer, so only the
 * active lamp carries strong colour and the housing never glows.
 */
export function createSignalHousing(): VehicleIconSet | null {
  if (typeof document === "undefined") {
    return null;
  }
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.fillStyle = "#3a3f45";
  ctx.beginPath();
  ctx.roundRect(2, 2, size - 4, size - 4, 6);
  ctx.fill();
  ctx.strokeStyle = "#2a2e33";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(3, 3, size - 6, size - 6, 5);
  ctx.stroke();
  const definition = {
    x: 0,
    y: 0,
    width: size,
    height: size,
    anchorX: size / 2,
    anchorY: size / 2,
    mask: false,
  };
  return {
    atlas: canvas.toDataURL("image/png"),
    mapping: { car: definition, truck: definition, bicycle: definition },
  };
}
