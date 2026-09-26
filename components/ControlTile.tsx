"use client";

/**
 * ControlTile (Issue #46): the ONE compact tile in the top-right corner while a
 * control ahead is relevant.
 *
 * It renders the state the map marker is showing, from the same derivation
 * (`deriveControlTile`, built on the marker's own sprite decision), so the two
 * can never disagree. A signal shows its authoritative lamp for the ego's
 * movement; a stop sign shows Stop. No countdown, no guessed colour, no second
 * card: one tile, one question — "what does the control ahead say?".
 *
 * It is the only control chrome; the map itself carries the roadside marker.
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

/** The lit lamp the map marker shows, in the marker's own colour. */
function Lamp({ lamp }: { lamp: ControlTileLamp }) {
  const colour = CONTROL_MARKER_COLORS[lamp];
  return (
    <span
      aria-hidden="true"
      className="h-2.5 w-2.5 rounded-full"
      style={{ background: colour, boxShadow: `0 0 0 2px ${colour}33` }}
    />
  );
}

/** The stop sign's own octagon, in the marker's own red. */
function StopGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
      <polygon
        points="4,0.5 8,0.5 11.5,4 11.5,8 8,11.5 4,11.5 0.5,8 0.5,4"
        fill={CONTROL_MARKER_COLORS.stop}
      />
    </svg>
  );
}

function Body({ state }: { state: ControlTileState }) {
  if (state.kind === "stop") {
    return (
      <>
        <span className="label-micro">Stop sign</span>
        <span className="flex items-center gap-1.5">
          <StopGlyph />
          <span className="text-meta font-medium leading-none text-ink">Stop</span>
        </span>
      </>
    );
  }
  if (state.lamp === null) {
    return null;
  }
  return (
    <>
      <span className="label-micro">Traffic light</span>
      <span className="flex items-center gap-1.5">
        <Lamp lamp={state.lamp} />
        <span className="text-meta font-medium leading-none text-ink">
          {LAMP_LABEL[state.lamp]}
        </span>
      </span>
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
          // Top-right, clear of the two things that already live there: the OSM
          // attribution (top-2, ~10px tall) on wide screens, and the utilities
          // row (top-4, full width) on a phone.
          className="pointer-events-none absolute right-2 top-16 z-10 sm:top-8"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -4 }}
          transition={{ duration: 0.26, ease: EASE }}
        >
          <div
            role="status"
            aria-label="Control ahead"
            className="surface flex w-fit flex-col gap-1 px-2.5 py-2"
          >
            <Body state={state} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
