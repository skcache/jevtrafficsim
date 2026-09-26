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
 * and not a "neutral policy": when Jev is unconfigured, has no answer yet, or
 * has outlived even the maximum hold of its last policy, the city is driven by
 * exactly the controller the benchmark and the app already know. In between —
 * while the model's last opinion is still the freshest one that exists — the
 * city keeps being driven by THAT policy, bounded and clamped like any other,
 * and the run reports it as held (`heldMs`) rather than as fresh or as fallback.
 * The runtime records how much simulated time each source governed, so a result
 * can never present fallback as live Jev, or a held opinion as a fresh one.
 */
import { createAdaptiveController, phasePressure, starvedPhaseIndex } from "./adaptive";
import { ADAPTIVE_CONSTANTS } from "./adaptive";
import type { TrafficController, TrafficControllerContext } from "./contract";
import type { JevClient } from "@/jev/client";
import type { JevRequestOptions } from "@/jev/request";
import {
  createJevPolicyRuntime,
  JEV_RUNTIME_DEFAULTS,
  type JevCause,
  type JevCauseCounts,
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
  type JevIntentEntry,
  type JevPolicy,
} from "@/jev/schema";
import { adapterFromId, type JevAdapter, type JevPolicySource, type JevTrace, type JevTraceEvent, type JevTraceRecordedRun } from "@/jev/trace";
import type { JevRefreshTelemetry } from "@/jev/telemetry";
import type { IntersectionObservation, PhaseObservation } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import type { SignalDirective, SignalState } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId, RoadId } from "@/sim/types";
import { activeVehicleCount } from "@/sim/traffic";

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
  /** Coordinated zone intents: id -> {intent, strength}, already bounded. */
  readonly corridorIntent: ReadonlyMap<number, JevIntentEntry>;
  readonly regionIntent: ReadonlyMap<number, JevIntentEntry>;
}

export function resolveJevWeights(policy: JevPolicy): JevWeights {
  return {
    pressureScale: policy.pressureScale,
    marginScale: JEV_HINT_MARGIN_SCALE[policy.hint],
    corridorWeight: new Map(policy.corridorWeights.map((entry) => [entry.id, entry.weight])),
    regionWeight: new Map(policy.regionWeights.map((entry) => [entry.id, entry.weight])),
    corridorIntent: new Map(policy.corridorIntents.map((entry) => [entry.id, entry])),
    regionIntent: new Map(policy.regionIntents.map((entry) => [entry.id, entry])),
  };
}

/**
 * The switch-margin multiplier a COORDINATED zone intent applies at one signal.
 *
 * This is the smallest useful extension of Jev's surface: one bounded entry about
 * a corridor or region moves every intersection that serves it in the same
 * direction, which is exactly the citywide trade-off a local controller cannot
 * represent — Adaptive sees only its own approaches, so it can neither drain a
 * region nor meter one.
 *
 * "drain" pulls the margin down (switch sooner, release the zone); "meter" pushes
 * it up (hold longer, throttle entry). The product of applicable intents is
 * clamped to the declared bounds, so no combination can turn a signal into a
 * different machine: min green, max green, yellow, all-red and starvation
 * protection stay the signal mechanics' business, and a directive is still only
 * hold or advance.
 */
export function zoneMargin(
  intersectionId: IntersectionId,
  phase: PhaseObservation | undefined,
  partition: CityPartition,
  weights: JevWeights,
): number {
  let margin = 1;
  if (phase !== undefined) {
    for (const roadId of phase.roads) {
      for (const corridorId of partition.roadCorridors.get(roadId as RoadId) ?? []) {
        const entry = weights.corridorIntent.get(corridorId);
        if (entry !== undefined) {
          margin *= entry.strength;
        }
      }
    }
  }
  const regionId = partition.intersectionRegion.get(intersectionId);
  if (regionId !== undefined) {
    const entry = weights.regionIntent.get(regionId);
    if (entry !== undefined) {
      margin *= entry.strength;
    }
  }
  return clampWeight(margin, JEV_LIMITS.INTENT_STRENGTH_MIN, JEV_LIMITS.INTENT_STRENGTH_MAX);
}

const NEUTRAL_WEIGHTS = resolveJevWeights(neutralJevPolicy());

/**
 * Effective bounded weight for one phase: the phase's most important corridor
 * weight, clamped to JEV_LIMITS' combined bounds. Pure; exported for tests.
 *
 * This is the PHASE-DIFFERENTIATING part of the policy - the only part that can
 * change which of two competing movements is served. The intersection-common
 * part (the global scale and the signal's region weight) deliberately does NOT
 * live here: multiplying both sides of the advance comparison by it cancels, so
 * it is spent on the margin instead (see jevCommonWeight).
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
  return clampWeight(corridor, JEV_LIMITS.COMBINED_WEIGHT_MIN, JEV_LIMITS.COMBINED_WEIGHT_MAX);
}

/**
 * The intersection-common half of the policy: the global scale times this
 * signal's region weight, bounded the same way. It says "this place is under
 * citywide pressure", which is a statement about the SIGNAL rather than about
 * either movement, so it is applied to the release margin - one-sided, and
 * therefore able to decide. A weight above 1 holds greens longer, below 1
 * releases them sooner. Pure; exported for tests.
 */
export function jevCommonWeight(
  intersectionId: IntersectionId,
  partition: CityPartition,
  weights: JevWeights,
): number {
  const regionId = partition.intersectionRegion.get(intersectionId);
  const region = regionId === undefined ? 1 : weights.regionWeight.get(regionId) ?? 1;
  return clampWeight(
    weights.pressureScale * region,
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
  commonWeight = 1,
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
  // The citywide part of the policy is spent here rather than on both pressures:
  // `marginScale` carries the global hint, `commonWeight` the global scale and
  // this signal's region weight. Both are one-sided in the comparison below, so
  // unlike a symmetric multiplier they cannot cancel out.
  const margin =
    JEV_CONSTANTS.SWITCH_MARGIN *
    (1 - JEV_CONSTANTS.AGE_MARGIN_DECAY * ageFraction) *
    marginScale *
    commonWeight;
  return nextPressure > currentPressure + margin ? "advance" : "hold";
}

/** Result metadata: which source governed which part of the run. */
export interface JevControllerMeta {
  readonly kind: "jev";
  readonly mode: "live" | "replay";
  /**
   * Which policy source this run used (Issue #38): "mock" for the deterministic
   * stand-in, "gateway" / "schema-service" for the real thing, "replay" for an
   * offline trace, "unconfigured" when no client was ever supplied (the run was
   * the Adaptive fallback from start to finish). It is part of the run's own
   * account of itself, so no caller has to remember which adapter it wired.
   */
  readonly adapter: JevAdapter;
  /**
   * For a replay: what the RECORDED run was (its adapter, refusals and fallback
   * time). Null when the trace predates #38 — unknown, never "clean".
   */
  readonly recorded: JevTraceRecordedRun | null;
  /** The source in force at the end of the run. */
  readonly source: JevPolicySource;
  readonly liveMs: number;
  readonly replayMs: number;
  readonly fallbackMs: number;
  /**
   * The part of the governed time a policy covered AFTER its freshness window:
   * the model's opinion still decided the signals, but no fresher one arrived in
   * time. Reported so a held run can never be presented as a freshly-driven one.
   */
  readonly heldMs: number;
  readonly maxHoldMs: number;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expiries: number;
  readonly traceEvents: number;
  readonly lastRejection: { readonly kind: string; readonly cause: string; readonly detail: string } | null;
  /** The most recently classified cause, or null when nothing has failed. */
  readonly cause: JevCause | null;
  /** Why the safety net is covering right now; null while a policy governs. */
  readonly fallbackReason: JevCause | null;
  /** How many times each classified cause was seen. */
  readonly causes: JevCauseCounts;
  /** Simulated ms of fallback PER CAUSE — the classification of the lost time. */
  readonly fallbackCauseMs: JevCauseCounts;
  /**
   * The cause that covered the most fallback time: what the run should say when
   * it has to explain why the safety net ran at all.
   */
  readonly dominantFallbackCause: JevCause | null;
  /** Values clamped to their bounds, and answers dropped below the floor. */
  readonly clamped: number;
  readonly dropped: number;
  /**
   * The per-refresh record: which refreshes went live, were held, or needed the
   * safety net, WHY each one that did not go live did not, and a bounded list
   * of the most recent windows (see jev/telemetry.ts). This is the run's answer
   * to "where did Jev fall back, and why" — inspectable after the fact, with
   * nothing upstream-derived in it.
   */
  readonly telemetry: JevRefreshTelemetry;
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
  /** How long one policy may keep governing without a replacement. */
  readonly maxHoldMs?: number;
  readonly request?: JevRequestOptions;
  /** "replay" consumes `trace` offline and never touches a client. */
  readonly mode?: "live" | "replay";
  readonly trace?: JevTrace | null;
  readonly onAccepted?: (event: JevTraceEvent) => void;
  readonly onRejected?: (rejection: JevRejection) => void;
}

function countActiveVehicles(traffic: TrafficState): number {
  // Exactly the non-arrived population; O(1) instead of a history sweep.
  return activeVehicleCount(traffic);
}

export function createJevController(options: JevControllerOptions): JevController {
  // Which source this controller's policies come from, decided once from what it
  // was actually wired with — never taken from a caller's label.
  const adapter: JevAdapter =
    options.mode === "replay"
      ? "replay"
      : options.client === null
        ? "unconfigured"
        : (adapterFromId(options.client.id) ?? "schema-service");
  const runtime: JevRuntime = createJevPolicyRuntime({
    client: options.mode === "replay" ? null : options.client,
    scenarioFingerprint: options.scenarioFingerprint,
    refreshMs: options.refreshMs,
    ttlMs: options.ttlMs,
    minHoldMs: options.minHoldMs,
    maxHoldMs: options.maxHoldMs,
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
    held: false,
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
        adapter,
        recorded: options.trace?.recorded ?? null,
        source: status.source,
        liveMs: status.liveMs,
        replayMs: status.replayMs,
        fallbackMs: status.fallbackMs,
        heldMs: status.heldMs,
        maxHoldMs: status.maxHoldMs,
        refreshes: status.refreshes,
        accepted: status.accepted,
        rejected: status.rejected,
        expiries: status.expiries,
        traceEvents: runtime.trace().events.length,
        lastRejection:
          status.lastRejection === null
            ? null
            : {
                kind: status.lastRejection.kind,
                cause: status.lastRejection.cause,
                detail: status.lastRejection.detail,
              },
        cause: status.lastCause,
        fallbackReason: status.fallbackReason,
        causes: status.causes,
        fallbackCauseMs: status.fallbackCauseMs,
        dominantFallbackCause: status.dominantFallbackCause,
        clamped: status.clamped,
        dropped: status.dropped,
        telemetry: status.refreshTelemetry,
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
        // The margin a signal uses is the policy's global hint scaled by any
        // coordinated zone intent that applies here: this is where one citywide
        // strategy becomes many local decisions at once.
        const intentMargin = zoneMargin(
          intersectionId,
          observation.phases[signal.phaseIndex],
          context.partition,
          weights,
        );
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
          weights.marginScale * intentMargin,
          // The citywide half of the policy: global scale x this signal's
          // region weight, spent on the margin so it cannot cancel.
          jevCommonWeight(intersectionId, context.partition, weights)
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
