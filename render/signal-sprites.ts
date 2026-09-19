/**
 * Signal sprites: a small hand-authored top-down atlas for traffic-light heads.
 *
 * The previous language was a coloured dot at the kerbside — one lamp painted
 * by a Scatterplot, with an optional housing sprite that production never
 * passed in (and whose placeholder icon mapping pointed at "car"). A dot is
 * instrumentation: at close zoom a signal has to read as a traffic-light head.
 *
 * Each state is a full portrait head, drawn from explicit vector paths the same
 * way the vehicle atlas is:
 *
 *   signal-red     top lamp lit, two dim
 *   signal-yellow  middle lamp lit, two dim
 *   signal-green   bottom lamp lit, two dim
 *
 * Colours are baked in — graphite housing, a restrained border, and the lit
 * lamp in the same muted palette the signal layer already used — so nothing is
 * tinted at draw time. The housing stays screen-aligned like a map annotation.
 * Approach direction is carried by the colored state gate across the road; the
 * head's only job is to read instantly as a familiar red/yellow/green light.
 *
 * Convention: sprites are centred in their cell; `getAngle` rotates them.
 */
import type { SignalStage } from "@/sim/signals";

export type SignalSpriteId = "signal-red" | "signal-yellow" | "signal-green";

export const SIGNAL_SPRITE_IDS: readonly SignalSpriteId[] = [
  "signal-red",
  "signal-yellow",
  "signal-green",
];

interface SpritePart {
  /** SVG path data. */
  readonly d: string;
  readonly fill: string;
}

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/** Lit lamps, matching the muted signal palette the layer already used. */
const LIT_RED = "#e64b43";
const LIT_YELLOW = "#e2a329";
const LIT_GREEN = "#2fa463";

/** Housing and its restrained border. */
const HOUSING = "#34383d";
const HOUSING_BORDER = "#171a1d";
/** Lamps that are not lit: present, but barely there. */
const LAMP_DIM = "#1f2327";

/* ------------------------------------------------------------------ */
/* Geometry helpers (authoring-time path data)                         */
/* ------------------------------------------------------------------ */

function roundedRectPath(cx: number, cy: number, w: number, h: number, r: number): string {
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  return [
    `M ${x0 + r},${y0}`,
    `L ${x1 - r},${y0}`,
    `A ${r},${r} 0 0 1 ${x1},${y0 + r}`,
    `L ${x1},${y1 - r}`,
    `A ${r},${r} 0 0 1 ${x1 - r},${y1}`,
    `L ${x0 + r},${y1}`,
    `A ${r},${r} 0 0 1 ${x0},${y1 - r}`,
    `L ${x0},${y0 + r}`,
    `A ${r},${r} 0 0 1 ${x0 + r},${y0}`,
    "Z",
  ].join(" ");
}

function circlePath(cx: number, cy: number, r: number): string {
  return `M ${cx - r},${cy} A ${r},${r} 0 1 1 ${cx + r},${cy} A ${r},${r} 0 1 1 ${cx - r},${cy} Z`;
}

/* ------------------------------------------------------------------ */
/* Sprite definition                                                   */
/* ------------------------------------------------------------------ */

/** Housing extent in sprite units (the cell is 64 × 128). */
export const SIGNAL_SPRITE_UNITS = { width: 44, height: 100 } as const;

/** Lamp centres, top (red) to bottom (green), in sprite units. */
export const SIGNAL_LAMP_OFFSETS_Y: readonly [number, number, number] = [-31, 0, 31];

const LAMP_RADIUS = 12.5;
/** Inner highlight radius: reads as "lit" without glowing. */
const LAMP_CORE_RADIUS = 4;

/** Which lamp each state lights: 0 = top (red), 1 = middle, 2 = bottom. */
export const SIGNAL_SPRITE_LIT_LAMP: Record<SignalSpriteId, 0 | 1 | 2> = {
  "signal-red": 0,
  "signal-yellow": 1,
  "signal-green": 2,
};

const LIT_COLOR: Record<SignalSpriteId, string> = {
  "signal-red": LIT_RED,
  "signal-yellow": LIT_YELLOW,
  "signal-green": LIT_GREEN,
};

function signalSprite(lit: 0 | 1 | 2): readonly SpritePart[] {
  const { width, height } = SIGNAL_SPRITE_UNITS;
  const parts: SpritePart[] = [
    // Two clean masses survive rasterisation at 16 px far better than the old
    // three nested rectangles, which collapsed into a black dash.
    { d: roundedRectPath(0, 0, width, height, 9), fill: HOUSING_BORDER },
    { d: roundedRectPath(0, 0, width - 5, height - 5, 7), fill: HOUSING },
  ];
  const id = (Object.keys(SIGNAL_SPRITE_LIT_LAMP) as SignalSpriteId[]).find(
    (key) => SIGNAL_SPRITE_LIT_LAMP[key] === lit,
  ) as SignalSpriteId;
  SIGNAL_LAMP_OFFSETS_Y.forEach((offsetY, index) => {
    const isLit = index === lit;
    parts.push({
      d: circlePath(0, offsetY, LAMP_RADIUS),
      fill: isLit ? LIT_COLOR[id] : LAMP_DIM,
    });
    if (isLit) {
      // A small core, so the lit lamp reads as a lamp rather than a flat disc.
      parts.push({ d: circlePath(0, offsetY, LAMP_CORE_RADIUS), fill: "#e8e4dc" });
    }
  });
  return parts;
}

export const SIGNAL_SPRITE_PATHS: Record<SignalSpriteId, readonly SpritePart[]> = {
  "signal-red": signalSprite(0),
  "signal-yellow": signalSprite(1),
  "signal-green": signalSprite(2),
};

/**
 * Which sprite an approach shows. Only the group that currently holds the
 * stage shows its colour; every other approach reads red, as before.
 */
export function signalSpriteForStage(stage: SignalStage, activeApproach: boolean): SignalSpriteId {
  if (!activeApproach) {
    return "signal-red";
  }
  if (stage === "green") {
    return "signal-green";
  }
  if (stage === "yellow") {
    return "signal-yellow";
  }
  return "signal-red";
}

/* ------------------------------------------------------------------ */
/* Atlas                                                               */
/* ------------------------------------------------------------------ */

export interface SignalIconDefinition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly mask: boolean;
}

export interface SignalSpriteSet {
  readonly atlas: string;
  readonly mapping: Record<SignalSpriteId, SignalIconDefinition>;
}

const CELL_WIDTH = 64;
const CELL_HEIGHT = 128;
/** Rasterise at 2× so the housing stays crisp when the camera is close. */
const SCALE = 2;

/**
 * Rasterise the atlas. Synchronous, like the vehicle atlas: `Path2D` takes the
 * SVG path data directly, so there is no image decode and no network.
 *
 * Returns null without a DOM. Callers must NOT substitute a coloured dot: a
 * signal that cannot be drawn is hidden, and the debug tooling reports it.
 */
export function createSignalSprites(): SignalSpriteSet | null {
  if (typeof document === "undefined") {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = CELL_WIDTH * SIGNAL_SPRITE_IDS.length * SCALE;
  canvas.height = CELL_HEIGHT * SCALE;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.scale(SCALE, SCALE);
  SIGNAL_SPRITE_IDS.forEach((id, index) => {
    ctx.save();
    ctx.translate(CELL_WIDTH * (index + 0.5), CELL_HEIGHT / 2);
    for (const part of SIGNAL_SPRITE_PATHS[id]) {
      ctx.fillStyle = part.fill;
      ctx.fill(new Path2D(part.d));
    }
    ctx.restore();
  });
  const cell = (index: number): SignalIconDefinition => ({
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
      "signal-red": cell(0),
      "signal-yellow": cell(1),
      "signal-green": cell(2),
    },
  };
}

/**
 * deck.gl sizes an icon by its HEIGHT, while a signal's size on screen is the
 * housing's height. This converts the target housing height into the value
 * `getSize` wants, from the sprite's own proportions.
 */
export function signalIconSizeForHousingPx(housingPx: number): number {
  return (housingPx * CELL_HEIGHT) / SIGNAL_SPRITE_UNITS.height;
}
