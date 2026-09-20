/**
 * Contextual control layers (Issue #26).
 *
 * At most a couple of icons, drawn from `deriveContextualControls`: the traffic
 * light answers "can MY car go?" (the lamp shown is the ego approach's
 * permission, not the signal's generic stage), the stop sign is static graph
 * semantics. Both are map-anchored world objects sized in metres with a pixel
 * floor and cap; the nearest control is primary, anything else preview.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer } from "@deck.gl/layers";
import type { Projection } from "@/cities/map-model";
import type { ContextualControl } from "./contextual-controls";
import { CONTROL_SCALE } from "./scale";
import { toLngLat, type LngLat } from "./deck-layers";
import type { ControlSpriteId, ControlSpriteSet } from "./control-sprites";

/**
 * Which sprite answers the ego's question.
 *
 * green stage + ego's own phase group active -> green
 * green stage + a DIFFERENT group active    -> red  (the ego must stop)
 * yellow                                    -> yellow
 * all-red                                   -> red
 */
export function controlSpriteFor(control: ContextualControl): ControlSpriteId {
  if (control.kind === "stop") {
    return "control-stop";
  }
  const signal = control.signal;
  if (!signal) {
    return "control-signal-neutral";
  }
  if (signal.stage === "yellow") {
    return "control-signal-yellow";
  }
  if (signal.stage === "green" && signal.egoApproachPermitted) {
    return "control-signal-green";
  }
  return "control-signal-red";
}

function sizeFor(control: ContextualControl): number {
  const base =
    control.kind === "signal"
      ? CONTROL_SCALE.signalBaseHeightM
      : CONTROL_SCALE.stopBaseHeightM;
  const full =
    control.kind === "signal"
      ? CONTROL_SCALE.signalHeightM
      : CONTROL_SCALE.stopHeightM;
  return base + (full - base) * control.emphasis;
}

function opacityFor(control: ContextualControl): number {
  return CONTROL_SCALE.opacityFloor + (1 - CONTROL_SCALE.opacityFloor) * control.emphasis;
}

/**
 * One contextual layer. The icon takes over from the quiet network marker at
 * nearly the same size, then grows continuously as route-distance emphasis
 * approaches 1. The "primary" flag remains useful for debug/semantics, but no
 * layer switch creates a visible pop at the primary threshold.
 */
export function buildControlLayers(
  projection: Projection,
  controls: readonly ContextualControl[],
  sprites: ControlSpriteSet | null,
): Layer[] {
  if (!sprites || controls.length === 0) {
    return [];
  }
  return [
    new IconLayer<ContextualControl>({
      id: "control-contextual",
      data: controls as ContextualControl[],
      iconAtlas: sprites.atlas,
      iconMapping: sprites.mapping,
      getIcon: (control) => controlSpriteFor(control),
      getPosition: (control) => toLngLat(projection, control.x, control.y) as LngLat,
      getSize: (control) => sizeFor(control),
      getColor: (control) => [255, 255, 255, Math.round(opacityFor(control) * 255)],
      sizeUnits: "meters",
      sizeMinPixels: CONTROL_SCALE.minPixels,
      sizeMaxPixels: CONTROL_SCALE.maxPixels,
      billboard: true,
      opacity: 1,
      pickable: false,
    }),
  ];
}

/** Pixel floor and cap applied to a layer, for tests and the debug contract. */
export function controlPixelBounds(): { minPixels: number; maxPixels: number } {
  return { minPixels: CONTROL_SCALE.minPixels, maxPixels: CONTROL_SCALE.maxPixels };
}
