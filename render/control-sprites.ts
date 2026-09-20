/**
 * Contextual control sprites (Issue #26): a real three-lamp traffic-light head
 * and a stop sign.
 *
 * The old tiny signal markers are not the product. The head is the PRIMARY
 * signal language now: dark graphite housing, three lamp positions, exactly one
 * illuminated lamp, drawn large enough to read at follow-camera zoom. It is a
 * world object — sized in map metres by the layers, with a pixel floor only for
 * legibility.
 *
 * Rasterised synchronously with Path2D/text, like the vehicle, signal and
 * destination atlases: no image decode, no network.
 */

export const CONTROL_SPRITE_IDS = [
  "control-signal-red",
  "control-signal-yellow",
  "control-signal-green",
  "control-signal-neutral",
  "control-stop",
] as const;

export type ControlSpriteId = (typeof CONTROL_SPRITE_IDS)[number];

export interface ControlIconDefinition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly mask: boolean;
}

export interface ControlSpriteSet {
  readonly atlas: string;
  readonly mapping: Record<ControlSpriteId, ControlIconDefinition>;
}

const SIGNAL_CELL_W = 128;
const SIGNAL_CELL_H = 320;
const STOP_CELL = 256;
const SCALE = 2;

const HOUSING = "#23262a";
const HOUSING_EDGE = "#0f1113";
const HOUSING_HILITE = "#3a4046";

// Lamps fill the housing: at follow-camera zoom all three positions have to
// resolve, not just the lit one.
const LAMP = { x: 64, y: [66, 160, 254] as const, r: 47 };

/**
 * Dim lamps read as unlit lenses: dark, low saturation, just enough hue to show
 * the position. The lit lamp carries a glow ring and a specular core so exactly
 * one lamp is unmistakably ON at any size.
 */
const DIM = { red: "#3d211f", yellow: "#3c3119", green: "#1f3829" } as const;
const LIT = { red: "#ff4a3d", yellow: "#ffc93c", green: "#4ee06a" } as const;
const GLOW = { red: "#ff8a7a", yellow: "#ffe08a", green: "#9cf0b0" } as const;

function drawSignal(ctx: CanvasRenderingContext2D, lit: "red" | "yellow" | "green" | null): void {
  // Housing with a light top edge so it reads as a physical object.
  ctx.fillStyle = HOUSING_EDGE;
  ctx.beginPath();
  ctx.roundRect(6, 3, 116, 314, 28);
  ctx.fill();
  ctx.fillStyle = HOUSING;
  ctx.beginPath();
  ctx.roundRect(10, 7, 108, 306, 24);
  ctx.fill();
  ctx.fillStyle = HOUSING_HILITE;
  ctx.beginPath();
  ctx.roundRect(14, 11, 100, 10, 5);
  ctx.fill();

  const order = ["red", "yellow", "green"] as const;
  order.forEach((name, index) => {
    const cy = LAMP.y[index];
    // Recess: a dark well behind every lamp.
    ctx.fillStyle = "#16181b";
    ctx.beginPath();
    ctx.arc(LAMP.x, cy, LAMP.r + 4, 0, Math.PI * 2);
    ctx.fill();
    if (lit !== null && name === lit) {
      // Wide, light halo: the active lamp dominates the housing at any size.
      ctx.fillStyle = GLOW[name];
      ctx.beginPath();
      ctx.arc(LAMP.x, cy, LAMP.r + 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = LIT[name];
      ctx.beginPath();
      ctx.arc(LAMP.x, cy, LAMP.r, 0, Math.PI * 2);
      ctx.fill();
      // Specular core: unmistakably ON.
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.beginPath();
      ctx.arc(LAMP.x - 13, cy - 14, 13, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = DIM[name];
      ctx.beginPath();
      ctx.arc(LAMP.x, cy, LAMP.r, 0, Math.PI * 2);
      ctx.fill();
    }
  });
}

const STOP_RADIUS = 118;
const STOP_APOTHEM = STOP_RADIUS * Math.cos(Math.PI / 8);

function octagon(ctx: CanvasRenderingContext2D, cx: number, cy: number, radius: number): void {
  ctx.beginPath();
  for (let corner = 0; corner < 8; corner += 1) {
    const angle = (Math.PI / 8) + (corner * Math.PI) / 4;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (corner === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  }
  ctx.closePath();
}

function drawStop(ctx: CanvasRenderingContext2D): void {
  const cx = STOP_CELL / 2;
  const cy = STOP_CELL / 2;
  // Light rim first: the sign must read over blue, amber or red route.
  ctx.fillStyle = "#f6efe2";
  octagon(ctx, cx, cy, STOP_RADIUS);
  ctx.fill();
  ctx.fillStyle = "#b3312a";
  octagon(ctx, cx, cy, STOP_APOTHEM + 8);
  ctx.fill();
  ctx.strokeStyle = "#f6efe2";
  ctx.lineWidth = 7;
  octagon(ctx, cx, cy, STOP_APOTHEM - 4);
  ctx.stroke();
  ctx.fillStyle = "#f6efe2";
  ctx.font = "bold 62px ui-sans-serif, system-ui, -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("STOP", cx, cy + 3);
}

/** Signal head height in metres, and the sign's, in the shared scale contract. */
export function createControlSprites(): ControlSpriteSet | null {
  if (typeof document === "undefined") {
    return null;
  }
  const width = SIGNAL_CELL_W * 4 + STOP_CELL;
  const canvas = document.createElement("canvas");
  canvas.width = width * SCALE;
  canvas.height = SIGNAL_CELL_H * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.scale(SCALE, SCALE);

  const lit: Array<"red" | "yellow" | "green" | null> = ["red", "yellow", "green", null];
  lit.forEach((state, index) => {
    ctx.save();
    ctx.translate(SIGNAL_CELL_W * index, 0);
    drawSignal(ctx, state);
    ctx.restore();
  });
  ctx.save();
  ctx.translate(SIGNAL_CELL_W * 4, (SIGNAL_CELL_H - STOP_CELL) / 2);
  drawStop(ctx);
  ctx.restore();

  const signalCell = (index: number): ControlIconDefinition => ({
    x: SIGNAL_CELL_W * index * SCALE,
    y: 0,
    width: SIGNAL_CELL_W * SCALE,
    height: SIGNAL_CELL_H * SCALE,
    anchorX: (SIGNAL_CELL_W * SCALE) / 2,
    // The glyph stands on the kerb point: anchor at its base.
    anchorY: SIGNAL_CELL_H * SCALE,
    mask: false,
  });
  return {
    atlas: canvas.toDataURL("image/png"),
    mapping: {
      "control-signal-red": signalCell(0),
      "control-signal-yellow": signalCell(1),
      "control-signal-green": signalCell(2),
      "control-signal-neutral": signalCell(3),
      "control-stop": {
        x: SIGNAL_CELL_W * 4 * SCALE,
        y: ((SIGNAL_CELL_H - STOP_CELL) / 2) * SCALE,
        width: STOP_CELL * SCALE,
        height: STOP_CELL * SCALE,
        anchorX: (STOP_CELL * SCALE) / 2,
        anchorY: STOP_CELL * SCALE,
        mask: false,
      },
    },
  };
}
