/**
 * Jev controller (Issue #13): a citywide policy controller behind the same
 * `TrafficController` contract as Fixed and Adaptive.
 *
 * ## Division of labour
 *
 * Jev's opinion arrives as a bounded policy (see jev/schema.ts) and is
 * translated DETERMINISTICALLY into the only two things a controller may say:
 * "hold" and "advance". Everything legal stays local: min green, max green,
 * yellow, all-red, ring order and every safety constraint are enforced by
 * sim/signals.ts whatever this controller asks for, and Jev can never name a
 * phase, a green time or a lamp state.
 *
 * The starvation rule is shared with Adaptive and evaluated FIRST, on UNWEIGHTED
 * waits. A policy — however hostile, however extreme — therefore cannot starve
 * a movement: weights only scale pressure, never the service guarantee.
 *
 * ## Cadence
 *
 * One compact citywide request every `JEV_CONSTANTS.REFRESH_MS` of SIMULATED
 * time (5 s by default), triggered by a pure function of the frame's clock
 * (`timeMs % refreshMs === 0`), never per tick, never per vehicle and never one
 * call per intersection. Requests are asynchronous: a tick never blocks on the
 * network, and a refresh that is still in flight simply defers the next one.
 * A synchronous client (the mock) answers inside the tick, which is what makes
 * a mocked benchmark run reproducible.
 *
 * ## State
 *
 * The controller holds exactly one piece of private state — the most recent
 * VALIDATED policy — because a policy arrives from outside the simulation. Its
 * directives remain a pure function of (city, frame, policy), so identical
 * inputs with the same policy always produce identical directives. A malformed
 * or failed response is rejected and the previous policy stays in force: the
 * controller never invents one.
 */
import { starvedPhaseIndex } from "./adaptive";
import { ADAPTIVE_CONSTANTS, phasePressure } from "./adaptive";
import type { TrafficController, TrafficControllerContext } from "./contract";
import type { JevClient } from "@/jev/client";
import { buildJevPolicyRequest, jevPolicyContext, type JevRequestOptions } from "@/jev/request";
import {
  JEV_HINT_MARGIN_SCALE,
  JEV_LIMITS,
  clampWeight,
  neutralJevPolicy,
  parseJevPolicy,
  type JevPolicy,
  type JevPolicyRequest,
} from "@/jev/schema";
import type { IntersectionObservation, PhaseObservation } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import type { SignalDirective, SignalState } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId, RoadId } from "@/sim/types";

export const JEV_CONSTANTS = {
  /** Simulated ms between citywide policy requests. */
  REFRESH_MS: 5_000,
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

export interface JevRefreshEvent {
  /** Simulated time the request was built at. */
  readonly timeMs: number;
  readonly applied: boolean;
  readonly error: string | null;
  readonly clamped: readonly string[];
}

export interface JevControllerStatus {
  /** "neutral" until the first valid policy arrives, then "client". */
  readonly policySource: "neutral" | "client";
  /** Simulated time the policy in force was received for, if any. */
  readonly policyTimeMs: number | null;
  readonly refreshes: number;
  readonly applied: number;
  readonly rejected: number;
  readonly lastError: string | null;
  readonly lastClamped: readonly string[];
  /** Whether a request is in flight right now. */
  readonly inFlight: boolean;
}

export interface JevControllerOptions {
  readonly client: JevClient;
  /** Simulated ms between requests; defaults to JEV_CONSTANTS.REFRESH_MS. */
  readonly refreshMs?: number;
  readonly request?: JevRequestOptions;
  /** Called after every refresh completes, for tests and diagnostics. */
  readonly onRefresh?: (event: JevRefreshEvent) => void;
}

export interface JevController extends TrafficController {
  /** Current policy in force (the neutral policy before the first answer). */
  policy(): JevPolicy;
  status(): JevControllerStatus;
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

function isThenable(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

export function createJevController(options: JevControllerOptions): JevController {
  const client = options.client;
  const refreshMs = options.refreshMs ?? JEV_CONSTANTS.REFRESH_MS;
  if (!Number.isFinite(refreshMs) || refreshMs <= 0) {
    throw new RangeError(`refreshMs must be finite and positive, received ${refreshMs}`);
  }

  let policy = neutralJevPolicy();
  let weights = resolveJevWeights(policy);
  let policyTimeMs: number | null = null;
  let policySource: "neutral" | "client" = "neutral";
  let inFlight = false;
  let refreshes = 0;
  let applied = 0;
  let rejected = 0;
  let lastError: string | null = null;
  let lastClamped: readonly string[] = [];

  const apply = (raw: unknown, request: JevPolicyRequest, timeMs: number): void => {
    const parsed = parseJevPolicy(raw, jevPolicyContext(request));
    if (!parsed.ok) {
      rejected += 1;
      lastError = parsed.error;
      lastClamped = [];
      options.onRefresh?.({ timeMs, applied: false, error: parsed.error, clamped: [] });
      return;
    }
    policy = parsed.value.policy;
    weights = resolveJevWeights(policy);
    policyTimeMs = timeMs;
    policySource = "client";
    applied += 1;
    lastError = null;
    lastClamped = parsed.value.clamped;
    options.onRefresh?.({
      timeMs,
      applied: true,
      error: null,
      clamped: parsed.value.clamped,
    });
  };

  const fail = (message: string, timeMs: number): void => {
    rejected += 1;
    lastError = message;
    options.onRefresh?.({ timeMs, applied: false, error: message, clamped: [] });
  };

  return {
    id: "jev",
    policy: () => policy,
    status: () => ({
      policySource,
      policyTimeMs,
      refreshes,
      applied,
      rejected,
      lastError,
      lastClamped,
      inFlight,
    }),
    directives(
      city: City,
      traffic: TrafficState,
      context?: TrafficControllerContext,
    ): ReadonlyMap<IntersectionId, SignalDirective> {
      const directives = new Map<IntersectionId, SignalDirective>();
      if (!context) {
        return directives; // no observations: no opinion (defensive)
      }
      const frame = context.observations;

      // Refresh trigger: a pure function of the simulated clock. A request that
      // is still in flight defers the next one rather than stacking them.
      if (frame.timeMs % refreshMs === 0 && !inFlight) {
        const request = buildJevPolicyRequest(
          {
            frame,
            partition: context.partition,
            intersections: city.intersections.length,
            activeVehicles: countActiveVehicles(traffic),
          },
          options.request,
        );
        refreshes += 1;
        inFlight = true;
        try {
          const answer = client.requestPolicy(request);
          if (isThenable(answer)) {
            answer
              .then((raw) => apply(raw, request, frame.timeMs))
              .catch((error: unknown) => {
                fail(error instanceof Error ? error.message : "jev client failed", frame.timeMs);
              })
              .finally(() => {
                inFlight = false;
              });
          } else {
            apply(answer, request, frame.timeMs);
            inFlight = false;
          }
        } catch (error: unknown) {
          fail(error instanceof Error ? error.message : "jev client failed", frame.timeMs);
          inFlight = false;
        }
      }

      for (const [intersectionId, signal] of traffic.signals) {
        const observation = frame.intersections.get(intersectionId);
        if (!observation) {
          continue;
        }
        const directive = jevDirective(
          signal,
          observation,
          (phaseIndex) => jevPhaseWeight(observation.phases[phaseIndex], intersectionId, context.partition, weights),
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
