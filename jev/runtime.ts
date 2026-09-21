/**
 * Jev policy runtime (Issue #14).
 *
 * The lifecycle around the adapter/controller seam: one place that owns the
 * accepted policy, its validity in SIMULATED time, the request generation it
 * came from, and the trace of everything a scenario actually used.
 *
 * ## Time
 *
 * Every validity decision is made in simulation time. A policy is accepted at a
 * simulated instant, expires at a simulated instant, and is held for a simulated
 * minimum. Wall-clock time governs exactly one thing: how long an HTTP request
 * may take before it is abandoned. That separation is what makes a run
 * replayable — nothing about policy application depends on how fast the machine
 * or the network was.
 *
 * ## The one rule that makes replay exact
 *
 * A policy is IN FORCE from the first tick strictly after the instant it was
 * accepted (`acceptedAtSimMs < nowMs`). Live and replayed runs use the same
 * rule, so both apply a policy to exactly the same ticks — which is why the same
 * scenario can be replayed offline and produce the same result.
 *
 * ## What a response must survive to be accepted
 *
 *   1. the runtime must not have been reset since its request (generation);
 *   2. it must belong to the CURRENT scenario fingerprint;
 *   3. it must belong to the CURRENT request generation — a newer request
 *      supersedes an older response;
 *   4. it must not arrive inside the minimum-hold window of the policy already
 *      in force (hysteresis: no thrashing);
 *   5. it must parse, be clamped and be bounded, against the ids the request
 *      actually carried (the adapter's own parser).
 *
 * Anything else is a REJECTION: counted, reported, and kept out of the trace. A
 * rejected response never touches the policy in force, and an old response can
 * never mutate a new scenario.
 *
 * ## Fallback
 *
 * When no policy is in force — unconfigured, timed out, unavailable, malformed,
 * expired — the runtime reports `source: "fallback"` and the controller runs its
 * Adaptive behaviour. The status carries how much simulated time each source
 * governed (`liveMs` / `replayMs` / `fallbackMs`), so a result can never silently
 * present fallback as live Jev.
 */
import type { ObservationFrame } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import type { JevClient } from "./client";
import { buildJevPolicyRequest, jevPolicyContext, type JevRequestOptions } from "./request";
import { parseJevPolicy, type JevPolicy, type JevPolicyRequest } from "./schema";
import {
  compareTraceEvents,
  emptyTrace,
  type JevPolicySource,
  type JevTrace,
  type JevTraceEvent,
  type JevTraceSource,
} from "./trace";

export const JEV_RUNTIME_DEFAULTS = {
  /** Simulated ms between citywide requests. */
  REFRESH_MS: 5_000,
  /** Simulated ms a policy stays valid after acceptance (three windows). */
  TTL_MS: 15_000,
  /** Simulated ms a newly accepted policy is held before another may replace it. */
  MIN_HOLD_MS: 5_000,
} as const;

export type JevRejectionKind =
  | "stale-generation"
  | "stale-fingerprint"
  | "invalidated"
  | "held"
  | "malformed"
  | "client-error";

export interface JevRejection {
  readonly kind: JevRejectionKind;
  /** Simulated ms the rejection was noticed at. */
  readonly atSimMs: number;
  readonly detail: string;
}

export interface JevRuntimeOptions {
  /** null = unconfigured: the runtime never asks and always falls back. */
  readonly client: JevClient | null;
  readonly scenarioFingerprint: string;
  readonly refreshMs?: number;
  readonly ttlMs?: number;
  readonly minHoldMs?: number;
  readonly request?: JevRequestOptions;
  /** "replay" consumes the supplied trace instead of calling any client. */
  readonly mode?: "live" | "replay";
  readonly trace?: JevTrace | null;
  readonly onAccepted?: (event: JevTraceEvent) => void;
  readonly onRejected?: (rejection: JevRejection) => void;
}

export interface JevRuntimeObservation {
  readonly frame: ObservationFrame;
  readonly partition: CityPartition;
  readonly intersections: number;
  readonly activeVehicles: number;
}

/** What is in force for this tick. `policy` is null exactly when fallback runs. */
export interface JevEffectivePolicy {
  readonly source: JevPolicySource;
  readonly policy: JevPolicy | null;
  readonly acceptedAtSimMs: number | null;
  readonly expiresAtSimMs: number | null;
  readonly generation: number | null;
}

export interface JevRuntimeStatus {
  readonly mode: "live" | "replay";
  readonly configured: boolean;
  readonly source: JevPolicySource;
  readonly inFlight: boolean;
  readonly requestGeneration: number;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly expiries: number;
  /**
   * Simulated time governed by each source. Each interval is attributed to the
   * source that was in force DURING it, so the three always add up to the
   * simulated time observed so far — the interval after the last observation is
   * closed by the next one.
   */
  readonly liveMs: number;
  readonly replayMs: number;
  readonly fallbackMs: number;
  readonly acceptedAtSimMs: number | null;
  readonly expiresAtSimMs: number | null;
  readonly lastRejection: JevRejection | null;
  /** Replay events still waiting for their instant. */
  readonly queuedEvents: number;
}

export interface JevRuntime {
  /** One call per tick, before the controller decides its directives. */
  observe(observation: JevRuntimeObservation): JevEffectivePolicy;
  /** New scenario or reset: discards policy, in-flight answers and the trace. */
  reset(next: { scenarioFingerprint: string; trace?: JevTrace | null }): void;
  /** The policy in force for the most recent observation. */
  effective(): JevEffectivePolicy;
  status(): JevRuntimeStatus;
  /** Everything this scenario accepted, in replay order. */
  trace(): JevTrace;
}

/** Pure refresh trigger: coarse, simulated-time driven, never per tick. */
export function refreshDue(nowMs: number, refreshMs: number): boolean {
  return nowMs % refreshMs === 0;
}

export function createJevPolicyRuntime(options: JevRuntimeOptions): JevRuntime {
  const refreshMs = options.refreshMs ?? JEV_RUNTIME_DEFAULTS.REFRESH_MS;
  const ttlMs = options.ttlMs ?? JEV_RUNTIME_DEFAULTS.TTL_MS;
  const minHoldMs = options.minHoldMs ?? JEV_RUNTIME_DEFAULTS.MIN_HOLD_MS;
  for (const [name, value] of [
    ["refreshMs", refreshMs],
    ["ttlMs", ttlMs],
    ["minHoldMs", minHoldMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be finite and positive, received ${value}`);
    }
  }

  const mode = options.mode ?? "live";
  const client = options.client;
  const configured = client !== null && mode === "live";
  const clientId = client?.id ?? (mode === "replay" ? "replay" : "none");

  let fingerprint = options.scenarioFingerprint;
  let generation = 0;
  /** The policy in force, and the record of everything accepted. */
  let accepted: JevTraceEvent | null = null;
  let recorded: JevTraceEvent[] = [];
  /** Accepted between ticks (live) or waiting for their instant (replay). */
  let pending: JevTraceEvent | null = null;
  let queue: JevTraceEvent[] = [];
  let inFlight = false;
  let lastObservedMs: number | null = null;
  let lastSource: JevPolicySource = "fallback";
  let expiredFor: number | null = null;

  let refreshes = 0;
  let acceptedCount = 0;
  let rejected = 0;
  let expiries = 0;
  let lastRejection: JevRejection | null = null;
  let liveMs = 0;
  let replayMs = 0;
  let fallbackMs = 0;

  const reject = (kind: JevRejectionKind, atSimMs: number, detail: string): void => {
    rejected += 1;
    lastRejection = { kind, atSimMs, detail };
    options.onRejected?.(lastRejection);
  };

  // A replay runtime starts with the trace it was handed, already validated
  // against this scenario: an offline run must refuse the wrong trace rather
  // than replay another scenario's policies.
  if (mode === "replay" && options.trace !== null && options.trace !== undefined) {
    if (options.trace.scenarioFingerprint !== fingerprint) {
      reject(
        "stale-fingerprint",
        0,
        `trace was recorded for ${options.trace.scenarioFingerprint}, not ${fingerprint}`,
      );
    } else {
      queue = [...options.trace.events].sort(compareTraceEvents);
    }
  }

  const adopt = (event: JevTraceEvent): void => {
    accepted = event;
    expiredFor = null;
    recorded.push(event);
    acceptedCount += 1;
    options.onAccepted?.(event);
  };

  /** Pure: which event is in force at a simulated instant. */
  const inForceAt = (nowMs: number): JevTraceEvent | null => {
    if (accepted === null) {
      return null;
    }
    return nowMs > accepted.simulationTimeMs + ttlMs ? null : accepted;
  };

  const effectiveAt = (nowMs: number): JevEffectivePolicy => {
    const event = inForceAt(nowMs);
    if (event === null) {
      return {
        source: "fallback",
        policy: null,
        acceptedAtSimMs: accepted?.simulationTimeMs ?? null,
        expiresAtSimMs: accepted === null ? null : accepted.simulationTimeMs + ttlMs,
        generation: accepted?.requestGeneration ?? null,
      };
    }
    return {
      // Where the policy is coming FROM for this run: a policy replayed offline
      // governs the city as a replay, whatever it was when it was recorded.
      source: mode === "replay" ? "replay" : "live",
      policy: event.policy,
      acceptedAtSimMs: event.simulationTimeMs,
      expiresAtSimMs: event.simulationTimeMs + ttlMs,
      generation: event.requestGeneration,
    };
  };

  /**
   * A response (or a trace event) that wants to become the policy in force.
   * Every guard here is a reason an answer must NOT be trusted.
   */
  const consider = (
    raw: unknown,
    context: {
      readonly requestGeneration: number;
      readonly requestFingerprint: string;
      readonly acceptedAtSimMs: number;
      readonly requestedAtSimMs: number;
      readonly source: JevTraceSource;
      /** Ids the request carried: a policy may only reference these. */
      readonly corridorIds: readonly number[];
      readonly regionIds: readonly number[];
    },
  ): void => {
    if (context.requestGeneration !== generation) {
      reject(
        "stale-generation",
        context.acceptedAtSimMs,
        `generation ${context.requestGeneration} superseded by ${generation}`,
      );
      return;
    }
    if (context.requestFingerprint !== fingerprint) {
      reject(
        "invalidated",
        context.acceptedAtSimMs,
        "the scenario changed under this response",
      );
      return;
    }
    if (accepted !== null && context.acceptedAtSimMs - accepted.simulationTimeMs < minHoldMs) {
      reject(
        "held",
        context.acceptedAtSimMs,
        `policy is held for ${minHoldMs} simulated ms before replacement`,
      );
      return;
    }
    const parsed = parseJevPolicy(raw, {
      corridorIds: context.corridorIds,
      regionIds: context.regionIds,
    });
    if (!parsed.ok) {
      reject("malformed", context.acceptedAtSimMs, parsed.error);
      return;
    }
    const event: JevTraceEvent = {
      scenarioFingerprint: context.requestFingerprint,
      simulationTimeMs: context.acceptedAtSimMs,
      requestedAtSimMs: context.requestedAtSimMs,
      requestGeneration: context.requestGeneration,
      policy: parsed.value.policy,
      source: context.source,
    };
    if (lastObservedMs !== null && event.simulationTimeMs === lastObservedMs) {
      // Resolved inside the current tick: in force from the next one.
      pending = event;
    } else {
      adopt(event);
    }
  };

  const startRequest = (observation: JevRuntimeObservation, nowMs: number): void => {
    if (client === null) {
      return;
    }
    const request: JevPolicyRequest = buildJevPolicyRequest(
      {
        frame: observation.frame,
        partition: observation.partition,
        intersections: observation.intersections,
        activeVehicles: observation.activeVehicles,
      },
      options.request,
    );
    const policyContext = jevPolicyContext(request);
    generation += 1;
    const requestGeneration = generation;
    const requestFingerprint = fingerprint;
    refreshes += 1;
    inFlight = true;
    const settle = (raw: unknown): void => {
      consider(raw, {
        requestGeneration,
        requestFingerprint,
        acceptedAtSimMs: lastObservedMs ?? nowMs,
        requestedAtSimMs: nowMs,
        source: "live",
        corridorIds: policyContext.corridorIds,
        regionIds: policyContext.regionIds,
      });
    };
    try {
      const answer = client.requestPolicy(request);
      if (typeof (answer as { then?: unknown } | null)?.then === "function") {
        (answer as Promise<unknown>)
          .then(settle)
          .catch((error: unknown) => {
            reject(
              "client-error",
              lastObservedMs ?? nowMs,
              error instanceof Error ? error.message : "jev client failed",
            );
          })
          .finally(() => {
            inFlight = false;
          });
      } else {
        settle(answer);
        inFlight = false;
      }
    } catch (error: unknown) {
      reject("client-error", nowMs, error instanceof Error ? error.message : "jev client failed");
      inFlight = false;
    }
  };

  return {
    observe(observation) {
      const nowMs = observation.frame.timeMs;

      // Account the simulated time the PREVIOUS interval spent in its source.
      if (lastObservedMs !== null) {
        const delta = Math.max(0, nowMs - lastObservedMs);
        if (lastSource === "live") {
          liveMs += delta;
        } else if (lastSource === "replay") {
          replayMs += delta;
        } else {
          fallbackMs += delta;
        }
      }
      lastObservedMs = nowMs;

      // Expire first: an expired policy is not in force for this tick.
      if (accepted !== null && nowMs > accepted.simulationTimeMs + ttlMs && expiredFor !== accepted.simulationTimeMs) {
        expiredFor = accepted.simulationTimeMs;
        expiries += 1;
      }

      if (mode === "replay") {
        // Every event whose instant the clock has passed, oldest first.
        while (queue.length > 0 && queue[0].simulationTimeMs < nowMs) {
          adopt(queue.shift() as JevTraceEvent);
        }
      } else {
        if (pending !== null && pending.simulationTimeMs < nowMs) {
          adopt(pending);
          pending = null;
        }
        if (configured && refreshDue(nowMs, refreshMs) && !inFlight) {
          startRequest(observation, nowMs);
        }
      }

      const effective = effectiveAt(nowMs);
      lastSource = effective.source;
      return effective;
    },

    reset(next) {
      // A reset invalidates everything in flight: its responses are stale by
      // generation, so they can never mutate the new scenario.
      generation += 1;
      fingerprint = next.scenarioFingerprint;
      accepted = null;
      pending = null;
      expiredFor = null;
      inFlight = false;
      lastObservedMs = null;
      lastSource = "fallback";
      recorded = [];
      queue = [];
      refreshes = 0;
      acceptedCount = 0;
      rejected = 0;
      expiries = 0;
      lastRejection = null;
      liveMs = 0;
      replayMs = 0;
      fallbackMs = 0;

      const trace = next.trace ?? null;
      if (mode === "replay") {
        if (trace === null) {
          reject("stale-fingerprint", 0, "replay mode needs a trace");
          return;
        }
        if (trace.scenarioFingerprint !== fingerprint) {
          reject(
            "stale-fingerprint",
            0,
            `trace was recorded for ${trace.scenarioFingerprint}, not ${fingerprint}`,
          );
          return;
        }
        queue = [...trace.events].sort(compareTraceEvents);
      }
    },

    effective() {
      return effectiveAt(lastObservedMs ?? 0);
    },

    status() {
      return {
        mode,
        configured,
        source: effectiveAt(lastObservedMs ?? 0).source,
        inFlight,
        requestGeneration: generation,
        refreshes,
        accepted: acceptedCount,
        rejected,
        expiries,
        liveMs,
        replayMs,
        fallbackMs,
        acceptedAtSimMs: accepted?.simulationTimeMs ?? null,
        expiresAtSimMs: accepted === null ? null : accepted.simulationTimeMs + ttlMs,
        lastRejection,
        queuedEvents: queue.length,
      };
    },

    trace() {
      return {
        version: emptyTrace(fingerprint, clientId).version,
        controllerId: emptyTrace(fingerprint, clientId).controllerId,
        client: clientId,
        scenarioFingerprint: fingerprint,
        events: [...recorded].sort(compareTraceEvents),
      };
    },
  };
}
