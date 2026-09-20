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
    return "control-signal-red";
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
  const metres =
    control.kind === "signal" ? CONTROL_SCALE.signalHeightM : CONTROL_SCALE.stopHeightM;
  const scale =
    CONTROL_SCALE.previewSizeScale +
    (1 - CONTROL_SCALE.previewSizeScale) * control.emphasis;
  return metres * scale;
}

function iconLayer(
  id: string,
  controls: readonly ContextualControl[],
  projection: Projection,
  sprites: ControlSpriteSet,
  opacity: number,
  sizeMinPixels: number,
): Layer {
  return new IconLayer<ContextualControl>({
    id,
    data: controls as ContextualControl[],
    iconAtlas: sprites.atlas,
    iconMapping: sprites.mapping,
    getIcon: (control) => controlSpriteFor(control),
    getPosition: (control) => toLngLat(projection, control.x, control.y) as LngLat,
    getSize: (control) => sizeFor(control),
    sizeUnits: "meters",
    sizeMinPixels,
    sizeMaxPixels: CONTROL_SCALE.maxPixels,
    // Geographic anchor, screen-facing sign face. Map-space size still controls
    // zoom scaling; billboarding prevents pitch/tilt from crushing the lamps.
    billboard: true,
    opacity,
    pickable: false,
  });
}

/**
 * Build the contextual control layers. `sprites` missing means the atlas could
 * not be rasterised: draw nothing rather than a coloured dot fallback.
 */
export function buildControlLayers(
  projection: Projection,
  controls: readonly ContextualControl[],
  sprites: ControlSpriteSet | null,
): Layer[] {
  if (!sprites || controls.length === 0) {
    return [];
  }
  const primary = controls.filter((control) => control.prominence === "primary");
  const preview = controls.filter((control) => control.prominence === "preview");
  const layers: Layer[] = [];
  if (primary.length > 0) {
    layers.push(
      iconLayer("control-primary", primary, projection, sprites, 1, CONTROL_SCALE.minPixels),
    );
  }
  if (preview.length > 0) {
    layers.push(
      iconLayer(
        "control-preview",
        preview,
        projection,
        sprites,
        CONTROL_SCALE.previewOpacity,
        CONTROL_SCALE.previewMinPixels,
      ),
    );
  }
  return layers;
}

/** Pixel floor and cap applied to a layer, for tests and the debug contract. */
export function controlPixelBounds(): { minPixels: number; maxPixels: number } {
  return { minPixels: CONTROL_SCALE.minPixels, maxPixels: CONTROL_SCALE.maxPixels };
}
