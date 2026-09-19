/**
 * Icon atlas types shared by the sprite modules.
 *
 * The Phase-2 mask builder that lived here (white silhouettes tinted by deck.gl,
 * with a ring layer re-drawing the same sprite for the wait-heat halo) is gone:
 * both atlases now bake their own colours. What remains is the shape deck.gl
 * needs for a sprite cell.
 */
import type { VehicleType } from "@/sim/types";

export interface VehicleIconDefinition {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly anchorX: number;
  readonly anchorY: number;
  readonly mask: boolean;
}

export interface VehicleIconSet {
  readonly atlas: string;
  readonly mapping: Record<VehicleType, VehicleIconDefinition>;
}
