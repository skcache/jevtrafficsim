"use client";

/**
 * ControlTile (Issue #46; made an OBJECT in the tile-as-object pass).
 *
 * The ONE control surface in the top-right corner while a control ahead is
 * relevant. It renders the state the map marker is showing, from the same
 * derivation (`deriveControlTile`, built on the marker's own sprite decision),
 * so the two can never disagree.
 *
 * It is a TILE THAT SHOWS THE OBJECT, not a dot beside a word: a complete
 * three-lamp signal head with the authoritative lamp lit and the other two
 * unlit, or a complete stop-sign octagon with STOP on its face. A viewer who has
 * never seen this product should know what it is in one glance.
 *
 * Both objects are drawn in the marker sprite's OWN coordinate systems
 * (render/control-sprites.ts: a 128x320 head cell, a 256x256 sign cell) with the
 * marker's own housing and sign inks, so the tile and the roadside marker read as
 * the same physical object at two sizes. The only STATE ink in this file is
 * `CONTROL_MARKER_COLORS` — never a literal, never a guessed colour, never a
 * countdown, and nothing animated that implies progress. When the state is null
 * the tile renders nothing, and it disappears the moment the control is passed.
 */
import { AnimatePresence, motion } from "motion/react";
import { CONTROL_MARKER_COLORS } from "@/render/control-sprites";
import type { ControlTileLamp, ControlTileState } from "@/render/control-tile";

const LAMP_LABEL: Record<ControlTileLamp, string> = {
  green: "Green",
  yellow: "Yellow",
  red: "Red",
};

const EASE = [0.22, 1, 0.36, 1] as const;

/* ------------------------------------------------------------------ */
/* Object inks                                                         */
/* ------------------------------------------------------------------ */

/**
 * The head's physical inks: the same graphite housing, lamp wells and housing
 * sheen the roadside sprite draws. These are the OBJECT, never a state — the
 * authoritative lamp colours come from CONTROL_MARKER_COLORS and nothing else.
 */
const HOUSING_EDGE = "#0f1113";
const HOUSING = "#23262a";
const HOUSING_SHEEN = "#3a4046";
const LAMP_WELL = "#16181b";
/**
 * An unlit lens is the marker's own colour laid into its well at a low alpha:
 * dark and low-saturation, so it reads as a lens that is OFF rather than as a
 * second lamp that is on (bright "dim" lamps read as lit).
 */
const UNLIT_ALPHA = 0.22;
/** The sign's white — the marker sprite's own sign tone. */
const SIGN_WHITE = "#f6efe2";

/* ------------------------------------------------------------------ */
/* Size                                                                */
/* ------------------------------------------------------------------ */

/** The tile's content box, in px: the stop sign spans it, the head centres in it. */
const OBJECT_WIDTH = 104;
/**
 * A three-lamp head is ~1:2.5 by construction (three lenses stacked in a
 * housing), so the signal is a tall object in a fixed-width tile.
 */
const SIGNAL_WIDTH = 76;
const SIGNAL_HEIGHT = Math.round((SIGNAL_WIDTH * 320) / 128);

/* ------------------------------------------------------------------ */
/* The signal head — the whole object                                  */
/* ------------------------------------------------------------------ */

/** The three lamp positions in the sprite's own cell: red on top, green at the bottom. */
const SIGNAL_LAMPS = [
  { lamp: "red", cy: 66 },
  { lamp: "yellow", cy: 160 },
  { lamp: "green", cy: 254 },
] as const;

/** A complete three-lamp head: housing, three wells, one lamp lit at full colour. */
function SignalHead({ lit }: { lit: ControlTileLamp }) {
  return (
    <svg
      aria-hidden="true"
      className="block"
      width={SIGNAL_WIDTH}
      height={SIGNAL_HEIGHT}
      viewBox="0 0 128 320"
    >
      <rect x={6} y={3} width={116} height={314} rx={28} fill={HOUSING_EDGE} />
      <rect x={10} y={7} width={108} height={306} rx={24} fill={HOUSING} />
      <rect x={14} y={11} width={100} height={10} rx={5} fill={HOUSING_SHEEN} />
      {SIGNAL_LAMPS.map(({ lamp, cy }) => {
        const on = lamp === lit;
        return (
          <g key={lamp}>
            <circle cx={64} cy={cy} r={51} fill={LAMP_WELL} />
            <circle
              cx={64}
              cy={cy}
              r={47}
              fill={CONTROL_MARKER_COLORS[lamp]}
              fillOpacity={on ? 1 : UNLIT_ALPHA}
            />
            {on && <circle cx={51} cy={cy - 14} r={13} fill="#ffffff" fillOpacity={0.55} />}
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The stop sign — the whole object                                    */
/* ------------------------------------------------------------------ */

/** Octagon geometry, in the sprite's own 256x256 sign cell. */
const SIGN_RADIUS = 117;
const SIGN_CENTER = 128;

function octagonPoints(radius: number): string {
  return Array.from({ length: 8 }, (_, corner) => {
    const angle = Math.PI / 8 + (corner * Math.PI) / 4;
    return `${(SIGN_CENTER + Math.cos(angle) * radius).toFixed(2)},${(SIGN_CENTER + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(" ");
}

const SIGN_FACE = octagonPoints(SIGN_RADIUS);
/** The white band just inside the face, as on the roadside sign. */
const SIGN_BAND = octagonPoints(SIGN_RADIUS * Math.cos(Math.PI / 8) - 4);

/** The entire sign as an object: red octagon, white band, STOP on its face. */
function StopSign() {
  return (
    <svg
      aria-hidden="true"
      className="block"
      width={OBJECT_WIDTH}
      height={OBJECT_WIDTH}
      viewBox="0 0 256 256"
    >
      <polygon
        points={SIGN_FACE}
        fill={CONTROL_MARKER_COLORS.stop}
        stroke={CONTROL_MARKER_COLORS.stop}
        strokeWidth={6}
        strokeLinejoin="round"
      />
      <polygon
        points={SIGN_BAND}
        fill="none"
        stroke={SIGN_WHITE}
        strokeWidth={7}
        strokeLinejoin="round"
      />
      <text
        x={SIGN_CENTER}
        y={SIGN_CENTER}
        dy="0.35em"
        textAnchor="middle"
        fontSize={62}
        fontWeight={700}
        letterSpacing={1}
        fill={SIGN_WHITE}
        className="font-sans"
      >
        STOP
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* The tile                                                            */
/* ------------------------------------------------------------------ */

/**
 * The visible object is the star; the state is still carried in text for
 * assistive tech, and never as a second visual label beside the object.
 */
function Body({ state }: { state: ControlTileState }) {
  if (state.kind === "stop") {
    return (
      <>
        <StopSign />
        <span className="sr-only">Stop sign, stop</span>
      </>
    );
  }
  if (state.lamp === null) {
    return null;
  }
  return (
    <>
      <SignalHead lit={state.lamp} />
      <span className="sr-only">Traffic light, {LAMP_LABEL[state.lamp].toLowerCase()}</span>
    </>
  );
}

export function ControlTile({ state }: { state: ControlTileState | null }) {
  return (
    <AnimatePresence>
      {state !== null && (
        <motion.div
          key="control-tile"
          data-control-tile={state.kind}
          data-control-lamp={state.lamp ?? "none"}
          // Top-right, clear of the two things that already live there: the OSM
          // attribution (top-2, ~10px tall) on wide screens, and the utilities
          // row (top-4, full width) on a phone. 132px wide + right-2 stays
          // inside the narrowest supported viewport (390px) with room to spare.
          className="pointer-events-none absolute right-2 top-16 z-10 sm:top-8"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.26, ease: EASE }}
        >
          <div
            role="status"
            aria-label="Control ahead"
            className="surface flex w-[132px] flex-col items-center px-3.5 py-3.5"
          >
            <Body state={state} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
