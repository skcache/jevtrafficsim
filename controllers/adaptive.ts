/**
 * Adaptive controller (Task 09, PRD §12.2) — a deterministic, mechanics-bounded
 * heuristic that reacts to the traffic it actually sees, and a strong baseline
 * that later controllers (Jev) must genuinely beat rather than a straw man.
 *
 * ## Inputs (all deterministic, all engine-owned)
 *
 * Per phase (ring group) of every signalized intersection, from the
 * observation frame in the controller context:
 *
 *   1. queuedVehicles          — current queue depth;
 *   2. maxWaitMs               — CONTINUOUS queue wait at this road end
 *                                (Task 08 semantics; lifetime wait is never used);
 *   3. arrivalRatePerSecond    — rolling 5 s approach-arrival rate;
 *   4. downstreamOccupancyRatio — worst intended-downstream saturation;
 *   5. stageElapsedMs          — phase age (switching bias, not demand).
 *
 * ## Pressure
 *
 *   pressure(p) = QUEUE_WEIGHT  * queuedVehicles / QUEUE_SCALE_VEHICLES
 *               + WAIT_WEIGHT   * maxWaitMs / WAIT_SCALE_MS
 *               + ARRIVAL_WEIGHT* arrivalRatePerSecond / ARRIVAL_SCALE_PER_SECOND
 *               - DOWNSTREAM_PENALTY * clamp01(downstreamOccupancyRatio)
 *
 * clamped at 0 (a saturated exit can zero a phase's desire to be served, but
 * never makes it "negative demand"). Wait carries the heaviest weight: a long
 * continuous wait is the strongest evidence that a movement needs service.
 *
 * ## Decision (green stage, multi-group signals only)
 *
 * - non-green stages and single-group signals: no opinion (absence);
 * - before min green: no advance (absent directive);
 * - anti-starvation (hard rule, evaluated FIRST — see below);
 * - "no meaningful demand" rule: current pressure below DEMAND_EPSILON while
 *   the ring successor exceeds it -> advance;
 * - otherwise advance iff next pressure beats current BY a switch margin.
 *   The margin decays with phase age (AGE_MARGIN_DECAY): an old green becomes
 *   progressively easier to relinquish, which is switching bias only — age
 *   never enters the pressure terms as fake demand.
 *
 * The comparison is always against the RING SUCCESSOR: the mechanics only
 * ever advance one phase at a time, and this controller never asks for
 * anything else.
 *
 * ## Anti-starvation (hard policy rule)
 *
 * Any non-current phase whose CONTINUOUS wait reaches STARVATION_THRESHOLD_MS
 * must be served: the controller requests "advance" as soon as min green
 * permits, and keeps requesting it tick after tick so the ring walks through
 * intermediate phases (each after its own legal minimum) until the starved
 * phase is green. Ties resolve to the greatest wait, then the lowest phase
 * index (rings are road-id sorted, so that is also the lowest road id).
 *
 * Once the starved phase becomes current it receives at least
 * STARVATION_MIN_SERVICE_MS of green before normal policy may give it away —
 * a starved movement gets a meaningful serve, not a token one. Mechanics
 * still own everything else: ring order, min/max green, yellow, all-red and
 * single-group hold are enforced by sim/signals.ts regardless of directives.
 */
import type { TrafficController, TrafficControllerContext } from "./contract";
import type {
  IntersectionObservation,
  PhaseObservation,
} from "@/sim/observations";
import type { SignalDirective, SignalState } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId } from "@/sim/types";

/**
 * All weights / normalization constants of the Adaptive policy, centralized
 * (no magic numbers anywhere else). Tuned from general microcases only —
 * deliberately not fit to any single generated run.
 */
export const ADAPTIVE_CONSTANTS = {
  /** Vehicles at this queue depth count as one pressure unit. */
  QUEUE_SCALE_VEHICLES: 6,
  /** Continuous wait (ms) worth one pressure unit. */
  WAIT_SCALE_MS: 30_000,
  /** Arrivals per second worth one pressure unit. */
  ARRIVAL_SCALE_PER_SECOND: 0.5,
  QUEUE_WEIGHT: 1,
  /** Wait is the strongest service-need signal. */
  WAIT_WEIGHT: 1.5,
  ARRIVAL_WEIGHT: 1,
  /** How much worst-downstream saturation suppresses a phase's desire. */
  DOWNSTREAM_PENALTY: 0.8,
  /** Hysteresis: successor must beat current by this much to switch. */
  SWITCH_MARGIN: 0.6,
  /** At full phase age the switch margin decays to (1 - this) of base. */
  AGE_MARGIN_DECAY: 0.8,
  /** Pressure below this is "no meaningful demand". */
  DEMAND_EPSILON: 0.05,
  /** Continuous approach wait (ms) that triggers the hard starvation rule. */
  STARVATION_THRESHOLD_MS: 35_000,
  /** Guaranteed green for a starved phase once it finally becomes current. */
  STARVATION_MIN_SERVICE_MS: 8_000,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value >= 1 ? 1 : value;
}

/**
 * Pure pressure score of one phase. Exported for tests and diagnostics; the
 * controller itself calls exactly this function.
 */
export function phasePressure(phase: PhaseObservation): number {
  const C = ADAPTIVE_CONSTANTS;
  const queueUnits = Math.max(0, phase.queuedVehicles) / C.QUEUE_SCALE_VEHICLES;
  const waitUnits = Math.max(0, phase.maxWaitMs) / C.WAIT_SCALE_MS;
  const arrivalUnits = Math.max(0, phase.arrivalRatePerSecond) / C.ARRIVAL_SCALE_PER_SECOND;
  const downstream = clamp01(phase.downstreamOccupancyRatio);
  const pressure =
    C.QUEUE_WEIGHT * queueUnits +
    C.WAIT_WEIGHT * waitUnits +
    C.ARRIVAL_WEIGHT * arrivalUnits -
    C.DOWNSTREAM_PENALTY * downstream;
  return pressure > 0 ? pressure : 0;
}

/**
 * Starvation target for one signal: the non-current phase with the greatest
 * continuous wait at or above the threshold; ties resolve to the lowest phase
 * index. Returns null when nothing is starved. Deterministic by construction.
 */
export function starvedPhaseIndex(
  phases: readonly PhaseObservation[],
  currentIndex: number,
): number | null {
  let target: PhaseObservation | null = null;
  for (const phase of phases) {
    if (phase.phaseIndex === currentIndex) {
      continue;
    }
    if (phase.maxWaitMs < ADAPTIVE_CONSTANTS.STARVATION_THRESHOLD_MS) {
      continue;
    }
    if (target === null || phase.maxWaitMs > target.maxWaitMs) {
      target = phase;
    }
  }
  return target === null ? null : target.phaseIndex;
}

/**
 * Normal (non-starvation) policy for a green signal: compare current against
 * the ring successor with age-decayed hysteresis. Caller guarantees a
 * multi-group signal in green.
 */
function normalDirective(
  signal: SignalState,
  phases: readonly PhaseObservation[],
): SignalDirective | undefined {
  if (signal.stageElapsedMs < signal.timing.minGreenMs) {
    return undefined; // no advance before the legal minimum green
  }
  const C = ADAPTIVE_CONSTANTS;
  const current = phasePressure(phases[signal.phaseIndex]);
  const nextIndex = (signal.phaseIndex + 1) % phases.length;
  const next = phasePressure(phases[nextIndex]);
  if (current < C.DEMAND_EPSILON && next > C.DEMAND_EPSILON) {
    return "advance"; // nothing meaningful being served; successor has demand
  }
  const ageFraction = Math.min(1, signal.stageElapsedMs / signal.timing.maxGreenMs);
  const margin = C.SWITCH_MARGIN * (1 - C.AGE_MARGIN_DECAY * ageFraction);
  return next > current + margin ? "advance" : "hold";
}

/**
 * Pure per-signal decision. Exported so policy tests can drive it directly
 * with hand-authored observations — no engine required.
 */
export function adaptiveDirective(
  signal: SignalState,
  observation: IntersectionObservation,
): SignalDirective | undefined {
  if (signal.groups.length < 2) {
    return undefined; // single-axis intersection: nothing to switch to
  }
  if (signal.stage !== "green") {
    return undefined; // clearance stages are mechanics-owned
  }
  const phases = observation.phases;
  // Service guarantee first (state-free): the CURRENT phase still carries a
  // starved queue — it earned this green while starved and has not drained —
  // so it gets a meaningful serve before any other consideration.
  const current = phases[signal.phaseIndex];
  if (
    current !== undefined &&
    current.maxWaitMs >= ADAPTIVE_CONSTANTS.STARVATION_THRESHOLD_MS &&
    signal.stageElapsedMs < ADAPTIVE_CONSTANTS.STARVATION_MIN_SERVICE_MS
  ) {
    return "hold";
  }
  const starved = starvedPhaseIndex(phases, signal.phaseIndex);
  if (starved !== null) {
    // Walk the ring toward the starved phase as soon as legally possible;
    // re-evaluated every tick so intermediate phases each clear properly.
    return signal.stageElapsedMs >= signal.timing.minGreenMs ? "advance" : undefined;
  }
  return normalDirective(signal, phases);
}

export function createAdaptiveController(): TrafficController {
  return {
    id: "adaptive",
    directives(
      city: City,
      traffic: TrafficState,
      context?: TrafficControllerContext,
    ): ReadonlyMap<IntersectionId, SignalDirective> {
      const directives = new Map<IntersectionId, SignalDirective>();
      if (!context) {
        return directives; // no observations: no opinion (defensive)
      }
      for (const [intersectionId, signal] of traffic.signals) {
        const observation = context.observations.intersections.get(intersectionId);
        if (!observation) {
          continue;
        }
        const directive = adaptiveDirective(signal, observation);
        if (directive !== undefined) {
          directives.set(intersectionId, directive);
        }
      }
      return directives;
    },
  };
}
