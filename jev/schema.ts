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
  /**
   * Ceiling for one serialized request body (Issue #37). Measured, not guessed:
   * the generator caps corridors at 48, regions at 64 and hotspots at 24, and a
   * busy Metro rush hour serializes to 18.3 KB (mechanics: 48+41+24 entries with
   * real values, `scripts` measurement in the issue report). 64 KB leaves ~3.5x
   * headroom over the largest document production code can produce while staying
   * far below the previous 512 KB, which allowed ~28x more than any legitimate
   * request needed.
   */
  REQUEST_BODY_BYTES: 64 * 1024,
} as const;

/**
 * The closed sets the request schema accepts. Declared with `satisfies` so a
 * change to the simulation's own unions fails to compile here rather than
 * silently widening what a caller may send.
 */
export const JEV_CORRIDOR_KINDS = ["arterial", "highway", "diagonal"] as const satisfies readonly CorridorKind[];
export const JEV_SIGNAL_STAGES = ["green", "yellow", "all-red"] as const satisfies readonly JevSignalSummary["stage"][];

/**
 * Absurdity guards, not city limits (Issue #37). Every one of them sits orders of
 * magnitude above what the simulation produces for Metro Chicago (2 352
 * intersections, 5 131 roads, tens of thousands of vehicles), and their job is
 * only to stop a caller pushing 1e308 into the model's state or a five-digit
 * wait into a question string.
 */
export const JEV_REQUEST_BOUNDS = {
  /** Any id in the graph. */
  ID_MAX: 1_000_000,
  /** A count of intersections, vehicles or signals. */
  COUNT_MAX: 1_000_000,
  /** A wait, in ms: one simulated day. */
  WAIT_MS_MAX: 86_400_000,
  /** An arrival rate, per second. */
  RATE_MAX: 1_000_000,
  /** A ratio: a fraction of capacity, so it cannot exceed 1 by definition. */
  RATIO_MAX: 1,
  /** Observation time: the longest horizon the app can run. */
  TIME_MS_MAX: 86_400_000,
  /** Rolling window width: the measured window is seconds, never minutes. */
  WINDOW_MS_MAX: 60_000,
  /** Phase index / count of one signal. */
  PHASE_MAX: 64,
  /**
   * A hotspot's region, or -1 when the intersection belongs to no region. The
   * generator emits that sentinel (see `summarizeHotspots`), so it is part of
   * the contract rather than a special case invented here.
   */
  REGION_SENTINEL: -1,
} as const;

const CORRIDOR_FIELDS = [
  "corridorId",
  "kind",
  "intersections",
  "queuedVehicles",
  "maxWaitMs",
  "arrivalRatePerSecond",
  "occupancyRatio",
] as const;

const REGION_FIELDS = [
  "regionId",
  "intersections",
  "signalizedIntersections",
  "queuedVehicles",
  "maxWaitMs",
  "arrivalRatePerSecond",
  "occupancyRatio",
] as const;

const HOTSPOT_FIELDS = [
  "intersectionId",
  "regionId",
  "stage",
  "phaseIndex",
  "phaseCount",
  "stageElapsedMs",
  "queuedVehicles",
  "maxWaitMs",
  "arrivalRatePerSecond",
  "occupancyRatio",
  "downstreamOccupancyRatio",
] as const;

const CITY_FIELDS = [
  "intersections",
  "signalizedIntersections",
  "activeVehicles",
  "queuedVehicles",
  "maxWaitMs",
  "arrivalRatePerSecond",
] as const;

const REQUEST_FIELDS = ["schemaVersion", "timeMs", "windowMs", "city", "corridors", "regions", "hotspots"] as const;

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
 * Structural validation of a request (strict since Issue #37).
 *
 * The route accepts this document from the browser, and parts of it end up
 * interpolated into the questions the model is asked and forwarded verbatim as
 * the model's `state`. So validation is a WHITELIST REBUILD, not a check-then-
 * cast: the value returned is a fresh object assembled field by field, which
 * means an unrecognised key cannot survive into gateway state no matter what it
 * carries, and every string that does survive comes from a closed set rather
 * than from the caller's imagination.
 *
 * Rejected before anything is forwarded:
 *   - an unknown key at any level (including `model`, `endpoint`, `questions`,
 *     `prompt` — the route is not a generic proxy and must not be talked into
 *     looking like one)
 *   - an id that is not a non-negative integer inside the graph's bounds, or an
 *     id repeated within a list
 *   - a `kind` or `stage` outside its enum
 *   - any number that is non-finite, negative where it must not be, or above its
 *     absurdity guard
 *   - more entries than the list limits
 *
 * Nothing here is coerced: a hostile value is refused, never repaired.
 */
export function validateJevPolicyRequest(value: unknown): JevValidation<JevPolicyRequest> {
  if (!isPlainObject(value)) {
    return { ok: false, error: "request must be an object" };
  }
  const unknown = Object.keys(value).filter((key) => !(REQUEST_FIELDS as readonly string[]).includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: `request carries unknown field ${unknown[0]}` };
  }
  if (value.schemaVersion !== JEV_SCHEMA_VERSION) {
    return { ok: false, error: `unsupported schemaVersion (expected ${JEV_SCHEMA_VERSION})` };
  }

  const timeMs = boundedNumber(value.timeMs, 0, JEV_REQUEST_BOUNDS.TIME_MS_MAX);
  if (timeMs === null) {
    return { ok: false, error: "timeMs must be a finite number >= 0" };
  }
  const windowMs = boundedNumber(value.windowMs, 0, JEV_REQUEST_BOUNDS.WINDOW_MS_MAX);
  if (windowMs === null || windowMs === 0) {
    return { ok: false, error: "windowMs must be a finite number > 0" };
  }

  const city = readCity(value.city);
  if (city === null) {
    return { ok: false, error: "city must be an object with bounded non-negative numbers" };
  }

  const corridors = readCorridors(value.corridors);
  if (typeof corridors === "string") {
    return { ok: false, error: corridors };
  }
  const regions = readRegions(value.regions);
  if (typeof regions === "string") {
    return { ok: false, error: regions };
  }
  const hotspots = readHotspots(value.hotspots);
  if (typeof hotspots === "string") {
    return { ok: false, error: hotspots };
  }

  return { ok: true, value: { schemaVersion: JEV_SCHEMA_VERSION, timeMs, windowMs, city, corridors, regions, hotspots } };
}

/** True when the value is a member of a closed set; narrows the type. */
function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

/** A finite number inside [min, max] (inclusive), or null. */
function boundedNumber(value: unknown, min: number, max: number): number | null {
  const parsed = finiteNumber(value);
  if (parsed === null || parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

/**
 * A whole number inside [min, max], or null. The lower bound is a parameter
 * because one field is legitimately negative: a hotspot's region id, which the
 * generator sets to -1 when the intersection belongs to no region.
 */
function integerWithin(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return null;
  }
  return value;
}

/** A whole number inside the graph's id bounds, or null. */
function boundedId(value: unknown, min: number, max: number): number | null {
  return integerWithin(value, min, max);
}

function readCity(value: unknown): JevCitySummary | null {
  if (!isPlainObject(value)) {
    return null;
  }
  if (!exactKeys(value, CITY_FIELDS)) {
    return null;
  }
  const intersections = boundedNumber(value.intersections, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
  const signalizedIntersections = boundedNumber(value.signalizedIntersections, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
  const activeVehicles = boundedNumber(value.activeVehicles, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
  const queuedVehicles = boundedNumber(value.queuedVehicles, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
  const maxWaitMs = boundedNumber(value.maxWaitMs, 0, JEV_REQUEST_BOUNDS.WAIT_MS_MAX);
  const arrivalRatePerSecond = boundedNumber(value.arrivalRatePerSecond, 0, JEV_REQUEST_BOUNDS.RATE_MAX);
  if (
    intersections === null ||
    signalizedIntersections === null ||
    activeVehicles === null ||
    queuedVehicles === null ||
    maxWaitMs === null ||
    arrivalRatePerSecond === null ||
    signalizedIntersections > intersections
  ) {
    return null;
  }
  return { intersections, signalizedIntersections, activeVehicles, queuedVehicles, maxWaitMs, arrivalRatePerSecond };
}

/** Returns the list, or the error message as a string. */
function readCorridors(value: unknown): JevCorridorSummary[] | string {
  const list = readList(value, JEV_LIMITS.REQUEST_CORRIDORS, "corridors");
  if (typeof list === "string") {
    return list;
  }
  const seen = new Set<number>();
  const out: JevCorridorSummary[] = [];
  for (const entry of list) {
    if (!exactKeys(entry, CORRIDOR_FIELDS)) {
      return "corridors entries carry an unknown field";
    }
    const corridorId = boundedId(entry.corridorId, 0, JEV_REQUEST_BOUNDS.ID_MAX);
    if (corridorId === null) {
      return "corridors entries need a non-negative integer corridorId";
    }
    if (seen.has(corridorId)) {
      return `corridors repeats id ${corridorId}`;
    }
    seen.add(corridorId);
    if (!isOneOf(entry.kind, JEV_CORRIDOR_KINDS)) {
      return `corridors kind must be one of ${JEV_CORRIDOR_KINDS.join(", ")}`;
    }
    const kind = entry.kind;
    const intersections = boundedNumber(entry.intersections, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
    const queuedVehicles = boundedNumber(entry.queuedVehicles, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
    const maxWaitMs = boundedNumber(entry.maxWaitMs, 0, JEV_REQUEST_BOUNDS.WAIT_MS_MAX);
    const arrivalRatePerSecond = boundedNumber(entry.arrivalRatePerSecond, 0, JEV_REQUEST_BOUNDS.RATE_MAX);
    const occupancyRatio = boundedNumber(entry.occupancyRatio, 0, JEV_REQUEST_BOUNDS.RATIO_MAX);
    if (
      intersections === null ||
      queuedVehicles === null ||
      maxWaitMs === null ||
      arrivalRatePerSecond === null ||
      occupancyRatio === null
    ) {
      return "corridors entries must carry bounded non-negative numbers";
    }
    out.push({ corridorId, kind, intersections, queuedVehicles, maxWaitMs, arrivalRatePerSecond, occupancyRatio });
  }
  return out;
}

/** Returns the list, or the error message as a string. */
function readRegions(value: unknown): JevRegionSummary[] | string {
  const list = readList(value, JEV_LIMITS.REQUEST_REGIONS, "regions");
  if (typeof list === "string") {
    return list;
  }
  const seen = new Set<number>();
  const out: JevRegionSummary[] = [];
  for (const entry of list) {
    if (!exactKeys(entry, REGION_FIELDS)) {
      return "regions entries carry an unknown field";
    }
    const regionId = boundedId(entry.regionId, 0, JEV_REQUEST_BOUNDS.ID_MAX);
    if (regionId === null) {
      return "regions entries need a non-negative integer regionId";
    }
    if (seen.has(regionId)) {
      return `regions repeats id ${regionId}`;
    }
    seen.add(regionId);
    const intersections = boundedNumber(entry.intersections, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
    const signalizedIntersections = boundedNumber(entry.signalizedIntersections, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
    const queuedVehicles = boundedNumber(entry.queuedVehicles, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
    const maxWaitMs = boundedNumber(entry.maxWaitMs, 0, JEV_REQUEST_BOUNDS.WAIT_MS_MAX);
    const arrivalRatePerSecond = boundedNumber(entry.arrivalRatePerSecond, 0, JEV_REQUEST_BOUNDS.RATE_MAX);
    const occupancyRatio = boundedNumber(entry.occupancyRatio, 0, JEV_REQUEST_BOUNDS.RATIO_MAX);
    if (
      intersections === null ||
      signalizedIntersections === null ||
      queuedVehicles === null ||
      maxWaitMs === null ||
      arrivalRatePerSecond === null ||
      occupancyRatio === null ||
      signalizedIntersections > intersections
    ) {
      return "regions entries must carry bounded non-negative numbers";
    }
    out.push({
      regionId,
      intersections,
      signalizedIntersections,
      queuedVehicles,
      maxWaitMs,
      arrivalRatePerSecond,
      occupancyRatio,
    });
  }
  return out;
}

/**
 * Returns the list, or the error message as a string.
 *
 * A hotspot's `regionId` may be the generator's -1 sentinel, and is otherwise an
 * id. Membership in the region list is deliberately NOT required: the busiest
 * signals are chosen across the whole city, so a legitimate hotspot can belong
 * to a region that did not make the top-64 cut.
 */
function readHotspots(value: unknown): JevSignalSummary[] | string {
  const list = readList(value, JEV_LIMITS.REQUEST_HOTSPOTS, "hotspots");
  if (typeof list === "string") {
    return list;
  }
  const seen = new Set<number>();
  const out: JevSignalSummary[] = [];
  for (const entry of list) {
    if (!exactKeys(entry, HOTSPOT_FIELDS)) {
      return "hotspots entries carry an unknown field";
    }
    const intersectionId = boundedId(entry.intersectionId, 0, JEV_REQUEST_BOUNDS.ID_MAX);
    if (intersectionId === null) {
      return "hotspots entries need a non-negative integer intersectionId";
    }
    if (seen.has(intersectionId)) {
      return `hotspots repeats id ${intersectionId}`;
    }
    seen.add(intersectionId);
    const regionId = integerWithin(
      entry.regionId,
      JEV_REQUEST_BOUNDS.REGION_SENTINEL,
      JEV_REQUEST_BOUNDS.ID_MAX,
    );
    if (regionId === null) {
      return "hotspots regionId must be an id or -1";
    }
    if (!isOneOf(entry.stage, JEV_SIGNAL_STAGES)) {
      return `hotspots stage must be one of ${JEV_SIGNAL_STAGES.join(", ")}`;
    }
    const stage = entry.stage;
    const phaseIndex = boundedId(entry.phaseIndex, 0, JEV_REQUEST_BOUNDS.PHASE_MAX);
    const phaseCount = boundedId(entry.phaseCount, 0, JEV_REQUEST_BOUNDS.PHASE_MAX);
    const stageElapsedMs = boundedNumber(entry.stageElapsedMs, 0, JEV_REQUEST_BOUNDS.WAIT_MS_MAX);
    const queuedVehicles = boundedNumber(entry.queuedVehicles, 0, JEV_REQUEST_BOUNDS.COUNT_MAX);
    const maxWaitMs = boundedNumber(entry.maxWaitMs, 0, JEV_REQUEST_BOUNDS.WAIT_MS_MAX);
    const arrivalRatePerSecond = boundedNumber(entry.arrivalRatePerSecond, 0, JEV_REQUEST_BOUNDS.RATE_MAX);
    const occupancyRatio = boundedNumber(entry.occupancyRatio, 0, JEV_REQUEST_BOUNDS.RATIO_MAX);
    const downstreamOccupancyRatio = boundedNumber(entry.downstreamOccupancyRatio, 0, JEV_REQUEST_BOUNDS.RATIO_MAX);
    if (
      phaseIndex === null ||
      phaseCount === null ||
      stageElapsedMs === null ||
      queuedVehicles === null ||
      maxWaitMs === null ||
      arrivalRatePerSecond === null ||
      occupancyRatio === null ||
      downstreamOccupancyRatio === null
    ) {
      return "hotspots entries must carry bounded non-negative numbers";
    }
    out.push({
      intersectionId,
      regionId,
      stage,
      phaseIndex,
      phaseCount,
      stageElapsedMs,
      queuedVehicles,
      maxWaitMs,
      arrivalRatePerSecond,
      occupancyRatio,
      downstreamOccupancyRatio,
    });
  }
  return out;
}

function readList(value: unknown, max: number, field: string): Record<string, unknown>[] | string {
  if (!Array.isArray(value)) {
    return `${field} must be an array`;
  }
  if (value.length > max) {
    return `${field} exceeds the ${max}-entry limit`;
  }
  for (const entry of value) {
    if (!isPlainObject(entry)) {
      return `${field} entries must be objects`;
    }
  }
  return value as Record<string, unknown>[];
}

/** Every key must be one of the allowed ones: no unrecognised key survives. */
function exactKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}

/**
 * The ids a policy is allowed to reference, taken from the request it answers.
 *
 * Optional on purpose: a policy that arrives WITH a request (the live path) is
 * checked against the ids that request carried, while a policy that has no
 * originating request — a recorded trace being loaded, or a replay — has no id
 * set to check against. Omitting the context still enforces every OTHER part of
 * the live contract: schema version, hints, finiteness, bounds, entry counts and
 * duplicate ids. Unknown ids are inert where they are used: a weight for a
 * corridor this city does not have simply never matches a phase.
 */
export interface JevPolicyContext {
  /** Corridor ids the request carried. */
  readonly corridorIds?: readonly number[];
  /** Region ids the request carried. */
  readonly regionIds?: readonly number[];
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
  context: JevPolicyContext = {},
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
    const knownIds = known === undefined ? null : new Set(known);
    const seen = new Set<number>();
    for (const entry of list) {
      if (!isPlainObject(entry)) {
        return { ok: false, error: `${field} entries must be objects` };
      }
      const id = nonNegativeInteger(entry.id);
      if (id === null) {
        return { ok: false, error: `${field} entries need a non-negative integer id` };
      }
      if (knownIds !== null && !knownIds.has(id)) {
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
