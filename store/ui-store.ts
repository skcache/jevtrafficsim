"use client";

/**
 * UI store (Task 11 polish pass): UI state ONLY — onboarding phase,
 * selections, worker status, metrics and a bounded metrics history for the
 * sparkline. Simulation state lives exclusively in the worker; presentation
 * frames live in refs near the map.
 */
import { create } from "zustand";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { CuratedTripId } from "@/cities/chicago-trips";
import type {
  PresentationMetrics,
  PresentationPolicy,
  PresentationTripProgress,
} from "@/worker/presentation-snapshot";
import type { ControllerChoice, RunConfig } from "@/worker/protocol";
import type { DriverStrategy } from "@/sim/driver";
import type { ChallengeResult } from "@/worker/challenge-result";

/**
 * The two deterministic baselines for one scenario (Issue #15), computed off
 * the interactive thread while the visible Jev run plays. They belong to the
 * fingerprint they were built for: results for another scenario are ignored
 * rather than quietly shown beside this run.
 */
export interface BaselineState {
  readonly fixed: ChallengeResult;
  readonly adaptive: ChallengeResult;
  readonly fingerprint: string;
  readonly incidentEntries: number;
}

export type UiPhase = "landing" | "config" | "entering" | "city";

/** Avg-wait samples kept for the sparkline (2 Hz × 150 = 75 s of history). */
export const METRICS_HISTORY_LIMIT = 150;

export interface UiState {
  phase: UiPhase;
  citySize: CitySize;
  trafficLevel: TrafficLevel;
  tripId: CuratedTripId;
  controller: ControllerChoice;
  /** Driver behaviour profile (Issue #28) — independent of the controller. */
  driver: DriverStrategy;
  /** Scenario identity of the running world (Issue #28), shown instead of the seed. */
  scenarioFingerprint: string | null;
  /** Fixed and Adaptive baselines for the running scenario, once computed. */
  baselines: BaselineState | null;
  baselinesRunning: boolean;
  /** The visible run's own outcome, published when it finishes. */
  liveResult: ChallengeResult | null;
  /** Who governed the signals in the visible run (live | replay | fallback). */
  policy: PresentationPolicy | null;
  /** Developer controls (?debug) only: controller choice, raw seed, city scale. */
  debug: boolean;
  seed: number;
  ready: boolean;
  running: boolean;
  runComplete: boolean;
  error: string | null;
  metrics: PresentationMetrics | null;
  metricsHistory: number[];
  /** Trip HUD source: the ego's trip progress from the latest frame. */
  trip: PresentationTripProgress | null;
  egoState: string | null;
  egoSpeedMps: number;
  /** Follow camera: owned by the map, mirrored here for the chrome button. */
  following: boolean;
  config: RunConfig | null;
  scaleLabel: string;
  scenarioOpen: boolean;
  /** Increments on each demand-surge action so the chip can react. */
  surgeFlash: number;
  surgeVisible: boolean;
  /** Transient line shown above the incident dock ("Crash queued"). */
  feedback: string | null;
  setPhase: (phase: UiPhase) => void;
  setCitySize: (citySize: CitySize) => void;
  setTrafficLevel: (trafficLevel: TrafficLevel) => void;
  setTripId: (tripId: CuratedTripId) => void;
  setController: (controller: ControllerChoice) => void;
  setDriver: (driver: DriverStrategy) => void;
  setScenarioFingerprint: (fingerprint: string | null) => void;
  setBaselines: (baselines: BaselineState | null) => void;
  setBaselinesRunning: (running: boolean) => void;
  setLiveResult: (result: ChallengeResult | null) => void;
  setPolicy: (policy: PresentationPolicy | null) => void;
  setDebug: (debug: boolean) => void;
  setSeed: (seed: number) => void;
  setScenarioOpen: (open: boolean) => void;
  applyReady: (config: RunConfig, scaleLabel: string) => void;
  setRunning: (running: boolean) => void;
  setRunComplete: (runComplete: boolean) => void;
  setError: (error: string | null) => void;
  setMetrics: (metrics: PresentationMetrics) => void;
  setTripFrame: (frame: {
    trip: PresentationTripProgress | null;
    egoState: string | null;
    egoSpeedMps: number;
  }) => void;
  setFollowing: (following: boolean) => void;
  setFeedback: (feedback: string | null) => void;
  flashSurge: () => void;
  showSurge: () => void;
  hideSurge: () => void;
  resetMetrics: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  phase: "landing",
  citySize: "large",
  trafficLevel: "everyday",
  tripId: "soldier-field-to-navy-pier",
  /** Jev is the product's visible run; Fixed/Adaptive are the baselines. */
  controller: "jev",
  driver: "tourist",
  scenarioFingerprint: null,
  baselines: null,
  baselinesRunning: false,
  liveResult: null,
  policy: null,
  debug: false,
  seed: 42,
  ready: false,
  running: false,
  runComplete: false,
  error: null,
  metrics: null,
  metricsHistory: [],
  trip: null,
  egoState: null,
  egoSpeedMps: 0,
  following: true,
  config: null,
  scaleLabel: "Medium",
  scenarioOpen: false,
  surgeFlash: 0,
  surgeVisible: false,
  feedback: null,
  setPhase: (phase) => set({ phase }),
  setCitySize: (citySize) => set({ citySize }),
  setTrafficLevel: (trafficLevel) => set({ trafficLevel }),
  setTripId: (tripId) => set({ tripId, citySize: "large" }),
  setController: (controller) => set({ controller }),
  setDriver: (driver) => set({ driver }),
  setScenarioFingerprint: (scenarioFingerprint) => set({ scenarioFingerprint }),
  setBaselines: (baselines) => set({ baselines }),
  setBaselinesRunning: (baselinesRunning) => set({ baselinesRunning }),
  setLiveResult: (liveResult) => set({ liveResult }),
  setPolicy: (policy) => set({ policy }),
  setDebug: (debug) => set({ debug }),
  setSeed: (seed) => set({ seed }),
  setScenarioOpen: (scenarioOpen) => set({ scenarioOpen }),
  applyReady: (config, scaleLabel) =>
    set({
      config,
      seed: config.seed,
      controller: config.controller,
      tripId: config.tripId,
      scaleLabel,
      ready: true,
      error: null,
      runComplete: false,
      running: true,
      metrics: null,
      metricsHistory: [],
      trip: null,
      egoState: null,
      egoSpeedMps: 0,
      feedback: null,
      surgeVisible: false,
      // A new run invalidates the previous run's outcome and provenance. The
      // baselines are dispatched separately and are matched by fingerprint.
      liveResult: null,
      policy: null,
    }),
  setRunning: (running) => set({ running }),
  setRunComplete: (runComplete) => set({ runComplete }),
  setError: (error) => set({ error }),
  setMetrics: (metrics) =>
    set((state) => ({
      metrics,
      metricsHistory: [...state.metricsHistory, metrics.averageWaitTimeMs / 1000].slice(
        -METRICS_HISTORY_LIMIT,
      ),
    })),
  setTripFrame: ({ trip, egoState, egoSpeedMps }) => set({ trip, egoState, egoSpeedMps }),
  setFollowing: (following) => set({ following }),
  setFeedback: (feedback) => set({ feedback }),
  flashSurge: () => set((state) => ({ surgeFlash: state.surgeFlash + 1 })),
  showSurge: () => set({ surgeVisible: true }),
  hideSurge: () => set({ surgeVisible: false }),
  resetMetrics: () =>
    set({
      metrics: null,
      metricsHistory: [],
      trip: null,
      egoState: null,
      egoSpeedMps: 0,
      liveResult: null,
    }),
}));
