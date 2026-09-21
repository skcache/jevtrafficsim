/**
 * UI model (Task 11 visual correction): pure option lists and seed handling
 * for the onboarding/config surfaces. Testable without a DOM.
 */
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { ControllerChoice } from "@/worker/protocol";
import { DRIVER_DESCRIPTIONS, type DriverStrategy } from "@/sim/driver";
import { CURATED_TRIPS } from "@/cities/chicago-trips";
import {
  fallbackShare,
  type PresentationPolicy,
  type PresentationTripProgress,
} from "@/worker/presentation-snapshot";
import type { ChallengeResult } from "@/worker/challenge-result";

export interface ScaleOption {
  readonly value: CitySize;
  readonly label: string;
  readonly description: string;
}

/** Five nested scales of ONE showcase city, in onboarding order. */
export const CITY_SIZE_OPTIONS: readonly ScaleOption[] = [
  { value: "small", label: "Tiny", description: "Loop core" },
  { value: "small-medium", label: "Small", description: "Loop + river edge" },
  { value: "medium", label: "Medium", description: "Downtown + Grant Park" },
  { value: "medium-large", label: "Large", description: "Expressways + West Loop" },
  { value: "large", label: "Metro", description: "Central Chicago" },
];

export const TRAFFIC_OPTIONS: readonly { value: TrafficLevel; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "everyday", label: "Everyday" },
  { value: "rush-hour", label: "Rush Hour" },
];

/**
 * Controller choices — a DEVELOPER control (Issue #15).
 *
 * The product's setup does not ask which controller to run: the visible run is
 * Jev and the Fixed/Adaptive baselines are computed beside it for the same
 * scenario. Choosing a controller by hand is only useful when working on the
 * simulation, so this list lives behind `?debug`.
 */
export const CONTROLLER_OPTIONS: readonly { value: ControllerChoice; label: string }[] = [
  { value: "fixed", label: "Fixed" },
  { value: "adaptive", label: "Adaptive" },
  { value: "jev", label: "Jev" },
];

/**
 * Developer controls are opt-in: `?debug` in the URL (or `?debug=1`). Parsed
 * rather than searched so `?nodebug` cannot switch anything on.
 */
export function debugMode(search: string): boolean {
  const query = search.startsWith("?") ? search.slice(1) : search;
  for (const part of query.split("&")) {
    const [key, value] = part.split("=");
    if (key === "debug" && value !== "0" && value !== "false") {
      return true;
    }
  }
  return false;
}

/** Driver choices for the setup control (issue #28). */
export const DRIVER_OPTIONS: readonly { value: DriverStrategy; label: string }[] = [
  { value: "tourist", label: "Tourist" },
  { value: "local", label: "Local" },
];

export function citySizeLabel(value: CitySize): string {
  return CITY_SIZE_OPTIONS.find((option) => option.value === value)?.label ?? "Medium";
}

export function citySizeDescription(value: CitySize): string {
  return CITY_SIZE_OPTIONS.find((option) => option.value === value)?.description ?? "";
}

export function trafficLabel(value: TrafficLevel): string {
  return TRAFFIC_OPTIONS.find((option) => option.value === value)?.label ?? "Everyday";
}

export function scaleIndexForSize(value: CitySize): number {
  const index = CITY_SIZE_OPTIONS.findIndex((option) => option.value === value);
  return index === -1 ? 2 : index;
}

export function sizeForScaleIndex(index: number): CitySize {
  const clamped = Math.min(Math.max(Math.floor(index), 0), CITY_SIZE_OPTIONS.length - 1);
  return CITY_SIZE_OPTIONS[clamped].value;
}

/** Accepts messy input; always returns a valid uint32 seed. */
export function normalizeSeed(raw: string, fallback: number): number {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return fallback;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed >>> 0;
}

/** Deterministic helper for the dice: any [0,1) source becomes a uint32. */
export function seedFromRandom(random: () => number): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    return 0;
  }
  return Math.floor(value * 0x100000000) >>> 0;
}

/**
 * UI randomness is allowed here (never in simulation logic): the resulting
 * explicit seed is shown and fully reproducible.
 */
export function diceSeed(): number {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] >>> 0;
  }
  return seedFromRandom(() => Date.now() % 1000 / 1000);
}

/** Formats metric durations for the HUD: 27.4s / 1m 08s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) {
    return "—";
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms - minutes * 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

export function formatThroughput(perMinute: number): string {
  if (!Number.isFinite(perMinute) || perMinute < 0) {
    return "—";
  }
  return `${Math.round(perMinute)}/min`;
}

export function formatPercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio < 0) {
    return "—";
  }
  return `${Math.round(ratio * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* Trip HUD (Issue #25)                                                */
/* ------------------------------------------------------------------ */

/** "740 m" up to a kilometre, then "7.4 km". */
/**
 * US customary units: this is Chicago. Distances read in feet up to a quarter
 * mile, then in miles; the simulation stays in metres internally, so this is
 * presentation only.
 */
const METRES_PER_FOOT = 0.3048;
const METRES_PER_MILE = 1609.344;
/** Below this, feet are the honest unit (a quarter mile). */
const FEET_LIMIT_M = METRES_PER_MILE / 4;

export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres <= 0) {
    return "0 ft";
  }
  if (metres < FEET_LIMIT_M) {
    return `${Math.round(metres / METRES_PER_FOOT)} ft`;
  }
  return `${(metres / METRES_PER_MILE).toFixed(1)} mi`;
}

/** m/s -> mph, the unit a person reads speed in. */
export function formatSpeed(metresPerSecond: number): string {
  if (!Number.isFinite(metresPerSecond) || metresPerSecond <= 0) {
    return "0 mph";
  }
  return `${Math.round((metresPerSecond / METRES_PER_MILE) * 3600)} mph`;
}

export type TripStateLabel = "Moving" | "Stopped" | "Arrived" | "Waiting";

/**
 * One place maps simulation state to the word the HUD shows, so the header
 * chip can never disagree with the numbers underneath it.
 */
export function tripStateLabel(egoState: string | null, completed: boolean): TripStateLabel {
  if (completed) {
    return "Arrived";
  }
  if (egoState === "queued") {
    return "Stopped";
  }
  if (egoState === "pending") {
    return "Waiting";
  }
  return "Moving";
}

export interface TripHudRow {
  readonly label: string;
  readonly value: string;
}

export interface TripHudView {
  readonly tripId: string;
  readonly tripName: string;
  readonly state: TripStateLabel;
  readonly completed: boolean;
  readonly rows: readonly TripHudRow[];
}

export interface TripHudInput {
  readonly trip: PresentationTripProgress | null;
  readonly egoState: string | null;
  readonly egoSpeedMps: number;
}

/**
 * The trip HUD is a pure read of the presentation frame: every value below is
 * a field the worker computed, formatted — no derived guesswork that could
 * drift from the map.
 */
export function tripHudView(input: TripHudInput): TripHudView | null {
  const { trip } = input;
  if (!trip) {
    return null;
  }
  const name = CURATED_TRIPS.find((candidate) => candidate.id === trip.tripId)?.label ?? trip.tripId;
  const cleared = `${trip.intersectionsCleared} / ${trip.routeRoadIds.length}`;
  return {
    tripId: trip.tripId,
    tripName: name,
    state: tripStateLabel(input.egoState, trip.completed),
    completed: trip.completed,
    rows: [
      { label: "Elapsed", value: formatDuration(trip.tripTimeMs) },
      { label: "Remaining", value: formatDistance(trip.distanceRemainingM) },
      { label: "Speed", value: formatSpeed(input.egoSpeedMps) },
      { label: "Stopped", value: formatDuration(trip.waitTimeMs) },
      { label: "Cleared", value: cleared },
      {
        label: "Est. remaining",
        value:
          trip.completed || trip.estimatedRemainingMs === null
            ? "—"
            : formatDuration(trip.estimatedRemainingMs),
      },
    ],
  };
}

/* ------------------------------------------------------------------ */
/* Comparison (Issue #28)                                              */
/* ------------------------------------------------------------------ */

/**
 * One comparison row, three columns: the two deterministic baselines and the
 * run the user actually watched. Every cell is a field of a real run, formatted
 * — the panel never computes an outcome the runs did not produce.
 */
export interface ComparisonRow {
  readonly label: string;
  readonly fixed: string;
  readonly adaptive: string;
  readonly jev: string;
}

/** Column order of the comparison, and the word used for the visible run. */
export const COMPARISON_COLUMNS = ["Fixed", "Adaptive", "Jev"] as const;

/**
 * The compact comparison table: your trip first, then Chicago. Every value is
 * a field of the two results, formatted — the panel never computes anything the
 * runs did not produce.
 */
/** A run that never arrived did not have a trip time. */
function tripTime(result: ChallengeResult): string {
  return result.trip.completed ? formatDuration(result.trip.tripTimeMs) : "—";
}

export function comparisonRows(
  fixed: ChallengeResult,
  adaptive: ChallengeResult,
  jev: ChallengeResult,
): readonly ComparisonRow[] {
  const arrived = (result: ChallengeResult) => (result.trip.completed ? "Yes" : "No");
  return [
    { label: "Arrived", fixed: arrived(fixed), adaptive: arrived(adaptive), jev: arrived(jev) },
    { label: "Trip time", fixed: tripTime(fixed), adaptive: tripTime(adaptive), jev: tripTime(jev) },
    {
      label: "Stopped",
      fixed: formatDuration(fixed.trip.stoppedMs),
      adaptive: formatDuration(adaptive.trip.stoppedMs),
      jev: formatDuration(jev.trip.stoppedMs),
    },
    {
      label: "Distance",
      fixed: formatDistance(fixed.trip.distanceM),
      adaptive: formatDistance(adaptive.trip.distanceM),
      jev: formatDistance(jev.trip.distanceM),
    },
    {
      label: "Avg speed",
      fixed: formatSpeed(fixed.trip.averageSpeedMps),
      adaptive: formatSpeed(adaptive.trip.averageSpeedMps),
      jev: formatSpeed(jev.trip.averageSpeedMps),
    },
    {
      label: "Reroutes",
      fixed: String(fixed.trip.rerouteCount),
      adaptive: String(adaptive.trip.rerouteCount),
      jev: String(jev.trip.rerouteCount),
    },
    {
      label: "Avg wait",
      fixed: formatDuration(fixed.city.averageWaitMs),
      adaptive: formatDuration(adaptive.city.averageWaitMs),
      jev: formatDuration(jev.city.averageWaitMs),
    },
    {
      label: "P95 wait",
      fixed: formatDuration(fixed.city.p95WaitMs),
      adaptive: formatDuration(adaptive.city.p95WaitMs),
      jev: formatDuration(jev.city.p95WaitMs),
    },
    {
      label: "Trips done",
      fixed: fixed.city.completedTrips.toLocaleString("en-US"),
      adaptive: adaptive.city.completedTrips.toLocaleString("en-US"),
      jev: jev.city.completedTrips.toLocaleString("en-US"),
    },
    {
      label: "Throughput",
      fixed: formatThroughput(fixed.city.throughputPerMinute),
      adaptive: formatThroughput(adaptive.city.throughputPerMinute),
      jev: formatThroughput(jev.city.throughputPerMinute),
    },
    {
      label: "Gridlock",
      fixed: formatPercent(fixed.city.gridlockRatio),
      adaptive: formatPercent(adaptive.city.gridlockRatio),
      jev: formatPercent(jev.city.gridlockRatio),
    },
    {
      label: "Active cars",
      fixed: fixed.city.activeVehicles.toLocaleString("en-US"),
      adaptive: adaptive.city.activeVehicles.toLocaleString("en-US"),
      jev: jev.city.activeVehicles.toLocaleString("en-US"),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Provenance (Issue #15)                                              */
/* ------------------------------------------------------------------ */

/**
 * Past this share of the run, the adaptive fallback is not a rounding error and
 * the result MUST stop calling itself pure live Jev. One named constant, so the
 * threshold cannot drift between the chrome and the comparison.
 */
export const JEV_FALLBACK_NOTICE_SHARE = 0.05;

export interface PolicyLabel {
  /** The state word: "Jev", "Jev · fallback used", "Adaptive fallback", "Replay". */
  readonly text: string;
  /** One compact line of public truth, or null when there is nothing to add. */
  readonly detail: string | null;
}

/**
 * Who governed the signals, in the fewest words that stay true.
 *
 *   Jev                 the model's policy told the city what to do, start to end
 *   Jev · fallback used part of the run was the adaptive safety net
 *   Adaptive fallback   no live policy ever arrived: this was not a Jev run
 *   Replay              a recorded policy run, applied offline
 *
 * Controllers with no external policy (Fixed, Adaptive) label themselves.
 */
export function policyLabel(
  controller: string,
  policy: PresentationPolicy | null,
): PolicyLabel | null {
  if (controller === "fixed") {
    return { text: "Fixed", detail: null };
  }
  if (controller === "adaptive") {
    return { text: "Adaptive", detail: null };
  }
  if (controller !== "jev") {
    return null;
  }
  if (policy === null) {
    return { text: "Jev", detail: null };
  }
  const policies = `${policy.accepted} live ${policy.accepted === 1 ? "policy" : "policies"}`;
  if (policy.source === "replay") {
    return { text: "Replay", detail: `${policy.replayMs > 0 ? formatDuration(policy.replayMs) : "recorded"} replayed` };
  }
  if (policy.accepted === 0) {
    return { text: "Adaptive fallback", detail: "no live policy arrived" };
  }
  const share = fallbackShare(policy);
  if (share > JEV_FALLBACK_NOTICE_SHARE) {
    return {
      text: "Jev · fallback used",
      detail: `${Math.round(share * 100)}% of the run on the adaptive fallback · ${policies}`,
    };
  }
  return { text: "Jev", detail: policies };
}

/** Short label for chrome ("Tourist", "Local"). */
export function driverLabel(driver: DriverStrategy): string {
  return DRIVER_OPTIONS.find((option) => option.value === driver)?.label ?? "Tourist";
}

export function driverDescription(driver: DriverStrategy): string {
  return DRIVER_DESCRIPTIONS[driver];
}
