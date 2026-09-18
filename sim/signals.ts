/**
 * Legal signal mechanics (PRD §11.1) — mechanics only, never policy.
 *
 * ## Model
 *
 * Each signalized intersection splits its incoming directed roads into TWO
 * approach groups; the signal alternates:
 *
 *   GREEN(A) -> YELLOW(A) -> ALL-RED -> GREEN(B) -> YELLOW(B) -> ALL-RED -> ...
 *
 * Phase changes are always executed here, deterministically, and a stage can
 * only be left in this order — conflicting groups can never be green together
 * (only one group is ever green, and everything else is a clearance stage).
 *
 * ## Group derivation (irregular geometry, PRD §11.1)
 *
 * Each incoming road's travel bearing is reduced to its street axis
 * (bearing mod pi). The lowest axis becomes the reference; approaches within
 * 45 degrees of it form group 0, the rest form group 1. Opposite approaches of
 * one street share an axis, so they land in the same group and enjoy green
 * together; near-perpendicular streets split. Boundaries resolve to group 1
 * (strict <), keeping the rule fully deterministic. This is a deliberate
 * two-phase approximation for the aggregate model — protected turns,
 * per-lane movements and geometric turn-conflict matrices are out of scope.
 *
 * ## Timing semantics (all advanced by explicit dtMs — no hidden timers)
 *
 * - minGreenMs: a request to switch is ignored until green has run this long.
 * - maxGreenMs: green force-switches to yellow once reached — a movement can
 *   never own the intersection forever (PRD §11.1 hard rule).
 * - yellowMs / allRedMs: clearance stages are always entered and their exact
 *   configured durations are fully respected before the next green.
 * - Requests are per-call hints, never latched; transition targets always
 *   alternate (a clearance stage is never aborted).
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
 * controllers) may pass a requested phase and own the policy, while every
 * legality constraint above remains enforced here.
 */
import { DEFAULT_SIGNAL_TIMING, type SignalTiming } from "./config";
import type { City, IntersectionId, RoadId } from "./types";

export type SignalStage = "green" | "yellow" | "all-red";
export type ApproachGroupIndex = 0 | 1;

export interface SignalState {
  intersectionId: IntersectionId;
  /** Incoming directed roads split into two legal movement groups. */
  groups: [RoadId[], RoadId[]];
  /** The group currently green, or finishing its yellow/all-red clearance. */
  phaseIndex: ApproachGroupIndex;
  stage: SignalStage;
  stageElapsedMs: number;
  timing: SignalTiming;
}

/** Splits incoming directed roads of an intersection into two approach groups. */
export function deriveApproachGroups(
  city: City,
  intersectionId: IntersectionId,
): [RoadId[], RoadId[]] {
  const intersection = city.intersections[intersectionId];
  if (!intersection) {
    throw new RangeError(`unknown intersection id ${intersectionId}`);
  }
  const axes: Array<{ roadId: RoadId; axis: number }> = [];
  for (const roadId of intersection.incoming) {
    const road = city.roads[roadId];
    const from = city.intersections[road.from];
    const to = city.intersections[road.to];
    let bearing = Math.atan2(to.y - from.y, to.x - from.x);
    if (bearing < 0) {
      bearing += Math.PI * 2;
    }
    axes.push({ roadId, axis: bearing % Math.PI });
  }
  const groups: [RoadId[], RoadId[]] = [[], []];
  if (axes.length === 0) {
    return groups;
  }
  const reference = Math.min(...axes.map((entry) => entry.axis));
  for (const { roadId, axis } of axes) {
    let distance = Math.abs(axis - reference);
    if (distance > Math.PI / 2) {
      distance = Math.PI - distance; // circular distance on the axis half-circle
    }
    groups[distance < Math.PI / 4 ? 0 : 1].push(roadId);
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
  return {
    intersectionId,
    groups: deriveApproachGroups(city, intersectionId),
    phaseIndex: 0,
    stage: "green",
    stageElapsedMs: 0,
    timing: { ...timing },
  };
}

/**
 * Advances one signal by dtMs. `requestedPhase` (if given) asks for the other
 * group's green; the switch is deferred until minimum green has elapsed and
 * is ignored during clearance stages. Without a request, green still cannot
 * exceed maximum green.
 */
export function stepSignal(
  state: SignalState,
  dtMs: number,
  requestedPhase?: ApproachGroupIndex,
): void {
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    throw new RangeError(`dtMs must be a finite positive number, received ${dtMs}`);
  }
  state.stageElapsedMs += dtMs;
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
    state.phaseIndex = state.phaseIndex === 0 ? 1 : 0;
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
  return state.groups[state.phaseIndex].includes(incomingRoadId);
}

/** Approach roads currently allowed to enter (green stage only). */
export function permittedApproaches(state: SignalState): RoadId[] {
  return state.stage === "green" ? [...state.groups[state.phaseIndex]] : [];
}

/** Structural checks on a two-group plan; empty list means valid. */
export function validateSignalPlan(groups: [RoadId[], RoadId[]]): string[] {
  const problems: string[] = [];
  if (groups[0].length + groups[1].length === 0) {
    problems.push("plan has no approaches");
  }
  const seen = new Set<RoadId>();
  for (const group of groups) {
    for (const roadId of group) {
      if (seen.has(roadId)) {
        problems.push(`road ${roadId} appears in both groups`);
      }
      seen.add(roadId);
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
  if (state.phaseIndex !== 0 && state.phaseIndex !== 1) {
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
