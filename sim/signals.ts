/**
 * Legal signal mechanics (PRD §11.1) — mechanics only, never policy.
 *
 * ## Model
 *
 * Each signalized intersection splits its incoming directed roads into
 * ONE OR MORE approach groups — one group per compatible street axis. The
 * signal serves groups in a deterministic ring:
 *
 *   GREEN(i) -> YELLOW(i) -> ALL-RED -> GREEN((i + 1) % N) -> ...
 *
 * Phase changes are always executed here, deterministically, and a stage can
 * only be left in this order — clearance is never skipped or aborted, and
 * only one group is ever green, so conflicting groups can never be green
 * together.
 *
 * ## Group derivation (irregular geometry, PRD §11.1)
 *
 * Each incoming road's travel bearing is reduced to its street axis
 * (bearing mod pi). Approaches whose axes lie within SIGNAL_AXIS_TOLERANCE_RAD
 * (45 degrees) of EVERY current member cluster into one group; anything else
 * starts a new group. Opposite approaches of one street share an axis, so
 * they land in the same group and enjoy green together; genuinely distinct
 * axes (grid + diagonal corridors, multi-street junctions) each get their
 * own phase — two non-opposing axes are never merged just because both are
 * far from some reference. Clustering is a deterministic first-fit over
 * approaches sorted by (axis, roadId); groups come out ordered by their
 * lowest member axis, with road ids sorted ascending inside each group.
 * An intersection with no incoming roads throws on signal creation.
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
 * - minGreenMs: a request to switch is ignored until green has run this long.
 * - maxGreenMs: with two or more groups, green force-switches to yellow once
 *   reached — a movement can never own the intersection forever (PRD §11.1
 *   hard rule).
 * - yellowMs / allRedMs: clearance stages are always entered and their exact
 *   configured durations are fully respected before the next green.
 * - Single-group signals hold green indefinitely: there is no competing
 *   movement to serve, so max green does not force artificial clearance
 *   cycles.
 * - Requests are per-call hints, never latched; transition targets always
 *   advance one step around the ring (a clearance stage is never aborted,
 *   and no green group is ever skipped).
 *
 * ## Yellow policy (documented, PRD-safe)
 *
 * Yellow blocks NEW entries into the intersection; vehicles already beyond
 * the logical transfer point do not exist in this aggregate model, so no
 * clearance-vehicle special cases are needed.
 *
 * ## Policy boundary
 *
 * This module never decides WHICH phase traffic deserves — callers (Task 07
 * controllers) may request any valid group index and own the policy, while
 * every legality constraint above remains enforced here. Invalid group
 * indices are rejected.
 */
import { DEFAULT_SIGNAL_TIMING, type SignalTiming } from "./config";
import type { City, IntersectionId, RoadId } from "./types";

export type SignalStage = "green" | "yellow" | "all-red";

/**
 * Maximum circular distance (radians) between two street axes for approaches
 * to share one phase group. 45 degrees: perpendicular streets always split,
 * and strongly jittered opposing approaches still pair up.
 */
export const SIGNAL_AXIS_TOLERANCE_RAD = Math.PI / 4;

export interface SignalState {
  intersectionId: IntersectionId;
  /**
   * Incoming directed roads split into one or more non-empty phase groups,
   * one per compatible street axis; ordered by lowest member axis.
   */
  groups: RoadId[][];
  /** The group currently green, or finishing its yellow/all-red clearance. */
  phaseIndex: number;
  stage: SignalStage;
  stageElapsedMs: number;
  timing: SignalTiming;
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
 * Splits the incoming roads of an intersection into compatible-axis groups.
 * Deterministic: groups ordered by lowest member axis; road ids sorted
 * ascending inside each group. Never returns empty groups.
 */
export function deriveApproachGroups(
  city: City,
  intersectionId: IntersectionId,
): RoadId[][] {
  const intersection = city.intersections[intersectionId];
  if (!intersection) {
    throw new RangeError(`unknown intersection id ${intersectionId}`);
  }
  const entries = intersection.incoming
    .map((roadId) => ({ roadId, axis: roadAxis(city, roadId) }))
    .sort((a, b) => a.axis - b.axis || a.roadId - b.roadId);
  const clusters: Array<{ axes: number[]; roadIds: RoadId[] }> = [];
  for (const entry of entries) {
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
  return clusters.map((cluster) => [...cluster.roadIds].sort((a, b) => a - b));
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
 * Advances one signal by dtMs. `requestedPhase` (if given) asks to move off
 * the current group; the switch is deferred until minimum green has elapsed
 * and is ignored during clearance stages. The actual next green is always the
 * ring successor, (phaseIndex + 1) % groupCount. Without a request, a
 * multi-group signal still cannot exceed maximum green; a single-group signal
 * holds green forever.
 */
export function stepSignal(
  state: SignalState,
  dtMs: number,
  requestedPhase?: number,
): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    throw new RangeError(`dtMs must be a finite positive number, received ${dtMs}`);
  }
  if (
    requestedPhase !== undefined &&
    (!Number.isInteger(requestedPhase) ||
      requestedPhase < 0 ||
      requestedPhase >= state.groups.length)
  ) {
    throw new RangeError(
      `requestedPhase ${requestedPhase} is not a valid group index (0..${state.groups.length - 1})`,
    );
  }
  state.stageElapsedMs += dtMs;
  if (state.groups.length === 1) {
    return; // single-axis intersection: green holds, no clearance cycles
  }
  const { timing } = state;
  if (state.stage === "green") {
    const wantsSwitch =
      requestedPhase !== undefined && requestedPhase !== state.phaseIndex;
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
 * roads of the intersection, and every grouped pair of approaches must lie
 * on compatible street axes within SIGNAL_AXIS_TOLERANCE_RAD. Empty list
 * means valid.
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
    const axes: Array<{ roadId: RoadId; axis: number }> = [];
    for (const roadId of group) {
      if (!incoming.has(roadId)) {
        problems.push(`road ${roadId} is not an incoming road of intersection ${intersectionId}`);
        continue;
      }
      if (planned.has(roadId)) {
        continue; // duplication already reported by validateSignalPlan
      }
      planned.add(roadId);
      axes.push({ roadId, axis: roadAxis(city, roadId) });
    }
    for (let i = 0; i < axes.length; i += 1) {
      for (let j = i + 1; j < axes.length; j += 1) {
        if (circularAxisDistance(axes[i].axis, axes[j].axis) >= SIGNAL_AXIS_TOLERANCE_RAD) {
          problems.push(
            `group ${index} merges incompatible axes: roads ${axes[i].roadId} and ${axes[j].roadId}`,
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
