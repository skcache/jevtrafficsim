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
export type ControlLifecycle = "upcoming" | "retiring";

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
  /** Whether the control is ahead of the ego or smoothly returning to network scale. */
  readonly lifecycle: ControlLifecycle;
  /**
   * Continuous 0..1 approach emphasis. The renderer uses this to grow the
   * contextual control smoothly out of the tiny citywide signal system.
   */
  readonly emphasis: number;
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
  /** Shrink a cleared control back to network scale over this distance. */
  retireM: 55,
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
      lifecycle: "upcoming",
      emphasis: 0,
      signal,
    });
  }

  controls.sort((a, b) => a.distanceAheadM - b.distanceAheadM);
  // Two controlled intersections can sit unusually close together: the nearest
  // is primary, AT MOST one second stays quieter. Emphasis grows continuously
  // from the preview boundary to the primary band so the citywide micro-signal
  // feels like it enlarges as the ego approaches instead of popping in.
  const upcoming = controls.slice(0, CONTROL_REVEAL.maxVisible).map((control, index) => {
    const raw =
      control.distanceAheadM <= CONTROL_REVEAL.primaryM
        ? 1
        : Math.max(
            0,
            Math.min(
              1,
              (CONTROL_REVEAL.previewM - control.distanceAheadM) /
                (CONTROL_REVEAL.previewM - CONTROL_REVEAL.primaryM),
            ),
          );
    const eased = raw * raw * (3 - 2 * raw);
    return {
      ...control,
      prominence:
        index === 0 && control.distanceAheadM <= CONTROL_REVEAL.primaryM
          ? "primary" as const
          : "preview" as const,
      lifecycle: "upcoming" as const,
      emphasis: eased * (index === 0 ? 1 : 0.58),
    };
  });

  // After the ego crosses a controlled node, keep that control around just
  // long enough to shrink back to the quiet network size. Once emphasis reaches
  // zero the ordinary network marker takes over at the same size, so there is
  // no giant-head -> tiny-head pop.
  if (
    startIndex > 0 &&
    ego.roadId === trip.routeRoadIds[startIndex] &&
    ego.progress < CONTROL_REVEAL.retireM
  ) {
    const previousRoadId = trip.routeRoadIds[startIndex - 1];
    const previousRoad = city.roads[previousRoadId];
    const previousIntersection = previousRoad
      ? city.intersections[previousRoad.to]
      : undefined;
    const kind = previousIntersection?.control;
    if (previousRoad && previousIntersection && (kind === "signal" || kind === "stop")) {
      const placement = placementFor(
        model,
        indexes,
        previousRoadId,
        laneOffsets[previousRoadId] ?? 0,
      );
      if (placement) {
        const raw = Math.max(0, 1 - ego.progress / CONTROL_REVEAL.retireM);
        const eased = raw * raw * (3 - 2 * raw);
        upcoming.push({
          intersectionId: previousIntersection.id,
          kind,
          distanceAheadM: -ego.progress,
          x: placement.x,
          y: placement.y,
          bearing: placement.bearing,
          prominence: "preview",
          lifecycle: "retiring",
          emphasis: eased,
          // A passed signal no longer needs live route-local state. Neutral is
          // deliberate: it is becoming part of the background control network.
          signal: null,
        });
      }
    }
  }

  return upcoming;
}

/** The control the ego is about to meet, or null when the road ahead is clear. */
export function upcomingControl(
  controls: readonly ContextualControl[],
): ContextualControl | null {
  return controls.find((control) => control.lifecycle === "upcoming") ?? null;
}
