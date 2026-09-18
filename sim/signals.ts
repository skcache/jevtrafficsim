/**
 * Legal signal mechanics (PRD §11.1) — mechanics only, never policy.
 *
 * ## Model
 *
 * Each signalized intersection splits its incoming directed roads into ONE OR
 * MORE approach groups — one group per compatible street axis. The signal
 * serves groups in a deterministic ring:
 *
 *   GREEN(i) -> YELLOW(i) -> ALL-RED -> GREEN((i + 1) % N) -> ...
 *
 * Phase changes are always executed here, deterministically, and a stage can
 * only be left in this order — clearance is never skipped or aborted, and
 * only one group is ever green, so conflicting approach groups can never be
 * green together.
 *
 * ## Structural axes for generated cities (logical topology, NOT geometry)
 *
 * Generated cities are row-major lattices (`id = row * gridWidth + col`) with
 * substantial coordinate jitter, so a road's visual bearing is NOT a reliable
 * proxy for its nominal street family: two halves of one horizontal street can
 * look angled apart, and a diagonal can look axis-aligned. Phase grouping for
 * lattice cities therefore derives each road's family from its endpoint-id
 * delta:
 *
 *   |delta| == 1                 -> "h"  (horizontal lattice axis)
 *   |delta| == gridWidth         -> "v"  (vertical lattice axis)
 *   |delta| == gridWidth + 1     -> "d+" (one diagonal family)
 *   |delta| == gridWidth - 1     -> "d-" (the other diagonal family)
 *
 * Bridges, arterials, highways and local roads are all lattice edges and keep
 * their horizontal/vertical family; diagonal corridors keep their diagonal
 * family. Opposing approaches of one family (both directions) share a group.
 * Two distinct families never share a group.
 *
 * ## Fallback for non-lattice cities
 *
 * Hand-authored fixtures (and any future externally constructed City) that do
 * not satisfy the lattice model `gridWidth >= 3 && gridHeight >= 2 &&
 * gridWidth * gridHeight === intersections.length` keep the conservative
 * geometric model: travel bearing reduced to a street axis (bearing mod pi),
 * approaches clustered pairwise within SIGNAL_AXIS_TOLERANCE_RAD (45 degrees,
 * circular), first-fit over (axis, roadId). Fallback groups never merge into
 * structural groups — mixed input stays separated.
 *
 * ## Group ordering (deterministic)
 *
 * Structural groups come first in fixed family order h, v, d-, d+; fallback
 * groups follow, ordered by lowest member axis. Road ids are sorted ascending
 * within every group; no empty groups are representable.
 *
 * ## V1 assumptions (explicit)
 *
 * - Opposing approaches on the same street axis are compatible and share a
 *   green phase.
 * - Different street axes are separate phases.
 * - Turn-level conflict geometry is abstracted away: protected turns,
 *   per-lane movements and pedestrian phases are out of scope for the
 *   aggregate model.
 *
 * ## Timing semantics (all advanced by explicit dtMs — no hidden timers)
 *
 * - minGreenMs: an "advance" directive is ignored until green has run this
 *   long.
 * - maxGreenMs: with two or more groups, green force-switches to yellow once
 *   reached — a movement can never own the intersection forever (PRD §11.1
 *   hard rule).
 * - yellowMs / allRedMs: clearance stages are always entered and their exact
 *   configured durations are fully respected before the next green.
 * - Single-group signals hold green indefinitely: there is no competing
 *   movement to serve, so max green does not force artificial clearance
 *   cycles, and directives are no-ops.
 *
 * ## Directives, not phase requests
 *
 * The mechanics input is `"hold" | "advance"` — never a target group index,
 * because the ring always serves groups in order: an "advance" directive asks
 * to leave the current phase as soon as legal (deferred by min green, ignored
 * during clearance), while "hold" asks to stay (max green still force-switches
 * when another group exists). This keeps the controller seam honest: Task 07
 * controllers decide WHEN to move on, never HOW to jump the queue of groups.
 *
 * ## Yellow policy (documented, PRD-safe)
 *
 * Yellow blocks NEW entries into the intersection; vehicles already beyond
 * the logical transfer point do not exist in this aggregate model, so no
 * clearance-vehicle special cases are needed.
 *
 * ## Policy boundary
 *
 * This module never decides WHICH phase traffic deserves — callers own that
 * policy, while every legality constraint above remains enforced here.
 * Invalid directives are rejected.
 */
import { DEFAULT_SIGNAL_TIMING, type SignalTiming } from "./config";
import type { City, IntersectionId, RoadId } from "./types";

export type SignalStage = "green" | "yellow" | "all-red";

/**
 * Mechanics input from callers: leave the current phase as soon as legal
 * ("advance") or deliberately stay ("hold"). Not a phase selector — the ring
 * always advances one group at a time.
 */
export type SignalDirective = "hold" | "advance";

/** Structural street-axis families of a generated lattice city. */
export type AxisFamily = "h" | "v" | "d-" | "d+";

/**
 * Phase-identity of an approach: an exact structural family for lattice
 * roads, or a normalized geometric axis for fallback cities.
 */
export type ApproachAxis =
  | { readonly kind: "family"; readonly family: AxisFamily }
  | { readonly kind: "geometric"; readonly axis: number };

/**
 * Maximum circular distance (radians) between two street axes for FALLBACK
 * approaches to share one phase group. 45 degrees: perpendicular streets
 * always split, and strongly jittered opposing approaches still pair up.
 * Lattice cities do not use this tolerance — they use exact structural
 * families.
 */
export const SIGNAL_AXIS_TOLERANCE_RAD = Math.PI / 4;

/** Deterministic family ordering for structural phase groups. */
const FAMILY_ORDER: readonly AxisFamily[] = ["h", "v", "d-", "d+"];

export interface SignalState {
  intersectionId: IntersectionId;
  /**
   * Incoming directed roads split into one or more non-empty phase groups,
   * one per compatible street axis; structural groups first (family order),
   * then geometric fallback groups by axis.
   */
  groups: RoadId[][];
  /** The group currently green, or finishing its yellow/all-red clearance. */
  phaseIndex: number;
  stage: SignalStage;
  stageElapsedMs: number;
  timing: SignalTiming;
}

/**
 * Whether the city follows the generated row-major lattice model. Requires a
 * non-degenerate lattice (gridWidth >= 3 keeps the |delta| families distinct:
 * 1, gridWidth, gridWidth - 1, gridWidth + 1) whose node count matches.
 */
export function isLatticeCity(city: City): boolean {
  return (
    city.gridWidth >= 3 &&
    city.gridHeight >= 2 &&
    city.gridWidth * city.gridHeight === city.intersections.length
  );
}

/** Travel bearing of a directed road, normalized to [0, 2pi). */
function roadBearing(city: City, roadId: RoadId): number {
  const road = city.roads[roadId];
  const from = city.intersections[road.from];
  const to = city.intersections[road.to];
  let bearing = Math.atan2(to.y - from.y, to.x - from.x);
  if (bearing < 0) {
    bearing += Math.PI * 2;
  }
  return bearing;
}

/** Street axis: a bearing reduced to [0, pi), so opposite directions match. */
function roadAxis(city: City, roadId: RoadId): number {
  return roadBearing(city, roadId) % Math.PI;
}

/** Circular distance between two street axes (the axis circle has length pi). */
function circularAxisDistance(a: number, b: number): number {
  const distance = Math.abs(a - b);
  return distance > Math.PI / 2 ? Math.PI - distance : distance;
}

/**
 * Structural family of a lattice road from its endpoint-id delta. Immune to
 * coordinate jitter. Returns null when the city is not a lattice city or the
 * road is not a lattice edge (fallback cases).
 */
function structuralFamily(city: City, roadId: RoadId): AxisFamily | null {
  if (!isLatticeCity(city)) {
    return null;
  }
  const road = city.roads[roadId];
  const delta = Math.abs(road.to - road.from);
  if (delta === 1) {
    return "h";
  }
  if (delta === city.gridWidth) {
    return "v";
  }
  if (delta === city.gridWidth + 1) {
    return "d+";
  }
  if (delta === city.gridWidth - 1) {
    return "d-";
  }
  return null;
}

/**
 * Phase-identity of an approach: the exact structural family for generated
 * lattice roads; a normalized geometric axis otherwise (conservative fallback
 * for hand-authored or externally constructed cities).
 */
export function approachAxisKey(city: City, roadId: RoadId): ApproachAxis {
  if (!city.roads[roadId]) {
    throw new RangeError(`unknown road id ${roadId}`);
  }
  const family = structuralFamily(city, roadId);
  if (family) {
    return { kind: "family", family };
  }
  return { kind: "geometric", axis: roadAxis(city, roadId) };
}

/**
 * Splits the incoming roads of an intersection into compatible-axis groups.
 * Deterministic: structural groups first in family order (h, v, d-, d+), then
 * geometric fallback clusters by ascending axis; road ids sorted ascending
 * inside each group. Never returns empty groups.
 */
export function deriveApproachGroups(
  city: City,
  intersectionId: IntersectionId,
): RoadId[][] {
  const intersection = city.intersections[intersectionId];
  if (!intersection) {
    throw new RangeError(`unknown intersection id ${intersectionId}`);
  }
  const byFamily = new Map<AxisFamily, RoadId[]>();
  const geometric: Array<{ roadId: RoadId; axis: number }> = [];
  for (const roadId of intersection.incoming) {
    const key = approachAxisKey(city, roadId);
    if (key.kind === "family") {
      const list = byFamily.get(key.family) ?? [];
      list.push(roadId);
      byFamily.set(key.family, list);
    } else {
      geometric.push({ roadId, axis: key.axis });
    }
  }
  const groups: RoadId[][] = [];
  for (const family of FAMILY_ORDER) {
    const members = byFamily.get(family);
    if (members && members.length > 0) {
      groups.push([...members].sort((a, b) => a - b));
    }
  }
  const clusters: Array<{ axes: number[]; roadIds: RoadId[] }> = [];
  for (const entry of geometric.sort((a, b) => a.axis - b.axis || a.roadId - b.roadId)) {
    let target: (typeof clusters)[number] | undefined;
    for (const cluster of clusters) {
      const compatible = cluster.axes.every(
        (axis) => circularAxisDistance(axis, entry.axis) < SIGNAL_AXIS_TOLERANCE_RAD,
      );
      if (compatible) {
        target = cluster;
        break;
      }
    }
    if (!target) {
      target = { axes: [], roadIds: [] };
      clusters.push(target);
    }
    target.axes.push(entry.axis);
    target.roadIds.push(entry.roadId);
  }
  for (const cluster of clusters) {
    groups.push([...cluster.roadIds].sort((a, b) => a - b));
  }
  return groups;
}

function validateSignalTiming(timing: SignalTiming): void {
  const values = [timing.minGreenMs, timing.maxGreenMs, timing.yellowMs, timing.allRedMs];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new RangeError("signal timings must be finite and positive");
  }
  if (timing.minGreenMs > timing.maxGreenMs) {
    throw new RangeError("signal minGreenMs must not exceed maxGreenMs");
  }
}

/** Creates the initial legal state: group 0 green, everything at zero elapsed. */
export function createSignalState(
  city: City,
  intersectionId: IntersectionId,
  timing: SignalTiming = DEFAULT_SIGNAL_TIMING,
): SignalState {
  validateSignalTiming(timing);
  const groups = deriveApproachGroups(city, intersectionId);
  if (groups.length === 0) {
    throw new RangeError(
      `intersection ${intersectionId} has no incoming approaches; cannot create a signal`,
    );
  }
  return {
    intersectionId,
    groups,
    phaseIndex: 0,
    stage: "green",
    stageElapsedMs: 0,
    timing: { ...timing },
  };
}

/**
 * Advances one signal by dtMs. An "advance" directive asks to leave the
 * current phase: the switch is deferred until minimum green has elapsed and
 * is ignored during clearance stages; with two or more groups, green also
 * force-switches at max green regardless of directives. The actual next green
 * is always the ring successor, (phaseIndex + 1) % groupCount. A single-group
 * signal holds green forever and directives are no-ops.
 */
export function stepSignal(
  state: SignalState,
  dtMs: number,
  directive?: SignalDirective,
): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    throw new RangeError(`dtMs must be a finite positive number, received ${dtMs}`);
  }
  if (directive !== undefined && directive !== "hold" && directive !== "advance") {
    throw new RangeError(
      `directive must be "hold" or "advance", received ${String(directive)}`,
    );
  }
  state.stageElapsedMs += dtMs;
  if (state.groups.length === 1) {
    return; // single-axis intersection: green holds, no clearance cycles
  }
  const { timing } = state;
  if (state.stage === "green") {
    const wantsSwitch = directive === "advance";
    const mustSwitch = state.stageElapsedMs >= timing.maxGreenMs;
    if (mustSwitch || (wantsSwitch && state.stageElapsedMs >= timing.minGreenMs)) {
      state.stage = "yellow";
      state.stageElapsedMs = 0;
    }
    return;
  }
  if (state.stage === "yellow") {
    if (state.stageElapsedMs >= timing.yellowMs) {
      state.stage = "all-red";
      state.stageElapsedMs = 0;
    }
    return;
  }
  if (state.stageElapsedMs >= timing.allRedMs) {
    state.stage = "green";
    state.phaseIndex = (state.phaseIndex + 1) % state.groups.length;
    state.stageElapsedMs = 0;
  }
}

/** Whether a vehicle on `incomingRoadId` may enter during the current stage. */
export function canApproachProceed(
  state: SignalState,
  incomingRoadId: RoadId,
): boolean {
  if (state.stage !== "green") {
    return false; // yellow and all-red block new entries (documented policy)
  }
  const group = state.groups[state.phaseIndex];
  return group !== undefined && group.includes(incomingRoadId);
}

/** Approach roads currently allowed to enter (green stage only). */
export function permittedApproaches(state: SignalState): RoadId[] {
  if (state.stage !== "green") {
    return [];
  }
  return [...(state.groups[state.phaseIndex] ?? [])];
}

/**
 * Structural checks on a phase plan; empty list means valid.
 * Requires at least one group, every group non-empty, and unique road ids.
 */
export function validateSignalPlan(groups: RoadId[][]): string[] {
  const problems: string[] = [];
  if (groups.length === 0) {
    problems.push("plan has no groups");
  }
  groups.forEach((group, index) => {
    if (group.length === 0) {
      problems.push(`group ${index} is empty`);
    }
  });
  const seen = new Set<RoadId>();
  for (const group of groups) {
    for (const roadId of group) {
      if (seen.has(roadId)) {
        problems.push(`road ${roadId} appears more than once`);
      }
      seen.add(roadId);
    }
  }
  return problems;
}

/**
 * City-aware plan validation: the plan must partition exactly the incoming
 * roads of the intersection. For lattice cities every grouped pair must share
 * ONE structural family (topology, not coordinates); for fallback cities
 * grouped pairs must lie on compatible geometric axes within
 * SIGNAL_AXIS_TOLERANCE_RAD. Mixing structural and fallback approaches in one
 * group is rejected. Empty list means valid.
 */
export function validateSignalPlanForCity(
  city: City,
  intersectionId: IntersectionId,
  groups: RoadId[][],
): string[] {
  const intersection = city.intersections[intersectionId];
  if (!intersection) {
    return [`unknown intersection id ${intersectionId}`];
  }
  const problems = validateSignalPlan(groups);
  const incoming = new Set(intersection.incoming);
  const planned = new Set<RoadId>();
  groups.forEach((group, index) => {
    const families = new Set<AxisFamily>();
    const geometricAxes: Array<{ roadId: RoadId; axis: number }> = [];
    for (const roadId of group) {
      if (!incoming.has(roadId)) {
        problems.push(`road ${roadId} is not an incoming road of intersection ${intersectionId}`);
        continue;
      }
      if (planned.has(roadId)) {
        continue; // duplication already reported by validateSignalPlan
      }
      planned.add(roadId);
      const key = approachAxisKey(city, roadId);
      if (key.kind === "family") {
        families.add(key.family);
      } else {
        geometricAxes.push({ roadId, axis: key.axis });
      }
    }
    if (families.size >= 2) {
      problems.push(`group ${index} mixes distinct structural families`);
    }
    if (families.size >= 1 && geometricAxes.length >= 1) {
      problems.push(`group ${index} mixes structural and geometric approaches`);
    }
    for (let i = 0; i < geometricAxes.length; i += 1) {
      for (let j = i + 1; j < geometricAxes.length; j += 1) {
        if (
          circularAxisDistance(geometricAxes[i].axis, geometricAxes[j].axis) >=
          SIGNAL_AXIS_TOLERANCE_RAD
        ) {
          problems.push(
            `group ${index} merges incompatible axes: roads ${geometricAxes[i].roadId} and ${geometricAxes[j].roadId}`,
          );
        }
      }
    }
  });
  for (const roadId of intersection.incoming) {
    if (!planned.has(roadId)) {
      problems.push(`incoming road ${roadId} is missing from the plan`);
    }
  }
  return problems;
}

/** Consistency checks on a live signal state; empty list means valid. */
export function validateSignalState(state: SignalState): string[] {
  const problems: string[] = [...validateSignalPlan(state.groups)];
  if (state.stage !== "green" && state.stage !== "yellow" && state.stage !== "all-red") {
    problems.push(`invalid stage ${state.stage as string}`);
  }
  if (
    !Number.isInteger(state.phaseIndex) ||
    state.phaseIndex < 0 ||
    state.phaseIndex >= state.groups.length
  ) {
    problems.push(`invalid phase index ${state.phaseIndex as number}`);
  }
  if (!Number.isFinite(state.stageElapsedMs) || state.stageElapsedMs < 0) {
    problems.push(`stageElapsedMs must be finite and >= 0`);
  }
  try {
    validateSignalTiming(state.timing);
  } catch (error) {
    problems.push((error as Error).message);
  }
  return problems;
}
