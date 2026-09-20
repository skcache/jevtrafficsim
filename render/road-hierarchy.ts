/**
 * Presentation hierarchy for the street network.
 *
 * Simulation topology is untouched: every road still exists, still routes, still
 * carries traffic. This module only decides how the STATIC map shows a physical
 * street piece, so the map can be calm without the network becoming a lie.
 *
 * The audit that shaped these rules (medium scale, 1430 pieces):
 *
 *   - only ONE piece was genuinely junk (a 13 m unnamed stub). The "fake ramps"
 *     in the screenshots are not junk data.
 *   - the real cause was the bridge material: all 230 bridge-tagged pieces drew
 *     as thick white bands at every zoom, so short viaduct and overpass pieces
 *     read as disconnected mini-roads floating beside thin streets. Bridge
 *     material now belongs to pieces that actually cross water.
 *   - the second cause was ordinary short pieces: 130 unnamed pieces under 60 m
 *     (mostly tertiary/residential stubs between close intersections) drawn at
 *     mid zoom with a legibility floor, which fattens a stub into a ramp.
 *   - OSM "*_link" does NOT mean "freeway ramp". Chicago contains short
 *     secondary_link turn channels on ordinary downtown streets. Promoting every
 *     link class to the highway material produced the tan mini-ramps visible on
 *     Washington/Madison in the showcase screenshots.
 */
import type { Point } from "@/cities/paths";

export type RoadPresentationClass = "primary" | "secondary" | "hidden";

export interface RoadPresentationInput {
  readonly osmClass: string;
  readonly name?: string;
  readonly length: number;
  readonly bridgeStructure?: boolean;
  readonly tunnel?: boolean;
  readonly layer?: number;
}

/** Pieces shorter than this with no name are map texture, not streets. */
export const DETAIL_MAX_LENGTH_M = 30;

/**
 * PRIMARY   the network's structure: expressways, ramps, and Chicago's grid
 *           streets (secondary carries most of the Loop's named avenues).
 * SECONDARY ordinary local streets: tertiary, residential, unclassified.
 * HIDDEN    surface-street link channels and tiny unnamed connector pieces.
 *           They remain simulation topology but do not become standalone map
 *           objects. At this product's scale they read as a vehicle completing
 *           a turn/transition, which is more useful than drawing fake ramps.
 */
export function roadPresentationClass(piece: RoadPresentationInput): RoadPresentationClass {
  const osmClass = piece.osmClass;

  // Never hide physical structure. A short bridge/tunnel/stack segment may be
  // visually small, but if traffic can occupy it the map must provide a road
  // underneath that traffic. This is the invariant that prevents "truck in the
  // river" frames when a short grade-separated OSM piece is traversed.
  const structural = piece.bridgeStructure || piece.tunnel || (piece.layer ?? 0) !== 0;

  // Only links attached to the expressway hierarchy are visually ramps.
  // Surface-street link classes are turn/slip channels; they stay routable but
  // never become standalone cartographic roads. A vehicle traversing one reads
  // as making a turn through the intersection, which is the useful abstraction.
  if (
    osmClass === "motorway" ||
    osmClass === "trunk" ||
    osmClass === "motorway_link" ||
    osmClass === "trunk_link" ||
    osmClass === "primary" ||
    osmClass === "secondary"
  ) {
    return "primary";
  }
  if (structural) {
    return "secondary";
  }
  if (osmClass.endsWith("_link")) {
    // Surface *_link geometry is usually OSM turn/slip plumbing, not a street
    // a human would identify as a separate road. The old 45 m threshold leaked
    // block-length pseudo-ramps back into the Loop. Keep only long, NAMED links
    // as standalone streets; structural links were already preserved above.
    return piece.name && piece.length > 120 ? "secondary" : "hidden";
  }
  if (piece.length < DETAIL_MAX_LENGTH_M && !piece.name) {
    return "hidden";
  }
  return "secondary";
}

/** True only for the OSM classes that should read as an expressway/ramp. */
export function isExpresswayClass(osmClass: string): boolean {
  return (
    osmClass === "motorway" ||
    osmClass === "trunk" ||
    osmClass === "motorway_link" ||
    osmClass === "trunk_link"
  );
}

/** Ray-cast point-in-ring; the rings are metric, like the points. */
function pointInRing(point: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export interface WaterPolygon {
  readonly rings: readonly (readonly Point[])[];
}

/**
 * True when a street piece's middle actually crosses water — the one condition
 * that earns bridge material. Tests the sampled middle of the path rather than
 * its endpoints: a piece can start and end on land while crossing the river.
 */
export function pieceCrossesWater(
  points: readonly Point[],
  water: readonly WaterPolygon[],
): boolean {
  if (points.length < 2 || water.length === 0) {
    return false;
  }
  const samples: Point[] = [];
  const middle = points[Math.floor(points.length / 2)];
  samples.push(middle);
  // Long pieces get two extra samples so a diagonal crossing is not missed.
  if (points.length > 2) {
    samples.push(points[Math.floor(points.length / 3)]);
    samples.push(points[Math.floor((points.length * 2) / 3)]);
  }
  return samples.some((sample) =>
    water.some((polygon) => {
      const outer = polygon.rings[0];
      if (!outer || !pointInRing(sample, outer)) {
        return false;
      }
      // Holes are land: a piece over an island is not over water.
      for (let index = 1; index < polygon.rings.length; index += 1) {
        if (pointInRing(sample, polygon.rings[index])) {
          return false;
        }
      }
      return true;
    }),
  );
}
