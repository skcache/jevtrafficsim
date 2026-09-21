/**
 * Worker protocol (Task 11): explicit discriminated unions for the
 * main-thread <-> worker boundary, plus runtime validation so the worker
 * never trusts arbitrary postMessage payloads. Pure module: no DOM calls, no
 * React, no simulation execution — the worker owns all of that.
 */
import type { IncidentKind } from "@/sim/incidents";
import { TRAFFIC_LEVELS } from "@/sim/types";
import { DRIVER_CHOICES, type DriverStrategy } from "@/sim/driver";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type {
  PresentationMetrics,
  PresentationSnapshot,
} from "./presentation-snapshot";
import type {
  ChallengeIncidentPlan,
  ResolvedChallengeIncident,
} from "./challenge-incidents";
import type { ChallengeResult, ComparisonVerdict } from "./challenge-result";

/** Fixed simulation pacing: one 100 ms tick per scheduled worker iteration. */
export const SIM_TICK_MS = 100;

/**
 * Playback compression. The simulation itself is untouched — the engine still
 * advances in its own 100 ms timestep, so speeds, queues and signal timings keep
 * their real proportions — but each real tick runs this many engine steps, so a
 * typical curated trip lands in the 30–60 s the challenge is meant to be
 * watched in.
 */
export const PLAYBACK_STEPS_PER_TICK = 8;
/** Render snapshots at 5 Hz (every 2 ticks); metrics at 2 Hz (every 5). */
export const SNAPSHOT_EVERY_TICKS = 2;
export const METRICS_EVERY_TICKS = 5;
/** One centralized live-run horizon: 10 simulated minutes. */
export const LIVE_RUN_HORIZON_MS = 600_000;

export const CONTROLLER_CHOICES = ["fixed", "adaptive"] as const;
export type ControllerChoice = (typeof CONTROLLER_CHOICES)[number];

export const CITY_SIZE_CHOICES = [
  "small",
  "small-medium",
  "medium",
  "medium-large",
  "large",
] as const satisfies readonly CitySize[];

export const TRAFFIC_LEVEL_CHOICES = [
  "light",
  "everyday",
  "rush-hour",
] as const satisfies readonly TrafficLevel[];

export const INCIDENT_CHOICES = [
  "traffic-burst",
  "crash",
  "close-road",
  "bridge-closed",
  "event-release",
] as const satisfies readonly IncidentKind[];

/* ------------------------------ main -> worker ------------------------------ */

export type WorkerCommand =
  | {
      readonly type: "INIT";
      readonly citySize: CitySize;
      readonly trafficLevel: TrafficLevel;
      readonly tripId: CuratedTripId;
      readonly controller: ControllerChoice;
      readonly driver: DriverStrategy;
      readonly seed: number;
      readonly durationMs?: number;
    }
  | { readonly type: "START" }
  | { readonly type: "PAUSE" }
  | { readonly type: "RESET"; readonly mode: "same-seed" | "new-seed" }
  | { readonly type: "SET_CONTROLLER"; readonly controller: ControllerChoice }
  /**
   * Change the traffic level of the RUNNING scenario. The trip, its clock, its
   * route and the ego identity are untouched: the new level only adds demand
   * from this moment on, exactly like a real city getting busier.
   */
  | { readonly type: "SET_TRAFFIC"; readonly trafficLevel: TrafficLevel }
  | { readonly type: "INCIDENT"; readonly kind: IncidentKind }
  /**
   * Issue #28: run ONE scenario headlessly under both controllers and return
   * both results. Same world, same driver, same seed, same incident script —
   * only the signals differ. This is the fair comparison, and it is fast
   * because it never posts frames.
   */
  | {
      readonly type: "COMPARE";
      readonly tripId: CuratedTripId;
      readonly trafficLevel: TrafficLevel;
      readonly driver: DriverStrategy;
      readonly seed: number;
      readonly durationMs?: number;
    };

/* ------------------------------ worker -> main ------------------------------ */

export interface RunConfig {
  readonly citySize: CitySize;
  readonly trafficLevel: TrafficLevel;
  readonly tripId: CuratedTripId;
  readonly controller: ControllerChoice;
  /** Who is driving the ego car. Never part of the scenario or the controller. */
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly durationMs: number;
}

export type WorkerEvent =
  | {
      readonly type: "READY";
      readonly config: RunConfig;
      /** Showcase scale (0..4) — the main thread compiles the same geography. */
      readonly scaleIndex: number;
      readonly scaleLabel: string;
      readonly timeMs: number;
      readonly incidentSeed: number;
      /** Fully resolved controller-neutral automatic adversity for this run. */
      readonly incidentPlan: ChallengeIncidentPlan;
      /** Exact resolved adversity available for later controller replay. */
      readonly incidentHistory: readonly ResolvedChallengeIncident[];
      /** Stable serialization input; controller is deliberately absent. */
      readonly incidentFingerprint: string;
    }
  | {
      readonly type: "INCIDENT_RESOLVED";
      readonly kind: IncidentKind;
      readonly queued: boolean;
      readonly label: string;
      readonly incident: ResolvedChallengeIncident | null;
      readonly incidentHistory: readonly ResolvedChallengeIncident[];
      readonly incidentFingerprint: string;
    }
  | { readonly type: "SNAPSHOT"; readonly snapshot: PresentationSnapshot }
  | { readonly type: "METRICS"; readonly metrics: PresentationMetrics }
  | {
      readonly type: "RUN_COMPLETE";
      readonly timeMs: number;
      /** The run's outcome under its controller, tagged for fair comparison. */
      readonly result: ChallengeResult;
    }
  | {
      readonly type: "COMPARE_RESULT";
      readonly fingerprint: string;
      readonly driver: DriverStrategy;
      readonly tripId: CuratedTripId;
      readonly trafficLevel: TrafficLevel;
      readonly fixed: ChallengeResult;
      readonly adaptive: ChallengeResult;
      readonly verdict: ComparisonVerdict;
      /** Same resolved incident script both runs played. */
      readonly incidentEntries: number;
    }
  | { readonly type: "ERROR"; readonly message: string };

/* -------------------------------- validation -------------------------------- */

function fail(where: string, detail: string): never {
  throw new RangeError(`invalid ${where}: ${detail}`);
}

function readRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    fail("worker command", "expected a plain object");
  }
  return raw as Record<string, unknown>;
}

function readChoice<T extends string>(
  where: string,
  value: unknown,
  choices: readonly T[],
): T {
  if (typeof value !== "string" || !(choices as readonly string[]).includes(value)) {
    fail(where, `expected one of ${choices.join(", ")}, received ${String(value)}`);
  }
  return value as T;
}

function readSeed(where: string, value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 0xffffffff
  ) {
    fail(where, `seed must be a uint32 integer, received ${String(value)}`);
  }
  return value;
}

/** Validates and narrows one incoming command; throws RangeError on garbage. */
export function parseWorkerCommand(raw: unknown): WorkerCommand {
  const record = readRecord(raw);
  const type = record.type;
  switch (type) {
    case "INIT": {
      const citySize = readChoice("INIT.citySize", record.citySize, CITY_SIZE_CHOICES);
      const trafficLevel = readChoice(
        "INIT.trafficLevel",
        record.trafficLevel,
        TRAFFIC_LEVEL_CHOICES,
      );
      const tripId = readChoice("INIT.tripId", record.tripId, CURATED_TRIP_IDS);
      const controller = readChoice(
        "INIT.controller",
        record.controller,
        CONTROLLER_CHOICES,
      );
      const driver = readChoice("INIT.driver", record.driver ?? "tourist", DRIVER_CHOICES);
      const seed = readSeed("INIT.seed", record.seed);
      let durationMs: number | undefined;
      if (record.durationMs !== undefined) {
        if (
          typeof record.durationMs !== "number" ||
          !Number.isFinite(record.durationMs) ||
          record.durationMs <= 0 ||
          record.durationMs > 24 * 60 * 60 * 1000
        ) {
          fail("INIT.durationMs", `expected a positive finite duration, received ${String(record.durationMs)}`);
        }
        durationMs = record.durationMs;
      }
      return { type, citySize, trafficLevel, tripId, controller, driver, seed, durationMs };
    }
    case "START":
    case "PAUSE":
      return { type };
    case "COMPARE": {
      const tripId = readChoice("COMPARE.tripId", record.tripId, CURATED_TRIP_IDS);
      const trafficLevel = readChoice("COMPARE.trafficLevel", record.trafficLevel, TRAFFIC_LEVEL_CHOICES);
      const driver = readChoice("COMPARE.driver", record.driver, DRIVER_CHOICES);
      const seed = readSeed("COMPARE.seed", record.seed);
      let durationMs: number | undefined;
      if (record.durationMs !== undefined) {
        if (
          typeof record.durationMs !== "number" ||
          !Number.isFinite(record.durationMs) ||
          record.durationMs <= 0 ||
          record.durationMs > 24 * 60 * 60 * 1000
        ) {
          fail("COMPARE.durationMs", `expected a positive finite duration, received ${String(record.durationMs)}`);
        }
        durationMs = record.durationMs;
      }
      return { type, tripId, trafficLevel, driver, seed, durationMs };
    }
    case "RESET": {
      const mode = readChoice("RESET.mode", record.mode, ["same-seed", "new-seed"] as const);
      return { type, mode };
    }
    case "SET_CONTROLLER": {
      const controller = readChoice(
        "SET_CONTROLLER.controller",
        record.controller,
        CONTROLLER_CHOICES,
      );
      return { type, controller };
    }
    case "SET_TRAFFIC": {
      const trafficLevel = readChoice(
        "SET_TRAFFIC.trafficLevel",
        record.trafficLevel,
        TRAFFIC_LEVELS,
      );
      return { type, trafficLevel };
    }
    case "INCIDENT": {
      const kind = readChoice("INCIDENT.kind", record.kind, INCIDENT_CHOICES);
      return { type, kind };
    }
    default:
      fail("worker command", `unknown type ${String(type)}`);
  }
}

/** Deterministic next seed for a "new seed" reset: +1 in uint32 space. */
export function nextSeed(seed: number): number {
  return (seed + 1) >>> 0;
}
