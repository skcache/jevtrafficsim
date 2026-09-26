/**
 * The top-right control tile (Issue #46).
 *
 * The live view answers "what is the control ahead telling me?" in exactly two
 * places: the small roadside marker at the control itself, and ONE compact tile
 * in the top-right corner. Both must say the same thing, so both are derived
 * here and in `controlSpriteFor` — the tile never reads the signal state on its
 * own, and it never invents one:
 *
 *   marker sprite  = controlSpriteFor(control)        (render/control-layers)
 *   tile lamp      = lampForSprite(that same sprite)
 *
 * A tile exists only while a control is RELEVANT — the nearest control ahead on
 * the ego's remaining route. The moment the ego passes it, `upcomingControl`
 * stops returning it (it retires behind the car) and the tile is gone, which is
 * the "disappears cleanly after the control is passed" rule. A stop sign has no
 * live state to report, so its tile says Stop and carries no lamp.
 */
import { upcomingControl, type ContextualControl } from "./contextual-controls";
import { controlSpriteFor } from "./control-layers";
import type { ControlSpriteId } from "./control-sprites";

export type ControlTileKind = "signal" | "stop";
export type ControlTileLamp = "green" | "yellow" | "red";

export interface ControlTileState {
  readonly kind: ControlTileKind;
  /** The lamp the EGO's own movement sees; null for a stop sign. */
  readonly lamp: ControlTileLamp | null;
}

/**
 * Sprite -> lamp. `control-signal-neutral` (the quiet citywide marker) and the
 * stop sign carry no state, so they map to null rather than to a guessed colour.
 */
export function lampForSprite(sprite: ControlSpriteId): ControlTileLamp | null {
  switch (sprite) {
    case "control-signal-green":
      return "green";
    case "control-signal-yellow":
      return "yellow";
    case "control-signal-red":
      return "red";
    default:
      return null;
  }
}

/**
 * The tile for the control the ego is about to meet, or null when there is
 * nothing relevant — no upcoming control, or a signal whose authoritative state
 * is not in the frame (in which case nothing is shown, because a blank or
 * guessed head would be worse than no head).
 */
export function deriveControlTile(
  controls: readonly ContextualControl[],
): ControlTileState | null {
  const control = upcomingControl(controls);
  if (!control) {
    return null;
  }
  if (control.kind === "stop") {
    return { kind: "stop", lamp: null };
  }
  const lamp = lampForSprite(controlSpriteFor(control));
  return lamp === null ? null : { kind: "signal", lamp };
}

/** True when two tile states would render identically. */
export function sameControlTile(
  a: ControlTileState | null,
  b: ControlTileState | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.kind === b.kind && a.lamp === b.lamp;
}
