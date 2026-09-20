/**
 * Contextual road controls (Issue #26).
 *
 * Only the controls the ego car is about to meet deserve pixels. This module is
 * the ONE authoritative derivation path: it walks the ego's CURRENT remaining
 * route, measures distance AHEAD ALONG THE ROUTE (never straight-line radius,
 * which would surface intersections on parallel streets), and returns at most a
 * couple of controls with everything the renderer needs.
 *
 * Signal permission is not invented here. It is the engine's own rule, applied
 * to the engine's own state:
 *
 *   canApproachProceed(state, incomingRoad) =
 *     state.stage === "green" && state.groups[state.phaseIndex].includes(incomingRoad)
 *
 * with the groups from `deriveApproachGroups` (sim/signals.ts). A green stage
 * for a DIFFERENT phase group means red for the ego — the presentation must
 * answer "can my car go?", not "what stage is the signal in?".
 *
 * Stop signs are static graph semantics (`intersection.control === "stop"`);
 * the simulation has no yield control, so neither does this.
 */
import type { MapModel } from "@/cities/map-model";
import type { DirectedPathIndexes } from "@/render/map-geometry";
import { applyLaneOffset } from "@/render/map-geometry";
import {
  directionalLanes,
  LANE_WIDTH_M,
  stopLineSetbackMetres,
} from "@/render/road-presentation";
import { samplePathIndex } from "@/cities/paths";
import { canApproachProceedForPhase, deriveApproachGroups, type SignalStage } from "@/sim/signals";
import type { IntersectionId, RoadId } from "@/sim/types";
import type {
  PresentationSignal,
  PresentationTripProgress,
} from "@/worker/presentation-snapshot";

export type ControlKind = "signal" | "stop";
export type ControlProminence = "primary" | "preview";

export interface ContextualControl {
  readonly intersectionId: IntersectionId;
  readonly kind: ControlKind;
  /** Metres ahead along the ego's route to the physical stop line. */
  readonly distanceAheadM: number;
  /** Local map metres of the control glyph (kerbside, before the stop line). */
  readonly x: number;
  readonly y: number;
  /** Travel bearing of the ego's incoming approach, radians. */
  readonly bearing: number;
  /** Nearest control is primary inside the primary band; others stay quieter. */
  readonly prominence: ControlProminence;
  /** Signal state for the ego's own approach, or null for a stop sign. */
  readonly signal: ContextualSignalState | null;
}

export interface ContextualSignalState {
  readonly stage: SignalStage;
  readonly phaseIndex: number;
  /** True only when the ego's own approach group is green. */
  readonly egoApproachPermitted: boolean;
}

/**
 * Reveal policy, in metres ahead along the route. Deterministic constants, one
 * place: outside preview nothing exists; preview is lower prominence; primary
 * is full prominence. A control retires the moment the ego is on the next road,
 * because the walk starts at the current road's END.
 */
export const CONTROL_REVEAL = {
  previewM: 160,
  primaryM: 90,
  /** Never more than the nearest plus one quieter control on screen. */
  maxVisible: 2,
  /** Gap between the lane-group edge and the control glyph, in metres. */
  kerbGapM: 2.1,
} as const;

export interface ContextualControlInput {
  readonly model: MapModel;
  readonly indexes: DirectedPathIndexes;
  /** Per-road lane-centre offsets, built once per model. */
  readonly laneOffsets: readonly number[];
  readonly trip: PresentationTripProgress | null;
  readonly ego: { readonly roadId: RoadId | null; readonly progress: number } | null;
  /** Route-local signal state from the frame (issue #24 payload). */
  readonly routeControls: readonly PresentationSignal[];
}

/**
 * Where the control sits for the ego's incoming road: just past the physical
 * stop line, off the ego's carriageway, so it never covers the car, the route
 * core or the intersection centre. Curved and diagonal roads work because the
 * placement follows the incoming road's own path sample and heading.
 */
function placementFor(
  model: MapModel,
  indexes: DirectedPathIndexes,
  roadId: RoadId,
  laneOffsetM: number,
): { x: number; y: number; bearing: number } | null {
  const index = indexes[roadId];
  if (!index || index.total < 1) {
    return null;
  }
  const lanes = directionalLanes(model, roadId);
  const setback = stopLineSetbackMetres(lanes);
  const halfWidthM = (Math.max(1, lanes) * LANE_WIDTH_M) / 2;
  const sample = samplePathIndex(index, Math.max(0, index.total - setback));
  const kerbside = applyLaneOffset(sample, laneOffsetM + halfWidthM + CONTROL_REVEAL.kerbGapM);
  return { x: kerbside.x, y: kerbside.y, bearing: sample.heading };
}

export function deriveContextualControls(input: ContextualControlInput): ContextualControl[] {
  const { model, indexes, laneOffsets, trip, ego, routeControls } = input;
  if (!trip || !ego) {
    return [];
  }
  // Arrival: the trip is over. The vehicle rests on its last road, so a walk
  // would still find that road's endpoint — there is nothing ahead to meet.
  if (trip.completed) {
    return [];
  }
  const city = model.city;
  const signals = new Map<IntersectionId, PresentationSignal>();
  for (const signal of routeControls) {
    signals.set(signal.intersectionId, signal);
  }

  const controls: ContextualControl[] = [];
  const startIndex = Math.max(0, Math.min(trip.routeIndex, trip.routeRoadIds.length));
  let aheadM = 0;
  for (let index = startIndex; index < trip.routeRoadIds.length; index += 1) {
    const roadId = trip.routeRoadIds[index];
    const road = city.roads[roadId];
    if (!road) {
      continue;
    }
    const remainingM =
      index === startIndex
        ? Math.max(0, road.length - (ego.roadId === roadId ? ego.progress : 0))
        : road.length;
    aheadM += remainingM;
    const stopSetbackM = stopLineSetbackMetres(directionalLanes(model, roadId));
    // Reveal distance is to the PHYSICAL stop line, not the graph node. Once a
    // car has crossed that line but has not changed roads yet, keep the control
    // at 0 m until the route index advances and retires it.
    const controlDistanceM = Math.max(0, aheadM - stopSetbackM);
    if (controlDistanceM > CONTROL_REVEAL.previewM) {
      break;
    }
    const intersection = city.intersections[road.to];
    if (!intersection) {
      continue;
    }
    const kind = intersection.control;
    if (kind !== "signal" && kind !== "stop") {
      continue;
    }
    const placement = placementFor(model, indexes, roadId, laneOffsets[roadId] ?? 0);
    if (!placement) {
      continue;
    }

    let signal: ContextualSignalState | null = null;
    if (kind === "signal") {
      const state = signals.get(intersection.id);
      if (!state) {
        // No authoritative state for this approach: draw nothing rather than
        // inventing a stage.
        continue;
      }
      signal = {
        stage: state.stage,
        phaseIndex: state.phaseIndex,
        egoApproachPermitted: canApproachProceedForPhase(
          deriveApproachGroups(city, intersection.id),
          state.stage,
          state.phaseIndex,
          roadId,
        ),
      };
    }
    controls.push({
      intersectionId: intersection.id,
      kind,
      distanceAheadM: controlDistanceM,
      x: placement.x,
      y: placement.y,
      bearing: placement.bearing,
      prominence: "preview",
      signal,
    });
  }

  controls.sort((a, b) => a.distanceAheadM - b.distanceAheadM);
  // Two controlled intersections can sit unusually close together: the nearest
  // is primary, AT MOST one second stays quieter. More than that would be a
  // corridor covered in heads, which is exactly what this issue forbids.
  return controls.slice(0, CONTROL_REVEAL.maxVisible).map((control, index) => ({
    ...control,
    prominence:
      index === 0 && control.distanceAheadM <= CONTROL_REVEAL.primaryM ? "primary" : "preview",
  }));
}

/** The control the ego is about to meet, or null when the road ahead is clear. */
export function upcomingControl(
  controls: readonly ContextualControl[],
): ContextualControl | null {
  return controls.length > 0 ? controls[0] : null;
}
