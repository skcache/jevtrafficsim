/**
 * UI model (Task 11 visual correction): pure option lists and seed handling
 * for the onboarding/config surfaces. Testable without a DOM.
 */
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { ControllerChoice } from "@/worker/protocol";
import { CURATED_TRIPS } from "@/cities/chicago-trips";
import type { PresentationTripProgress } from "@/worker/presentation-snapshot";

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

export const CONTROLLER_OPTIONS: readonly { value: ControllerChoice; label: string }[] = [
  { value: "fixed", label: "Fixed" },
  { value: "adaptive", label: "Adaptive" },
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
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres <= 0) {
    return "0 m";
  }
  if (metres < 1_000) {
    return `${Math.round(metres)} m`;
  }
  return `${(metres / 1_000).toFixed(1)} km`;
}

/** m/s -> km/h, the unit a person reads speed in. */
export function formatSpeed(metresPerSecond: number): string {
  if (!Number.isFinite(metresPerSecond) || metresPerSecond <= 0) {
    return "0 km/h";
  }
  return `${Math.round(metresPerSecond * 3.6)} km/h`;
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
        value: trip.estimatedRemainingMs === null ? "—" : formatDuration(trip.estimatedRemainingMs),
      },
    ],
  };
}
