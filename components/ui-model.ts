/**
 * UI model (Task 11 visual correction): pure option lists and seed handling
 * for the onboarding/config surfaces. Testable without a DOM.
 */
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { ControllerChoice } from "@/worker/protocol";

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
