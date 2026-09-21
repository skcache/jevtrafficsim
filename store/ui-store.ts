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
  PresentationTripProgress,
} from "@/worker/presentation-snapshot";
import type { ControllerChoice, RunConfig } from "@/worker/protocol";
import type { DriverStrategy } from "@/sim/driver";
import type { ChallengeResult, ComparisonVerdict } from "@/worker/challenge-result";

/** A finished headless comparison of the current scenario (Issue #28). */
export interface ComparisonState {
  readonly fixed: ChallengeResult;
  readonly adaptive: ChallengeResult;
  readonly verdict: ComparisonVerdict;
  readonly fingerprint: string;
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
  /** Headless Fixed-vs-Adaptive run of the current scenario, when one exists. */
  comparison: ComparisonState | null;
  comparing: boolean;
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
  setComparison: (comparison: ComparisonState | null) => void;
  setComparing: (comparing: boolean) => void;
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
  tripId: "united-center-to-navy-pier",
  controller: "adaptive",
  driver: "tourist",
  scenarioFingerprint: null,
  comparison: null,
  comparing: false,
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
  setComparison: (comparison) => set({ comparison }),
  setComparing: (comparing) => set({ comparing }),
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
    set({ metrics: null, metricsHistory: [], trip: null, egoState: null, egoSpeedMps: 0 }),
}));
