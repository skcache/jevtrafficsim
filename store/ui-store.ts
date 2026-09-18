"use client";

/**
 * UI store (Task 11 visual correction): UI state ONLY — onboarding phase,
 * selections, worker status, metrics. Simulation state lives exclusively in
 * the worker; presentation frames live in refs near the map.
 */
import { create } from "zustand";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { PresentationMetrics } from "@/worker/presentation-snapshot";
import type { ControllerChoice, RunConfig } from "@/worker/protocol";

export type UiPhase = "landing" | "config" | "entering" | "city";

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
  config: RunConfig | null;
  scaleLabel: string;
  scenarioOpen: boolean;
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
  config: null,
  scaleLabel: "Medium",
  scenarioOpen: false,
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
    }),
  setRunning: (running) => set({ running }),
  setRunComplete: (runComplete) => set({ runComplete }),
  setError: (error) => set({ error }),
  setMetrics: (metrics) => set({ metrics }),
}));
