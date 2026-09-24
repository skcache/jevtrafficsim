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
 * in its cell. See `spriteAngleDegrees` for the rotation that follows from it.
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
  car: { length: 96, width: 32 },
  truck: { length: 120, width: 40 },
  bicycle: { length: 46, width: 14 },
};

export const VEHICLE_SPRITE_PATHS: Record<VehicleType, readonly SpritePart[]> = {
  // Front at +X. Detail is deliberately coarse: a car renders about 12 px long,
  // so anything finer than ~2 px of sprite becomes a smudge. One bold windshield
  // band is what makes the front obvious; the roof and rear glass only have to
  // separate it.
  // Front at +X. Rounded bodywork, one glass band forward and one aft, wheels
  // tucked INSIDE the silhouette: at follow zoom this has to read as a car seen
  // from above, not as a dark blob with corners. The outline is drawn first and
  // slightly larger, which is cheaper and crisper than a stroked path here.
  car: [
    {
      d: "M 49,0 C 49,-6.5 45,-10.5 37,-12 L -37,-13.6 C -45,-13.6 -49,-10.5 -49,-6 L -49,6 C -49,10.5 -45,13.6 -37,13.6 L 37,12 C 45,10.5 49,6.5 49,0 Z",
      fill: "#2c3036",
    },
    {
      d: "M 47,0 C 47,-5.8 43,-9.4 36,-10.8 L -36,-12.4 C -43,-12.4 -47,-9.6 -47,-5.4 L -47,5.4 C -47,9.6 -43,12.4 -36,12.4 L 36,10.8 C 43,9.4 47,5.8 47,0 Z",
      fill: "#7c8794",
    },
    // Windshield: the widest, lightest band, right behind the nose.
    {
      d: "M 33,-8.6 C 27,-10 23,-10.6 19,-10.6 L 19,10.6 C 23,10.6 27,10 33,8.6 Z",
      fill: "#b6c5d4",
    },
    // Roof: a slightly darker slab between the two glass bands.
    { d: "M 17,-10.6 L -13,-11.1 L -13,11.1 L 17,10.6 Z", fill: "#69737f" },
    // Rear glass, narrower and cooler than the windshield.
    {
      d: "M -15,-11.1 L -33,-11.6 C -35,-11.6 -36,-10.6 -36,-9.2 L -36,9.2 C -36,10.6 -35,11.6 -33,11.6 L -15,11.1 Z",
      fill: "#9dafc0",
    },
    // Wheels, tucked under the body edge so they read as contact patches.
    { d: "M 25,-14.6 L 37,-14.2 L 37,-11.2 L 25,-11.4 Z", fill: "#23262b" },
    { d: "M 25,11.4 L 37,11.2 L 37,14.2 L 25,14.6 Z", fill: "#23262b" },
    { d: "M -35,-14.6 L -23,-14.8 L -23,-11.9 L -35,-11.8 Z", fill: "#23262b" },
    { d: "M -35,11.8 L -23,11.9 L -23,14.8 L -35,14.6 Z", fill: "#23262b" },
    // Headlights: two small warm marks that say which end is the front.
    { d: "M 45,-7.4 L 47.5,-5.6 L 47.5,-1.4 L 45,-2.2 Z", fill: "#f2e6c8" },
    { d: "M 45,7.4 L 47.5,5.6 L 47.5,1.4 L 45,2.2 Z", fill: "#f2e6c8" },
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
  car: "#7c8794",
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
export function iconSizeForLengthUnits(type: VehicleType, length: number): number {
  return (length * CELL_HEIGHT) / SPRITE_UNITS[type].length;
}

/** Backward-compatible alias for tests/helpers that still speak in pixels. */
export function iconSizeForLengthPx(type: VehicleType, lengthPx: number): number {
  return iconSizeForLengthUnits(type, lengthPx);
}

/** Aspect (length : height) of a class's sprite, for pixel sizing. */
export function spriteAspect(type: VehicleType): number {
  const { length, width } = SPRITE_UNITS[type];
  return length / width;
}

/**
 * deck.gl IconLayer angle for a vehicle heading.
 *
 * Settled from deck.gl's own shader, which is the only authority here
 * (icon-layer-vertex.glsl):
 *
 *     pixelOffset = rotate_by_angle(pixelOffset, instanceAngles) * instanceScale;
 *     pixelOffset.y *= -1.0;      // the flip lands AFTER the rotation
 *
 * The rotation happens in a y-down space and the flip lands afterwards, so
 * `getAngle` ends up counter-clockwise - the same sense as Math.atan2. The
 * heading goes through unchanged.
 *
 * The previous version negated it on a "deck.gl rotates clockwise" assumption
 * (and a test was written to match that assumption). It mirrored every vehicle:
 * a car at heading T was drawn at -T, i.e. 2T away from its road. On an
 * east-west street 2T = 0, so those cars looked right; north-south cars were
 * 180 degrees out; and on the 45-degree diagonal that the route's Lake Shore
 * Drive follows, the car was drawn exactly 90 degrees sideways. Measured on the
 * live map: a sprite's long axis sat 45 degrees off a horizontal road.
 */
export function spriteAngleDegrees(headingRadians: number): number {
  // deck.gl applies the rotation BEFORE its y-flip (icon-layer-vertex.glsl:
  // `rotate_by_angle(...)` then `pixelOffset.y *= -1.0`), so `getAngle` is
  // counter-clockwise - the same sense as Math.atan2 - and the heading passes
  // through unchanged. Negating it here mirrors every vehicle: a car at heading
  // T is drawn at -T, i.e. 2T off its road. Invisible on east-west streets,
  // 180 degrees out on north-south, and exactly 90 degrees sideways on the
  // 45-degree diagonal that the route's Lake Shore Drive follows.
  return (headingRadians * 180) / Math.PI;
}
