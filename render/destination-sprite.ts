/**
 * Destination marker sprite (Issue #25).
 *
 * A map pin: cream outline, ink body, small cream core, tip anchored at the
 * destination intersection. Rasterised synchronously with Path2D like the
 * vehicle and signal atlases — no image decode, no network, deterministic
 * pixels. Draw at 2× so it stays crisp as the camera approaches.
 */

export interface DestinationSpriteSet {
  readonly atlas: string;
  readonly mapping: Record<string, DestinationIconDefinition>;
}

export interface DestinationIconDefinition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly mask: boolean;
}

const CELL_WIDTH = 96;
const CELL_HEIGHT = 128;
const SCALE = 2;

/** Teardrop body: radius ~39 px head, tail down to the anchor point. */
const PIN_BODY =
  "M48 10 C27.5 10 11 26.5 11 47 C11 70 31 93 48 121 C65 93 85 70 85 47 C85 26.5 68.5 10 48 10 Z";
const PIN_OUTLINE =
  "M48 4 C24.6 4 5 23.6 5 47 C5 72.5 25.5 96.5 42.6 124.5 C45.2 129 50.8 129 53.4 124.5 C70.5 96.5 91 72.5 91 47 C91 23.6 71.4 4 48 4 Z";
const PIN_CORE = "M48 32 A15 15 0 1 1 47.99 32 Z";

export const DESTINATION_SPRITE_ID = "destination-pin";

export function createDestinationSprites(): DestinationSpriteSet | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = CELL_WIDTH * SCALE;
  canvas.height = CELL_HEIGHT * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.scale(SCALE, SCALE);
  // Soft cream outline first: the pin stays legible over blue, amber or red.
  ctx.fillStyle = "#fbf8f1";
  ctx.fill(new Path2D(PIN_OUTLINE));
  ctx.fillStyle = "#211d18";
  ctx.fill(new Path2D(PIN_BODY));
  ctx.fillStyle = "#fbf8f1";
  ctx.fill(new Path2D(PIN_CORE));
  const cell: DestinationIconDefinition = {
    x: 0,
    y: 0,
    width: CELL_WIDTH * SCALE,
    height: CELL_HEIGHT * SCALE,
    anchorX: (CELL_WIDTH * SCALE) / 2,
    // Tip at the destination: the anchor is the BOTTOM of the sprite.
    anchorY: CELL_HEIGHT * SCALE,
    mask: false,
  };
  return {
    atlas: canvas.toDataURL("image/png"),
    mapping: { [DESTINATION_SPRITE_ID]: cell },
  };
}
