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
 * When no policy is in force — unconfigured, no answer yet, or a policy that has
 * outlived even its maximum hold — the runtime reports `source: "fallback"` and
 * the controller runs its Adaptive behaviour. The status carries how much
 * simulated time each source governed (`liveMs` / `replayMs` / `fallbackMs`), so
 * a result can never silently present fallback as live Jev.
 *
 * ## Holding the last good policy (the tail, and every slow refresh)
 *
 * A policy is FRESH for `ttlMs` after its acceptance and may keep governing for
 * up to `maxHoldMs` (default `MAX_HOLD_TTLS` freshness windows) when nothing has
 * replaced it. Past the freshness window it is reported as HELD, not as fresh:
 * `heldMs` counts the part of `liveMs`/`replayMs` a held policy governed, and
 * the run says so out loud.
 *
 * Why this exists, measured rather than assumed: the app's paced playback lets a
 * remote model answer inside the refresh window, but the run's last stretch is
 * simulated back to back (the ego has arrived; the tail exists so the visible
 * run covers the same window as its baselines) and a back-to-back loop never
 * turns the event loop, so an answer already in flight cannot land. With a
 * one-window TTL that tail was attributed to the Adaptive fallback — measured at
 * 26.7% of a 600 s run (140 s of it in the tail) against a PERFECT model client
 * with zero rejections. That is a report about the drive, not about the model,
 * and it hid what the model was actually doing for a third of every run.
 *
 * The rule stays a pure function of simulated time and the accepted events, which
 * is what keeps replay exact: a replayed trace holds and expires exactly where
 * the recorded run did. Nothing here loosens a safety bound — the mechanics own
 * min green, max green, yellow, all-red and starvation, and a held policy goes
 * through the same bounded translation as a fresh one.
 *
 * ## Why a fallback happened, and what an answer cost
 *
 * Every rejection carries a bounded `cause` (see `JevCause`) classified from the
 * transport, not from prose, and the status aggregates them
 * (`causes`, `lastCause`, `fallbackReason`). Answers that were APPLIED but
 * imperfect are counted too (`clamped`, `dropped`), because "the model's policy
 * governed the run" and "the model's policy governed the run perfectly" are
 * different claims and the product must be able to tell them apart.
 */
import type { ObservationFrame } from "@/sim/observations";
import type { CityPartition } from "@/sim/regions";
import { JevClientError, type JevClient, type JevClientFailure } from "./client";
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
  /** Simulated ms between citywide requests. At 8x playback the old 5 s
   * cadence sent about 90/min and the live Gateway returned 429 repeatedly;
   * 20 s targets about 23/min without changing any simulation timestep. */
  REFRESH_MS: 20_000,
  /** Simulated ms a policy stays FRESH after acceptance (three windows). */
  TTL_MS: 60_000,
  /** Simulated ms a newly accepted policy is held before another may replace it. */
  MIN_HOLD_MS: 5_000,
  /**
   * How many freshness windows one accepted policy may keep governing without a
   * replacement, before the safety net takes over. Derived from a measurement,
   * not chosen for roundness: the curated trips arrive 152-202 s of simulated
   * time before the 600 s horizon, and the back-to-back tail after arrival is
   * where the old one-window rule handed a third of every run to the Adaptive
   * fallback (measured 26.7%, 140 s of it in the tail, with a perfect model).
   * Five windows (5 x 60 s = 300 s) covers that tail with margin while still
   * ending a service that has genuinely gone silent.
   */
  MAX_HOLD_TTLS: 5,
} as const;

/**
 * Why the safety net is covering, or why an answer was not used. A closed set:
 * every member is either a transport fact or a lifecycle fact, so a label can
 * say WHY without echoing anything a service said.
 *
 * The transport half is owned by `jev/client.ts` (`JevClientFailure`), because
 * that is where statuses are turned into classes.
 */
export type JevCause =
  | JevClientFailure
  /** No client at all: Jev was never wired in. */
  | "unconfigured"
  /** Configured and asking, but no answer has been accepted yet. */
  | "first-policy"
  /** The policy in force outlived even its maximum hold. */
  | "expired"
  /** An answer arrived inside the minimum-hold window and was refused. */
  | "held"
  /** An answer belonged to a superseded request or a scenario that moved. */
  | "superseded";

/** Every cause, for validation, counting and label coverage. */
export const JEV_CAUSES = [
  "unconfigured",
  "first-policy",
  "expired",
  "held",
  "superseded",
  "timeout",
  "rate-limited",
  "upstream-error",
  "rejected",
  "unreachable",
  "not-configured",
  "malformed",
  "unknown",
] as const satisfies readonly JevCause[];

export type JevRejectionKind =
  | "stale-generation"
  | "stale-fingerprint"
  | "invalidated"
  | "held"
  | "malformed"
  | "client-error";

export interface JevRejection {
  readonly kind: JevRejectionKind;
  /** The classified cause behind the rejection; never upstream prose. */
  readonly cause: JevCause;
  /** Simulated ms the rejection was noticed at. */
  readonly atSimMs: number;
  readonly detail: string;
}

/**
 * The bounded cause of a client failure. A `JevClientError` already carries its
 * class; anything else is classified from the error's own message, which for
 * our clients is always a status line this codebase wrote.
 */
export function clientFailureCause(error: unknown): JevCause {
  if (error instanceof JevClientError) {
    return error.failure;
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return "timeout";
  }
  const message = error instanceof Error ? error.message : "";
  const status = Number(/responded (\d{3})/.exec(message)?.[1] ?? Number.NaN);
  if (status === 429) {
    return "rate-limited";
  }
  if (status >= 500) {
    return "upstream-error";
  }
  if (status >= 400) {
    return "rejected";
  }
  return "unknown";
}

/** Per-cause counts: only the causes that actually happened appear. */
export type JevCauseCounts = Readonly<Partial<Record<JevCause, number>>>;

export interface JevRuntimeOptions {
  /** null = unconfigured: the runtime never asks and always falls back. */
  readonly client: JevClient | null;
  readonly scenarioFingerprint: string;
  readonly refreshMs?: number;
  readonly ttlMs?: number;
  readonly minHoldMs?: number;
  /**
   * How long one accepted policy may keep governing without a replacement.
   * Defaults to `ttlMs * MAX_HOLD_TTLS`. Must not be shorter than `ttlMs`: a
   * policy cannot be expected to stop governing before it stops being fresh.
   */
  readonly maxHoldMs?: number;
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
  /** When the policy's FRESHNESS window ends. It may keep governing past it. */
  readonly expiresAtSimMs: number | null;
  readonly generation: number | null;
  /** True when the policy in force is past its freshness window (held). */
  readonly held: boolean;
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
  /**
   * The part of `liveMs + replayMs` a policy governed AFTER its freshness
   * window had passed. A subset, never a fourth bucket: the governed-time sum is
   * unchanged, and this is what keeps "the model's policy governed the run"
   * distinguishable from "it governed it with a fresh opinion".
   */
  readonly heldMs: number;
  /** Simulated ms a policy may keep governing without a replacement. */
  readonly maxHoldMs: number;
  readonly acceptedAtSimMs: number | null;
  /** When the policy in force stops being fresh (it may keep governing). */
  readonly expiresAtSimMs: number | null;
  readonly lastRejection: JevRejection | null;
  /** The most recently classified cause, or null when nothing has failed yet. */
  readonly lastCause: JevCause | null;
  /** How many times each cause was seen. Only causes that happened appear. */
  readonly causes: JevCauseCounts;
  /** Why the safety net is covering right now; null while a policy governs. */
  readonly fallbackReason: JevCause | null;
  /**
   * Simulated ms the safety net covered PER CAUSE — the classification of the
   * fallback time itself, not of the refusals. A run can fall back with zero
   * refusals (waiting for its first answer), so this is the only place that
   * cause shows up; the intervals add up to `fallbackMs`.
   */
  readonly fallbackCauseMs: JevCauseCounts;
  /**
   * The cause that covered the most fallback time (`null` when none did), the
   * one the run should name. Ties break on JEV_CAUSES order, so it is a pure
   * function of the same accounting as everything else.
   */
  readonly dominantFallbackCause: JevCause | null;
  /** Values clamped to their bounds across accepted answers (imperfections). */
  readonly clamped: number;
  /** Answers dropped below the confidence floor across accepted answers. */
  readonly dropped: number;
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
  const maxHoldMs = options.maxHoldMs ?? ttlMs * JEV_RUNTIME_DEFAULTS.MAX_HOLD_TTLS;
  for (const [name, value] of [
    ["refreshMs", refreshMs],
    ["ttlMs", ttlMs],
    ["minHoldMs", minHoldMs],
    ["maxHoldMs", maxHoldMs],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError(`${name} must be finite and positive, received ${value}`);
    }
  }
  if (maxHoldMs < ttlMs) {
    throw new RangeError(
      `maxHoldMs must not be shorter than ttlMs, received ${maxHoldMs} < ${ttlMs}`,
    );
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
  /**
   * The generation that OWNS the single in-flight slot, or null when it is free.
   * Ownership is what stops a superseded request from releasing a newer one's
   * lock when it finally settles: only the owner may clear it.
   */
  let inFlightGeneration: number | null = null;
  let lastObservedMs: number | null = null;
  let lastSource: JevPolicySource = "fallback";
  /** Whether the policy in force during the last interval was past its window. */
  let lastHeld = false;
  let expiredFor: number | null = null;

  let refreshes = 0;
  let acceptedCount = 0;
  let rejected = 0;
  let expiries = 0;
  let lastRejection: JevRejection | null = null;
  let lastCause: JevCause | null = null;
  const causeCounts = new Map<JevCause, number>();
  /** The cause that was in force during the interval currently being lived. */
  let fallbackCauseInForce: JevCause | null = null;
  const fallbackCauseMs = new Map<JevCause, number>();
  let clampedCount = 0;
  let droppedCount = 0;
  let liveMs = 0;
  let replayMs = 0;
  let fallbackMs = 0;
  let heldMs = 0;

  const countCause = (cause: JevCause): void => {
    lastCause = cause;
    causeCounts.set(cause, (causeCounts.get(cause) ?? 0) + 1);
  };

  const reject = (
    kind: JevRejectionKind,
    atSimMs: number,
    detail: string,
    cause: JevCause,
  ): void => {
    rejected += 1;
    countCause(cause);
    lastRejection = { kind, cause, atSimMs, detail };
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
        "superseded",
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

  /** True once the event's freshness window has passed. Pure. */
  const isStale = (nowMs: number, event: JevTraceEvent): boolean =>
    nowMs - event.simulationTimeMs > ttlMs;

  /**
   * Pure: which event is in force at a simulated instant.
   *
   * In force from acceptance until `maxHoldMs`, so a policy keeps governing
   * while its replacement is still being fetched. Past the freshness window it
   * is HELD (reported as such); past the maximum hold the safety net takes over.
   * Both bounds are simulated time, so a replay holds and expires exactly where
   * the recorded run did.
   */
  const inForceAt = (nowMs: number): JevTraceEvent | null => {
    if (accepted === null) {
      return null;
    }
    return nowMs > accepted.simulationTimeMs + maxHoldMs ? null : accepted;
  };

  /** Why the safety net is covering at this instant; null while a policy does. */
  const fallbackReasonAt = (nowMs: number): JevCause | null => {
    if (inForceAt(nowMs) !== null) {
      return null;
    }
    if (!configured) {
      return "unconfigured";
    }
    if (accepted === null) {
      // Nothing has ever been accepted: either no answer is due yet, or every
      // attempt so far failed — and then the failure is the honest reason.
      return lastCause ?? "first-policy";
    }
    return "expired";
  };

  /**
   * The cause that covered the most fallback time, or null when none did.
   * Ties break on JEV_CAUSES order so the answer never depends on insertion.
   */
  const dominantFallbackCause = (): JevCause | null => {
    let best: JevCause | null = null;
    let bestMs = 0;
    for (const cause of JEV_CAUSES) {
      const ms = fallbackCauseMs.get(cause) ?? 0;
      if (ms > bestMs) {
        best = cause;
        bestMs = ms;
      }
    }
    return best;
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
        held: false,
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
      held: isStale(nowMs, event),
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
        "superseded",
      );
      return;
    }
    if (context.requestFingerprint !== fingerprint) {
      reject(
        "invalidated",
        context.acceptedAtSimMs,
        "the scenario changed under this response",
        "superseded",
      );
      return;
    }
    if (accepted !== null && context.acceptedAtSimMs - accepted.simulationTimeMs < minHoldMs) {
      reject(
        "held",
        context.acceptedAtSimMs,
        `policy is held for ${minHoldMs} simulated ms before replacement`,
        "held",
      );
      return;
    }
    const parsed = parseJevPolicy(raw, {
      corridorIds: context.corridorIds,
      regionIds: context.regionIds,
    });
    if (!parsed.ok) {
      reject("malformed", context.acceptedAtSimMs, parsed.error, "malformed");
      return;
    }
    // What this answer COST: counted only for an answer the run actually uses,
    // so the imperfection numbers describe the policy that governed.
    const notes = client?.answerNotes?.() ?? null;
    if (notes !== null) {
      clampedCount += notes.clamped;
      droppedCount += notes.dropped;
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
    inFlightGeneration = requestGeneration;
    /** Release the slot only if this request still owns it. */
    const release = (): void => {
      if (inFlightGeneration === requestGeneration) {
        inFlightGeneration = null;
      }
    };
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
              clientFailureCause(error),
            );
          })
          .finally(release);
      } else {
        settle(answer);
        release();
      }
    } catch (error: unknown) {
      reject(
        "client-error",
        nowMs,
        error instanceof Error ? error.message : "jev client failed",
        clientFailureCause(error),
      );
      release();
    }
  };

  return {
    observe(observation) {
      const nowMs = observation.frame.timeMs;

      // Account the simulated time the PREVIOUS interval spent in its source,
      // and — separately — how much of it a policy governed past its freshness
      // window. `heldMs` is a SUBSET of the governed time, never a fourth
      // bucket, so the three sources still add up to the observed span.
      if (lastObservedMs !== null) {
        const delta = Math.max(0, nowMs - lastObservedMs);
        if (lastSource === "live") {
          liveMs += delta;
          if (lastHeld) heldMs += delta;
        } else if (lastSource === "replay") {
          replayMs += delta;
          if (lastHeld) heldMs += delta;
        } else {
          fallbackMs += delta;
          // The classification of the fallback TIME, which is not the same as
          // the list of refusals: the opening gap of a run that never failed
          // anything is still fallback time, with its own reason.
          if (fallbackCauseInForce !== null) {
            fallbackCauseMs.set(
              fallbackCauseInForce,
              (fallbackCauseMs.get(fallbackCauseInForce) ?? 0) + delta,
            );
          }
        }
      }
      lastObservedMs = nowMs;

      // A policy's freshness window passing is counted once per policy, whether
      // or not the run keeps holding it: the model failed to be refreshed in
      // time, and that is a fact about the run.
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
        if (configured && refreshDue(nowMs, refreshMs) && inFlightGeneration === null) {
          startRequest(observation, nowMs);
        }
      }

      const effective = effectiveAt(nowMs);
      lastSource = effective.source;
      lastHeld = effective.held;
      // Remember why the interval that starts now is on the fallback (or null
      // when a policy governs it), so the NEXT accounting can classify it.
      fallbackCauseInForce = effective.source === "fallback" ? fallbackReasonAt(nowMs) : null;
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
      // A reset frees the slot for the new scenario; whatever was in flight is
      // stale by generation and can no longer clear it (see release()).
      inFlightGeneration = null;
      lastObservedMs = null;
      lastSource = "fallback";
      lastHeld = false;
      recorded = [];
      queue = [];
      refreshes = 0;
      acceptedCount = 0;
      rejected = 0;
      expiries = 0;
      lastRejection = null;
      lastCause = null;
      causeCounts.clear();
      fallbackCauseInForce = null;
      fallbackCauseMs.clear();
      clampedCount = 0;
      droppedCount = 0;
      liveMs = 0;
      replayMs = 0;
      fallbackMs = 0;
      heldMs = 0;

      const trace = next.trace ?? null;
      if (mode === "replay") {
        if (trace === null) {
          reject("stale-fingerprint", 0, "replay mode needs a trace", "superseded");
          return;
        }
        if (trace.scenarioFingerprint !== fingerprint) {
          reject(
            "stale-fingerprint",
            0,
            `trace was recorded for ${trace.scenarioFingerprint}, not ${fingerprint}`,
            "superseded",
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
      const nowMs = lastObservedMs ?? 0;
      const causes: Record<string, number> = {};
      const fallbackCauses: Record<string, number> = {};
      for (const cause of JEV_CAUSES) {
        const count = causeCounts.get(cause);
        if (count !== undefined) {
          causes[cause] = count;
        }
        const ms = fallbackCauseMs.get(cause);
        if (ms !== undefined) {
          fallbackCauses[cause] = ms;
        }
      }
      return {
        mode,
        configured,
        source: effectiveAt(nowMs).source,
        inFlight: inFlightGeneration !== null,
        requestGeneration: generation,
        refreshes,
        accepted: acceptedCount,
        rejected,
        expiries,
        liveMs,
        replayMs,
        fallbackMs,
        heldMs,
        maxHoldMs,
        acceptedAtSimMs: accepted?.simulationTimeMs ?? null,
        expiresAtSimMs: accepted === null ? null : accepted.simulationTimeMs + ttlMs,
        lastRejection,
        lastCause,
        causes,
        fallbackReason: fallbackReasonAt(nowMs),
        fallbackCauseMs: fallbackCauses,
        dominantFallbackCause: dominantFallbackCause(),
        clamped: clampedCount,
        dropped: droppedCount,
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
