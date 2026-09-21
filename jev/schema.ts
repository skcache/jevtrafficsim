/**
 * Jev adapter schemas (Issue #13).
 *
 * Exactly two documents cross the Jev boundary, and this file defines both:
 *
 *   JevPolicyRequest — what Jev sees. Citywide traffic state only: totals,
 *     corridor summaries, region summaries and the busiest signals. It has no
 *     vehicle-level field at all, so the ego vehicle cannot be named, located
 *     or privileged through it (see `buildJevPolicyRequest` and the
 *     no-ego-privilege test).
 *
 *   JevPolicy — what Jev may say. Small and bounded on purpose:
 *
 *     pressureScale   one global multiplier,            [0.5, 1.5]
 *     hint            a coarse switching hint,          "neutral" | "hold-longer" | "switch-sooner"
 *     corridorWeights per-corridor priority weights,    [0.5, 2] each
 *     regionWeights   per-region priority weights,      [0.5, 2] each
 *
 * A policy is an OPINION ABOUT PRESSURE, never a lamp state. Jev cannot ask for
 * a phase, a green time, a yellow or a ring position; the local mechanics
 * (sim/signals.ts) still own min green, max green, yellow, all-red, phase order
 * and every safety constraint, and they enforce them whatever a controller
 * asks for.
 *
 * ## Malformed output: what is rejected and what is clamped
 *
 * REJECTED (the whole response is discarded; the controller keeps the policy it
 * already had — it never invents one):
 *   - not a plain object, or an unsupported `schemaVersion`
 *   - a known field with the wrong type, a non-finite number, or a NaN
 *   - an unknown `hint`
 *   - more entries than `POLICY_ENTRIES`, or duplicate ids
 *   - an id that was not in the request it answers
 *
 * CLAMPED (accepted, bounded, and reported back in `clamped`):
 *   - `pressureScale` outside its bounds -> nearest bound
 *   - any weight outside its bounds -> nearest bound
 *
 * Unknown *fields* are ignored, so a newer service can add fields without
 * breaking this adapter.
 */
import type { CorridorKind } from "@/sim/types";

export const JEV_SCHEMA_VERSION = 1;

export const JEV_LIMITS = {
  /** Max corridors in one request (busiest first). */
  REQUEST_CORRIDORS: 48,
  /** Max regions in one request. */
  REQUEST_REGIONS: 64,
  /** Max hotspot signals in one request (busiest first). */
  REQUEST_HOTSPOTS: 24,
  /** Max entries in one policy weight list. */
  POLICY_ENTRIES: 64,
  /** Bounds of the global pressure multiplier. */
  PRESSURE_SCALE_MIN: 0.5,
  PRESSURE_SCALE_MAX: 1.5,
  /** Bounds of one corridor / region weight. */
  WEIGHT_MIN: 0.5,
  WEIGHT_MAX: 2,
  /** Bounds of the combined weight applied to one phase. */
  COMBINED_WEIGHT_MIN: 0.25,
  COMBINED_WEIGHT_MAX: 2,
} as const;

/**
 * Coarse switching hints and their bounded effect on the switch margin.
 * `hold-longer` makes the controller keep serving a phase that is already
 * winning; `switch-sooner` makes it relinquish sooner. Neither can touch the
 * starvation rule or any legal minimum — mechanics own those.
 */
export const JEV_HINT_MARGIN_SCALE = {
  neutral: 1,
  "hold-longer": 2,
  "switch-sooner": 0.5,
} as const;

export type JevHint = keyof typeof JEV_HINT_MARGIN_SCALE;

export const JEV_HINTS = Object.keys(JEV_HINT_MARGIN_SCALE) as readonly JevHint[];

export interface JevCitySummary {
  readonly intersections: number;
  readonly signalizedIntersections: number;
  readonly activeVehicles: number;
  readonly queuedVehicles: number;
  readonly maxWaitMs: number;
  readonly arrivalRatePerSecond: number;
}

export interface JevCorridorSummary {
  readonly corridorId: number;
  readonly kind: CorridorKind;
  readonly intersections: number;
  readonly queuedVehicles: number;
  readonly maxWaitMs: number;
  readonly arrivalRatePerSecond: number;
  readonly occupancyRatio: number;
}

export interface JevRegionSummary {
  readonly regionId: number;
  readonly intersections: number;
  readonly signalizedIntersections: number;
  readonly queuedVehicles: number;
  readonly maxWaitMs: number;
  readonly arrivalRatePerSecond: number;
  readonly occupancyRatio: number;
}

export interface JevSignalSummary {
  readonly intersectionId: number;
  readonly regionId: number;
  readonly stage: "green" | "yellow" | "all-red";
  readonly phaseIndex: number;
  readonly phaseCount: number;
  readonly stageElapsedMs: number;
  readonly queuedVehicles: number;
  readonly maxWaitMs: number;
  readonly arrivalRatePerSecond: number;
  readonly occupancyRatio: number;
  readonly downstreamOccupancyRatio: number;
}

/** The complete, bounded citywide view Jev is given. No vehicle-level fields. */
export interface JevPolicyRequest {
  readonly schemaVersion: typeof JEV_SCHEMA_VERSION;
  /** Simulated time of this observation, ms. */
  readonly timeMs: number;
  /** Width of the rolling window the rates were measured over, ms. */
  readonly windowMs: number;
  readonly city: JevCitySummary;
  readonly corridors: readonly JevCorridorSummary[];
  readonly regions: readonly JevRegionSummary[];
  readonly hotspots: readonly JevSignalSummary[];
}

export interface JevWeightEntry {
  readonly id: number;
  readonly weight: number;
}

export interface JevPolicy {
  readonly schemaVersion: typeof JEV_SCHEMA_VERSION;
  readonly pressureScale: number;
  readonly hint: JevHint;
  readonly corridorWeights: readonly JevWeightEntry[];
  readonly regionWeights: readonly JevWeightEntry[];
}

/** The neutral policy: every weight 1, no hint. Used before a policy arrives. */
export function neutralJevPolicy(): JevPolicy {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    pressureScale: 1,
    hint: "neutral",
    corridorWeights: [],
    regionWeights: [],
  };
}

export type JevValidation<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * Structural validation of a request. The adapter builds requests itself, but
 * the server route accepts one from the browser, so it validates every field it
 * is handed before forwarding anything.
 */
export function validateJevPolicyRequest(value: unknown): JevValidation<JevPolicyRequest> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "request must be an object" };
  }
  if (value.schemaVersion !== JEV_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schemaVersion (expected ${JEV_SCHEMA_VERSION})` };
  }
  const timeMs = finiteNumber(value.timeMs);
  const windowMs = finiteNumber(value.windowMs);
  if (timeMs === null || timeMs < 0) {
    return { ok: false, error: "timeMs must be a finite number >= 0" };
  }
  if (windowMs === null || windowMs <= 0) {
    return { ok: false, error: "windowMs must be a finite number > 0" };
  }
  const city = value.city;
  if (!isPlainObject(city)) {
    return { ok: false, error: "city must be an object" };
  }
  for (const field of [
    "intersections",
    "signalizedIntersections",
    "activeVehicles",
    "queuedVehicles",
    "maxWaitMs",
    "arrivalRatePerSecond",
  ] as const) {
    if (finiteNumber(city[field]) === null || (city[field] as number) < 0) {
      return { ok: false, error: `city.${field} must be a finite number >= 0` };
    }
  }
  const lists = [
    ["corridors", JEV_LIMITS.REQUEST_CORRIDORS],
    ["regions", JEV_LIMITS.REQUEST_REGIONS],
    ["hotspots", JEV_LIMITS.REQUEST_HOTSPOTS],
  ] as const;
  for (const [field, max] of lists) {
    const list = value[field];
    if (!Array.isArray(list)) {
      return { ok: false, error: `${field} must be an array` };
    }
    if (list.length > max) {
      return { ok: false, error: `${field} exceeds the ${max}-entry limit` };
    }
    for (const entry of list) {
      if (!isPlainObject(entry)) {
        return { ok: false, error: `${field} entries must be objects` };
      }
      const id = nonNegativeInteger(entry[field === "corridors" ? "corridorId" : field === "regions" ? "regionId" : "intersectionId"]);
      if (id === null) {
        return { ok: false, error: `${field} entries need a non-negative integer id` };
      }
      for (const numeric of Object.values(entry)) {
        if (typeof numeric === "number" && !Number.isFinite(numeric)) {
          return { ok: false, error: `${field} entries must not carry non-finite numbers` };
        }
      }
    }
  }
  return { ok: true, value: value as unknown as JevPolicyRequest };
}

export interface JevPolicyContext {
  /** Corridor ids the request carried. */
  readonly corridorIds: readonly number[];
  /** Region ids the request carried. */
  readonly regionIds: readonly number[];
}

export interface ParsedJevPolicy {
  readonly policy: JevPolicy;
  /** Human-readable notes for every value that was clamped, in order. */
  readonly clamped: readonly string[];
}

/**
 * Parse and bound a raw service response. See the file header for the exact
 * reject/clamp split: structure and identity are strict, magnitudes are clamped.
 */
export function parseJevPolicy(
  value: unknown,
  context: JevPolicyContext,
): JevValidation<ParsedJevPolicy> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "policy must be an object" };
  }
  if (value.schemaVersion !== JEV_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schemaVersion (expected ${JEV_SCHEMA_VERSION})` };
  }

  const clamped: string[] = [];

  let pressureScale = 1;
  if (value.pressureScale !== undefined) {
    const raw = finiteNumber(value.pressureScale);
    if (raw === null) {
      return { ok: false, error: "pressureScale must be a finite number" };
    }
    pressureScale = clampWeight(raw, JEV_LIMITS.PRESSURE_SCALE_MIN, JEV_LIMITS.PRESSURE_SCALE_MAX);
    if (pressureScale !== raw) {
      clamped.push(`pressureScale ${raw} -> ${pressureScale}`);
    }
  }

  let hint: JevHint = "neutral";
  if (value.hint !== undefined) {
    if (typeof value.hint !== "string" || !(value.hint in JEV_HINT_MARGIN_SCALE)) {
      return { ok: false, error: `unknown hint (expected one of ${JEV_HINTS.join(", ")})` };
    }
    hint = value.hint as JevHint;
  }

  const weights: { corridorWeights: JevWeightEntry[]; regionWeights: JevWeightEntry[] } = {
    corridorWeights: [],
    regionWeights: [],
  };
  for (const [field, known] of [
    ["corridorWeights", context.corridorIds],
    ["regionWeights", context.regionIds],
  ] as const) {
    const list = value[field];
    if (list === undefined) {
      continue;
    }
    if (!Array.isArray(list)) {
      return { ok: false, error: `${field} must be an array` };
    }
    if (list.length > JEV_LIMITS.POLICY_ENTRIES) {
      return { ok: false, error: `${field} exceeds the ${JEV_LIMITS.POLICY_ENTRIES}-entry limit` };
    }
    const knownIds = new Set(known);
    const seen = new Set<number>();
    for (const entry of list) {
      if (!isPlainObject(entry)) {
        return { ok: false, error: `${field} entries must be objects` };
      }
      const id = nonNegativeInteger(entry.id);
      if (id === null) {
        return { ok: false, error: `${field} entries need a non-negative integer id` };
      }
      if (!knownIds.has(id)) {
        return { ok: false, error: `${field} references id ${id}, which was not in the request` };
      }
      if (seen.has(id)) {
        return { ok: false, error: `${field} repeats id ${id}` };
      }
      seen.add(id);
      const raw = finiteNumber(entry.weight);
      if (raw === null) {
        return { ok: false, error: `${field} weight for id ${id} must be a finite number` };
      }
      const bounded = clampWeight(raw, JEV_LIMITS.WEIGHT_MIN, JEV_LIMITS.WEIGHT_MAX);
      if (bounded !== raw) {
        clamped.push(`${field}[${id}] ${raw} -> ${bounded}`);
      }
      weights[field].push({ id, weight: bounded });
    }
  }

  return {
    ok: true,
    value: {
      policy: {
        schemaVersion: JEV_SCHEMA_VERSION,
        pressureScale,
        hint,
        corridorWeights: weights.corridorWeights,
        regionWeights: weights.regionWeights,
      },
      clamped,
    },
  };
}

/** Clamp to a closed interval; non-finite input is not expected here. */
export function clampWeight(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
