"use client";

/**
 * UI store (Task 11 polish pass): UI state ONLY — onboarding phase,
 * selections, worker status, metrics and a bounded metrics history for the
 * sparkline. Simulation state lives exclusively in the worker; presentation
 * frames live in refs near the map.
 */
import { create } from "zustand";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { PresentationMetrics } from "@/worker/presentation-snapshot";
import type { ControllerChoice, RunConfig } from "@/worker/protocol";

export type UiPhase = "landing" | "config" | "entering" | "city";

/** Avg-wait samples kept for the sparkline (2 Hz × 150 = 75 s of history). */
export const METRICS_HISTORY_LIMIT = 150;

export interface UiState {
  phase: UiPhase;
  citySize: CitySize;
  trafficLevel: TrafficLevel;
  controller: ControllerChoice;
  seed: number;
  ready: boolean;
  running: boolean;
  runComplete: boolean;
  error: string | null;
  metrics: PresentationMetrics | null;
  metricsHistory: number[];
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
  setController: (controller: ControllerChoice) => void;
  setSeed: (seed: number) => void;
  setScenarioOpen: (open: boolean) => void;
  applyReady: (config: RunConfig, scaleLabel: string) => void;
  setRunning: (running: boolean) => void;
  setRunComplete: (runComplete: boolean) => void;
  setError: (error: string | null) => void;
  setMetrics: (metrics: PresentationMetrics) => void;
  setFeedback: (feedback: string | null) => void;
  flashSurge: () => void;
  showSurge: () => void;
  hideSurge: () => void;
  resetMetrics: () => void;
}

export const useUiStore = create<UiState>()((set) => ({
  phase: "landing",
  citySize: "medium",
  trafficLevel: "everyday",
  controller: "adaptive",
  seed: 42,
  ready: false,
  running: false,
  runComplete: false,
  error: null,
  metrics: null,
  metricsHistory: [],
  config: null,
  scaleLabel: "Medium",
  scenarioOpen: false,
  surgeFlash: 0,
  surgeVisible: false,
  feedback: null,
  setPhase: (phase) => set({ phase }),
  setCitySize: (citySize) => set({ citySize }),
  setTrafficLevel: (trafficLevel) => set({ trafficLevel }),
  setController: (controller) => set({ controller }),
  setSeed: (seed) => set({ seed }),
  setScenarioOpen: (scenarioOpen) => set({ scenarioOpen }),
  applyReady: (config, scaleLabel) =>
    set({
      config,
      seed: config.seed,
      controller: config.controller,
      scaleLabel,
      ready: true,
      error: null,
      runComplete: false,
      running: true,
      metrics: null,
      metricsHistory: [],
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
  setFeedback: (feedback) => set({ feedback }),
  flashSurge: () => set((state) => ({ surgeFlash: state.surgeFlash + 1 })),
  showSurge: () => set({ surgeVisible: true }),
  hideSurge: () => set({ surgeVisible: false }),
  resetMetrics: () => set({ metrics: null, metricsHistory: [] }),
}));
