"use client";

/**
 * UI store (Task 11): UI state ONLY. The simulation — engine, traffic,
 * incidents, demand — lives exclusively in the worker; presentation frames
 * stay in refs near the canvas and never enter React state or Zustand.
 */
import { create } from "zustand";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { PresentationMetrics } from "@/worker/presentation-snapshot";
import type { ControllerChoice, RunConfig } from "@/worker/protocol";

export interface UiState {
  citySize: CitySize;
  trafficLevel: TrafficLevel;
  controller: ControllerChoice;
  seed: number;
  running: boolean;
  ready: boolean;
  runComplete: boolean;
  error: string | null;
  metrics: PresentationMetrics | null;
  config: RunConfig | null;
  setCitySize: (citySize: CitySize) => void;
  setTrafficLevel: (trafficLevel: TrafficLevel) => void;
  setController: (controller: ControllerChoice) => void;
  applyReady: (config: RunConfig) => void;
  setRunning: (running: boolean) => void;
  setRunComplete: (runComplete: boolean) => void;
  setError: (error: string | null) => void;
  setMetrics: (metrics: PresentationMetrics) => void;
}

export const useUiStore = create<UiState>()((set) => ({
  citySize: "medium",
  trafficLevel: "everyday",
  controller: "adaptive",
  seed: 42,
  running: false,
  ready: false,
  runComplete: false,
  error: null,
  metrics: null,
  config: null,
  setCitySize: (citySize) => set({ citySize }),
  setTrafficLevel: (trafficLevel) => set({ trafficLevel }),
  setController: (controller) => set({ controller }),
  applyReady: (config) =>
    set({
      config,
      seed: config.seed,
      controller: config.controller,
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
