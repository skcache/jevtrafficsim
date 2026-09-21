/**
 * The Jev policy trace (Issue #14).
 *
 * A trace is the record of every policy a scenario ACTUALLY ACCEPTED, in
 * simulation time, with enough provenance to prove where each one came from.
 * It is the whole basis of replay: a run can be reproduced offline, with zero
 * network calls, from this file alone.
 *
 * ## What is in a trace, and what is deliberately not
 *
 * Only accepted policies are events. A malformed response, a timed-out request,
 * a stale answer from a superseded generation and a policy refused by hysteresis
 * are all absent — a replay stream must not contain a policy the run never used,
 * or replaying it would invent behaviour that did not happen. Rejections are
 * counted in the runtime's status and reported to the caller; they are not
 * policy.
 *
 * Fallback is not an event either. "No valid policy right now" is a property of
 * the gap between events, and it is reproduced exactly by replaying the same
 * times against the same TTL — recording it would be recording a decision the
 * run did not make.
 *
 * ## Determinism
 *
 * Events are ordered by simulated time (ties by request generation), every
 * number is finite, and serialising a trace twice produces the same bytes. A
 * replay therefore consumes an identical stream and, given the same scenario,
 * produces an identical ChallengeResult.
 */
import {
  JEV_HINTS,
  JEV_SCHEMA_VERSION,
  type JevHint,
  type JevPolicy,
  type JevValidation,
} from "./schema";

export const JEV_TRACE_VERSION = 1;

/** Where a policy in force came from. */
export type JevPolicySource = "live" | "replay" | "fallback";

/** Sources a recorded event can have: fallback is never recorded as a policy. */
export type JevTraceSource = Exclude<JevPolicySource, "fallback">;

export interface JevTraceEvent {
  /** The scenario this policy belongs to; a mismatch invalidates it. */
  readonly scenarioFingerprint: string;
  /**
   * Simulated ms at which the policy was ACCEPTED. It takes effect from the
   * next tick — the same rule live and replayed runs use, so both apply it to
   * exactly the same ticks.
   */
  readonly simulationTimeMs: number;
  /** Simulated ms at which the request that produced it was made. */
  readonly requestedAtSimMs: number;
  /** Monotonic per-runtime request counter; a newer one supersedes older ones. */
  readonly requestGeneration: number;
  readonly policy: JevPolicy;
  readonly source: JevTraceSource;
}

export interface JevTrace {
  readonly version: typeof JEV_TRACE_VERSION;
  /** Controller the trace was recorded for ("jev"). */
  readonly controllerId: string;
  /** Client that produced the policies ("gateway", "live", "mock", "replay"). */
  readonly client: string;
  /** The scenario every event must match. */
  readonly scenarioFingerprint: string;
  readonly events: readonly JevTraceEvent[];
}

export function emptyTrace(
  scenarioFingerprint: string,
  client: string,
  controllerId = "jev",
): JevTrace {
  return { version: JEV_TRACE_VERSION, controllerId, client, scenarioFingerprint, events: [] };
}

/** Order events the way replay consumes them: simulated time, then generation. */
export function compareTraceEvents(a: JevTraceEvent, b: JevTraceEvent): number {
  return a.simulationTimeMs - b.simulationTimeMs || a.requestGeneration - b.requestGeneration;
}

/** A trace with its events in replay order. Pure. */
export function normalizeTrace(trace: JevTrace): JevTrace {
  return { ...trace, events: [...trace.events].sort(compareTraceEvents) };
}

/** Deterministic serialisation: same trace, same bytes. */
export function serializeTrace(trace: JevTrace): string {
  return `${JSON.stringify(normalizeTrace(trace), null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePolicy(value: unknown): JevPolicy | null {
  if (!isPlainObject(value) || value.schemaVersion !== JEV_SCHEMA_VERSION) {
    return null;
  }
  const pressureScale = finite(value.pressureScale);
  if (pressureScale === null) {
    return null;
  }
  const hint = value.hint;
  if (typeof hint !== "string" || !(JEV_HINTS as readonly string[]).includes(hint)) {
    return null;
  }
  const list = (raw: unknown): { id: number; weight: number }[] | null => {
    if (!Array.isArray(raw)) {
      return null;
    }
    const entries: { id: number; weight: number }[] = [];
    for (const entry of raw) {
      if (!isPlainObject(entry)) {
        return null;
      }
      const id = finite(entry.id);
      const weight = finite(entry.weight);
      if (id === null || !Number.isInteger(id) || weight === null) {
        return null;
      }
      entries.push({ id, weight });
    }
    return entries;
  };
  const corridorWeights = list(value.corridorWeights);
  const regionWeights = list(value.regionWeights);
  if (corridorWeights === null || regionWeights === null) {
    return null;
  }
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    pressureScale,
    hint: hint as JevHint,
    corridorWeights,
    regionWeights,
  };
}

/**
 * Validate a trace that came from outside (a file, a fixture). Structural only:
 * a trace may reference any policy the schema accepts, including one this city
 * would not produce.
 */
export function parseJevTrace(value: unknown): JevValidation<JevTrace> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "trace must be an object" };
  }
  if (value.version !== JEV_TRACE_VERSION) {
    return { ok: false, error: `unsupported trace version (expected ${JEV_TRACE_VERSION})` };
  }
  if (typeof value.scenarioFingerprint !== "string" || value.scenarioFingerprint.length === 0) {
    return { ok: false, error: "trace needs a scenarioFingerprint" };
  }
  if (typeof value.controllerId !== "string" || typeof value.client !== "string") {
    return { ok: false, error: "trace needs controllerId and client" };
  }
  if (!Array.isArray(value.events)) {
    return { ok: false, error: "trace.events must be an array" };
  }
  const events: JevTraceEvent[] = [];
  for (const [index, raw] of value.events.entries()) {
    if (!isPlainObject(raw)) {
      return { ok: false, error: `event ${index} must be an object` };
    }
    if (raw.scenarioFingerprint !== value.scenarioFingerprint) {
      return { ok: false, error: `event ${index} belongs to a different scenario` };
    }
    const simulationTimeMs = finite(raw.simulationTimeMs);
    const requestedAtSimMs = finite(raw.requestedAtSimMs);
    const requestGeneration = finite(raw.requestGeneration);
    if (simulationTimeMs === null || simulationTimeMs < 0) {
      return { ok: false, error: `event ${index} needs a non-negative simulationTimeMs` };
    }
    if (requestedAtSimMs === null || requestedAtSimMs < 0) {
      return { ok: false, error: `event ${index} needs a non-negative requestedAtSimMs` };
    }
    if (requestGeneration === null || !Number.isInteger(requestGeneration) || requestGeneration < 0) {
      return { ok: false, error: `event ${index} needs a non-negative integer requestGeneration` };
    }
    if (raw.source !== "live" && raw.source !== "replay") {
      return { ok: false, error: `event ${index} needs source "live" or "replay"` };
    }
    const policy = parsePolicy(raw.policy);
    if (policy === null) {
      return { ok: false, error: `event ${index} carries a malformed policy` };
    }
    events.push({
      scenarioFingerprint: value.scenarioFingerprint,
      simulationTimeMs,
      requestedAtSimMs,
      requestGeneration,
      policy,
      source: raw.source,
    });
  }
  return {
    ok: true,
    value: {
      version: JEV_TRACE_VERSION,
      controllerId: value.controllerId,
      client: value.client,
      scenarioFingerprint: value.scenarioFingerprint,
      events,
    },
  };
}

/**
 * The events a replay should apply for a scenario: sorted, and only those whose
 * fingerprint matches. A trace recorded for another scenario yields nothing —
 * the runtime then refuses to start rather than replaying the wrong run.
 */
export function replayableEvents(
  trace: JevTrace,
  scenarioFingerprint: string,
): JevTraceEvent[] {
  if (trace.scenarioFingerprint !== scenarioFingerprint) {
    return [];
  }
  return normalizeTrace(trace).events.filter(
    (event) => event.scenarioFingerprint === scenarioFingerprint,
  );
}
