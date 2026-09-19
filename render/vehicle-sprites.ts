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
  // Front at +X. Detail is deliberately coarse: a car renders about 12 px long,
  // so anything finer than ~2 px of sprite becomes a smudge. One bold windshield
  // band is what makes the front obvious; the roof and rear glass only have to
  // separate it.
  car: [
    {
      d: "M 44,0 L 36,-9 L 16,-14 L -34,-14 L -46,-8 L -46,8 L -34,14 L 16,14 L 36,9 Z",
      fill: "#3f4348",
    },
    // Windshield: wide and clearly lighter, right behind the nose.
    { d: "M 34,-8 L 12,-12 L 12,12 L 34,8 Z", fill: "#93a0ad" },
    // Roof between the two glass bands.
    { d: "M 10,-12 L -14,-12 L -14,12 L 10,12 Z", fill: "#464b51" },
    // Rear glass, narrower and darker than the windshield.
    { d: "M -16,-12 L -34,-10 L -34,10 L -16,12 Z", fill: "#6d7883" },
    // Wheels break the silhouette at the four corners.
    { d: "M 24,-16 L 36,-16 L 36,-12 L 24,-12 Z", fill: "#202327" },
    { d: "M 24,12 L 36,12 L 36,16 L 24,16 Z", fill: "#202327" },
    { d: "M -32,-16 L -18,-16 L -18,-12 L -32,-12 Z", fill: "#202327" },
    { d: "M -32,12 L -18,12 L -18,16 L -32,16 Z", fill: "#202327" },
  ],
  // A truck is a cab and a box. Ribs and small detail vanish at 19 px, so the
  // only interior marks are one bold glass band and the cab/box joint.
  truck: [
    { d: "M -58,-19 L 10,-19 L 10,19 L -58,19 Z", fill: "#55524c" },
    { d: "M 12,-17 L 44,-14 L 50,-6 L 50,6 L 44,14 L 12,17 Z", fill: "#6f6a61" },
    { d: "M 38,-12 L 46,-5 L 46,5 L 38,12 Z", fill: "#93a0ad" },
    // The joint between cab and box.
    { d: "M 10,-19 L 14,-19 L 14,19 L 10,19 Z", fill: "#3f3c37" },
    // Rear door line, the one detail a box needs.
    { d: "M -56,-18 L -52,-18 L -52,18 L -56,18 Z", fill: "#454239" },
    // Six wheels: two steer, four drive.
    { d: "M 30,-22 L 44,-22 L 44,-17 L 30,-17 Z", fill: "#202327" },
    { d: "M 30,17 L 44,17 L 44,22 L 30,22 Z", fill: "#202327" },
    { d: "M -32,-23 L -14,-23 L -14,-18 L -32,-18 Z", fill: "#202327" },
    { d: "M -32,18 L -14,18 L -14,23 L -32,23 Z", fill: "#202327" },
    { d: "M -10,-23 L 6,-23 L 6,-18 L -10,-18 Z", fill: "#202327" },
    { d: "M -10,18 L 6,18 L 6,23 L -10,23 Z", fill: "#202327" },
  ],
  // At ~7 px long, an outlined wheel is invisible: the wheels are filled discs
  // and the frame is one bold bar. Still unmistakably not a small car.
  bicycle: [
    { d: "M -17,-7 A 7,7 0 1 1 -17,7 A 7,7 0 1 1 -17,-7 Z", fill: "#3c4a57" },
    { d: "M 17,-7 A 7,7 0 1 1 17,7 A 7,7 0 1 1 17,-7 Z", fill: "#3c4a57" },
    { d: "M -17,-3.5 A 3.5,3.5 0 1 1 -17,3.5 A 3.5,3.5 0 1 1 -17,-3.5 Z", fill: "#e8e6e1" },
    { d: "M 17,-3.5 A 3.5,3.5 0 1 1 17,3.5 A 3.5,3.5 0 1 1 17,-3.5 Z", fill: "#e8e6e1" },
    // Frame bar plus the rider's shoulders: enough to read as a bicycle.
    { d: "M -15,-2.5 L 15,-2.5 L 15,2.5 L -15,2.5 Z", fill: "#4a5b6b" },
    { d: "M -6,-5 L 6,-5 L 6,5 L -6,5 Z", fill: "#33383f" },
    { d: "M 12,-6.5 L 15,-6.5 L 15,6.5 L 12,6.5 Z", fill: "#2b3036" },
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
