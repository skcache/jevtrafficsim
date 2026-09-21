/**
 * Jev controller (Issues #13, #14): a citywide policy controller behind the same
 * `TrafficController` contract as Fixed and Adaptive.
 *
 * ## Division of labour
 *
 * Jev's opinion arrives as a bounded policy and is translated DETERMINISTICALLY
 * into the only two things a controller may say: "hold" and "advance".
 * Everything legal stays local: min green, max green, yellow, all-red, ring
 * order and every safety constraint are enforced by sim/signals.ts whatever this
 * controller asks for, and Jev can never name a phase, a green time or a lamp
 * state.
 *
 * The starvation rule is Adaptive's own, evaluated FIRST, on UNWEIGHTED waits. A
 * policy — however hostile, however extreme — therefore cannot starve a
 * movement: corridor and region weights scale pressure, never service
 * guarantees.
 *
 * ## Lifecycle (Issue #14)
 *
 * Everything about when a policy is requested, accepted, held, superseded or
 * expired lives in `jev/runtime.ts`. This file is the thin seam between that
 * runtime and the engine: it feeds the runtime one observation per tick and, in
 * exchange, gets back either a policy in force or the instruction to run the
 * FALLBACK.
 *
 * The fallback is a real `createAdaptiveController()`, not a re-implementation
 * and not a "neutral policy": when Jev is unconfigured, timed out, unavailable,
 * malformed or expired, the city is driven by exactly the controller the
 * benchmark and the app already know. The runtime records how much simulated
 * time each source governed, so a result can never present fallback as live Jev.
 */
import { createAdaptiveController, phasePressure, starvedPhaseIndex } from "./adaptive";
import { ADAPTIVE_CONSTANTS } from "./adaptive";
import type { TrafficController, TrafficControllerContext } from "./contract";
import type { JevClient } from "@/jev/client";
import type { JevRequestOptions } from "@/jev/request";
import {
  createJevPolicyRuntime,
  JEV_RUNTIME_DEFAULTS,
  type JevEffectivePolicy,
  type JevRejection,
  type JevRuntime,
  type JevRuntimeStatus,
} from "@/jev/runtime";
import {
  JEV_HINT_MARGIN_SCALE,
  JEV_LIMITS,
  clampWeight,
  neutralJevPolicy,
  type JevPolicy,
} from "@/jev/schema";
import type { JevPolicySource, JevTrace, JevTraceEvent } from "@/jev/trace";
import type { IntersectionObservation, PhaseObservation } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import type { SignalDirective, SignalState } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId, RoadId } from "@/sim/types";

export const JEV_CONSTANTS = {
  /** Simulated ms between citywide policy requests. */
  REFRESH_MS: JEV_RUNTIME_DEFAULTS.REFRESH_MS,
  /** Pressure below this is "no meaningful demand" (shared with Adaptive). */
  DEMAND_EPSILON: ADAPTIVE_CONSTANTS.DEMAND_EPSILON,
  SWITCH_MARGIN: ADAPTIVE_CONSTANTS.SWITCH_MARGIN,
  AGE_MARGIN_DECAY: ADAPTIVE_CONSTANTS.AGE_MARGIN_DECAY,
  STARVATION_THRESHOLD_MS: ADAPTIVE_CONSTANTS.STARVATION_THRESHOLD_MS,
  STARVATION_MIN_SERVICE_MS: ADAPTIVE_CONSTANTS.STARVATION_MIN_SERVICE_MS,
} as const;

/** Weights resolved from one policy: O(1) lookups per phase, built once. */
export interface JevWeights {
  readonly pressureScale: number;
  readonly marginScale: number;
  readonly corridorWeight: ReadonlyMap<number, number>;
  readonly regionWeight: ReadonlyMap<number, number>;
}

export function resolveJevWeights(policy: JevPolicy): JevWeights {
  return {
    pressureScale: policy.pressureScale,
    marginScale: JEV_HINT_MARGIN_SCALE[policy.hint],
    corridorWeight: new Map(policy.corridorWeights.map((entry) => [entry.id, entry.weight])),
    regionWeight: new Map(policy.regionWeights.map((entry) => [entry.id, entry.weight])),
  };
}

const NEUTRAL_WEIGHTS = resolveJevWeights(neutralJevPolicy());

/**
 * Effective bounded weight for one phase: the global scale times the phase's
 * most important corridor times its signal's region weight, clamped to
 * JEV_LIMITS' combined bounds. Pure; exported for tests.
 */
export function jevPhaseWeight(
  phase: PhaseObservation,
  intersectionId: IntersectionId,
  partition: CityPartition,
  weights: JevWeights,
): number {
  let corridor = 1;
  for (const roadId of phase.roads) {
    for (const corridorId of partition.roadCorridors.get(roadId as RoadId) ?? []) {
      const weight = weights.corridorWeight.get(corridorId);
      if (weight !== undefined && weight > corridor) {
        corridor = weight;
      }
    }
  }
  const regionId = partition.intersectionRegion.get(intersectionId);
  const region = regionId === undefined ? 1 : weights.regionWeight.get(regionId) ?? 1;
  return clampWeight(
    weights.pressureScale * corridor * region,
    JEV_LIMITS.COMBINED_WEIGHT_MIN,
    JEV_LIMITS.COMBINED_WEIGHT_MAX,
  );
}

/**
 * Pure per-signal decision under a resolved policy. Structurally Adaptive's
 * decision — starvation first on unweighted waits, then a ring-successor
 * comparison with age-decayed hysteresis — with weighted pressures and a
 * policy-scaled margin.
 */
export function jevDirective(
  signal: SignalState,
  observation: IntersectionObservation,
  weightOf: (phaseIndex: number) => number,
  marginScale: number,
): SignalDirective | undefined {
  if (signal.groups.length < 2) {
    return undefined; // single-axis intersection: nothing to switch to
  }
  if (signal.stage !== "green") {
    return undefined; // clearance stages are mechanics-owned
  }
  const phases = observation.phases;
  // Service guarantee first, on UNWEIGHTED waits: no policy can touch it.
  const current = phases[signal.phaseIndex];
  if (
    current !== undefined &&
    current.maxWaitMs >= JEV_CONSTANTS.STARVATION_THRESHOLD_MS &&
    signal.stageElapsedMs < JEV_CONSTANTS.STARVATION_MIN_SERVICE_MS
  ) {
    return "hold";
  }
  const starved = starvedPhaseIndex(phases, signal.phaseIndex);
  if (starved !== null) {
    return signal.stageElapsedMs >= signal.timing.minGreenMs ? "advance" : undefined;
  }
  if (signal.stageElapsedMs < signal.timing.minGreenMs) {
    return undefined;
  }
  const weighted = (index: number): number => phasePressure(phases[index]) * weightOf(index);
  const currentPressure = weighted(signal.phaseIndex);
  const nextIndex = (signal.phaseIndex + 1) % phases.length;
  const nextPressure = weighted(nextIndex);
  if (currentPressure < JEV_CONSTANTS.DEMAND_EPSILON && nextPressure > JEV_CONSTANTS.DEMAND_EPSILON) {
    return "advance";
  }
  const ageFraction = Math.min(1, signal.stageElapsedMs / signal.timing.maxGreenMs);
  const margin =
    JEV_CONSTANTS.SWITCH_MARGIN * (1 - JEV_CONSTANTS.AGE_MARGIN_DECAY * ageFraction) * marginScale;
  return nextPressure > currentPressure + margin ? "advance" : "hold";
}

/** Result metadata: which source governed which part of the run. */
export interface JevControllerMeta {
  readonly kind: "jev";
  readonly mode: "live" | "replay";
  /** The source in force at the end of the run. */
  readonly source: JevPolicySource;
  readonly liveMs: number;
  readonly replayMs: number;
  readonly fallbackMs: number;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expiries: number;
  readonly traceEvents: number;
  readonly lastRejection: { readonly kind: string; readonly detail: string } | null;
}

export interface JevController extends TrafficController {
  /** Current policy in force, or null when the fallback is running. */
  policy(): JevPolicy | null;
  status(): JevRuntimeStatus;
  meta(): JevControllerMeta;
  /** Accepted policies in replay order — the input to an offline replay. */
  trace(): JevTrace;
  /** New scenario: discards the policy, in-flight answers and the trace. */
  reset(next: { scenarioFingerprint: string; trace?: JevTrace | null }): void;
}

export interface JevControllerOptions {
  /** null = unconfigured: the controller runs the Adaptive fallback forever. */
  readonly client: JevClient | null;
  /**
   * Identifies the scenario this controller serves; guards stale responses and
   * labels the trace. Required on purpose: a placeholder would let a policy
   * accepted for one scenario be applied to another.
   */
  readonly scenarioFingerprint: string;
  readonly refreshMs?: number;
  readonly ttlMs?: number;
  readonly minHoldMs?: number;
  readonly request?: JevRequestOptions;
  /** "replay" consumes `trace` offline and never touches a client. */
  readonly mode?: "live" | "replay";
  readonly trace?: JevTrace | null;
  readonly onAccepted?: (event: JevTraceEvent) => void;
  readonly onRejected?: (rejection: JevRejection) => void;
}

function countActiveVehicles(traffic: TrafficState): number {
  let active = 0;
  for (const vehicle of traffic.vehicles) {
    if (vehicle.state !== "arrived") {
      active += 1;
    }
  }
  return active;
}

export function createJevController(options: JevControllerOptions): JevController {
  const runtime: JevRuntime = createJevPolicyRuntime({
    client: options.mode === "replay" ? null : options.client,
    scenarioFingerprint: options.scenarioFingerprint,
    refreshMs: options.refreshMs,
    ttlMs: options.ttlMs,
    minHoldMs: options.minHoldMs,
    request: options.request,
    mode: options.mode,
    trace: options.trace,
    onAccepted: options.onAccepted,
    onRejected: options.onRejected,
  });
  // The fallback is the real Adaptive controller, reused rather than re-derived.
  const adaptive = createAdaptiveController();
  let effective: JevEffectivePolicy = {
    source: "fallback",
    policy: null,
    acceptedAtSimMs: null,
    expiresAtSimMs: null,
    generation: null,
  };

  return {
    id: "jev",
    policy: () => effective.policy,
    status: () => runtime.status(),
    trace: () => runtime.trace(),
    reset: (next) => runtime.reset(next),
    meta: () => {
      const status = runtime.status();
      return {
        kind: "jev",
        mode: status.mode,
        source: status.source,
        liveMs: status.liveMs,
        replayMs: status.replayMs,
        fallbackMs: status.fallbackMs,
        refreshes: status.refreshes,
        accepted: status.accepted,
        rejected: status.rejected,
        expiries: status.expiries,
        traceEvents: runtime.trace().events.length,
        lastRejection:
          status.lastRejection === null
            ? null
            : { kind: status.lastRejection.kind, detail: status.lastRejection.detail },
      };
    },
    directives(city: City, traffic: TrafficState, context?: TrafficControllerContext) {
      if (!context) {
        return new Map<IntersectionId, SignalDirective>(); // no observations: no opinion
      }
      const frame = context.observations;
      effective = runtime.observe({
        frame,
        partition: context.partition,
        intersections: city.intersections.length,
        activeVehicles: countActiveVehicles(traffic),
      });

      // No policy in force: the Adaptive controller decides, exactly as it would
      // if Jev had never been configured.
      if (effective.policy === null) {
        return adaptive.directives(city, traffic, context);
      }

      const weights = resolveJevWeights(effective.policy);
      const directives = new Map<IntersectionId, SignalDirective>();
      for (const [intersectionId, signal] of traffic.signals) {
        const observation = frame.intersections.get(intersectionId);
        if (!observation) {
          continue;
        }
        const directive = jevDirective(
          signal,
          observation,
          (phaseIndex) =>
            jevPhaseWeight(
              observation.phases[phaseIndex],
              intersectionId,
              context.partition,
              weights,
            ),
          weights.marginScale,
        );
        if (directive !== undefined) {
          directives.set(intersectionId, directive);
        }
      }
      return directives;
    },
  };
}

/** Exported for the runtime's tests and for callers that want the neutral base. */
export { NEUTRAL_WEIGHTS };
