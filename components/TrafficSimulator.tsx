"use client";

/**
 * TrafficSimulator (Task 11 visual correction): the single client-side owner
 * of the worker and the product composition.
 *
 * Landing → configuration → "Enter City" (INIT) → camera flies into Central →
 * minimal live chrome. The map surface compiles the same deterministic
 * showcase geography the worker simulates; no EngineState ever crosses into
 * React. Presentation frames live in a ref shared with the map's rAF loop.
 */
import { useCallback, useEffect, useRef } from "react";
import { showcaseCity } from "@/cities/showcase-city";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { IncidentKind } from "@/sim/incidents";
import { buildDirectedPathIndexes } from "@/render/showcase-geometry";
import { useUiStore } from "@/store/ui-store";
import type { ControllerChoice, WorkerCommand, WorkerEvent } from "@/worker/protocol";
import { CityMap, type MapHandle } from "./CityMap";
import { createFrameBuffer, pushFrame, setFrameModel, type FrameBuffer } from "./frame-buffer";
import { IncidentBar } from "./IncidentBar";
import { MetricsHUD } from "./MetricsHUD";
import { Onboarding } from "./Onboarding";
import { SimChrome } from "./SimChrome";
import { scaleIndexForSize } from "./ui-model";

interface JevDebugHook {
  config: unknown;
  snapshot: {
    sequence: number;
    timeMs: number;
    vehicles: number;
    controller: string;
    incidents: string[];
    closedRoads: number;
    snapshotBytes: number;
  } | null;
  metrics: unknown;
  error: string | null;
}

let lastByteMeasureAt = -Infinity;

function debugEnabled(): boolean {
  return typeof window !== "undefined" && window.location.search.includes("debug");
}

function updateDebugHook(event: WorkerEvent): void {
  if (!debugEnabled()) {
    return;
  }
  const target = window as unknown as { __jevDebug?: JevDebugHook };
  const store = useUiStore.getState();
  const hook: JevDebugHook =
    target.__jevDebug ?? { config: null, snapshot: null, metrics: null, error: null };
  switch (event.type) {
    case "READY":
      hook.config = { ...event.config, scaleIndex: event.scaleIndex, scaleLabel: event.scaleLabel };
      hook.snapshot = null;
      hook.error = null;
      break;
    case "SNAPSHOT": {
      const nowMs = performance.now();
      const measure = hook.snapshot === null || nowMs - lastByteMeasureAt >= 1_000;
      if (measure) {
        lastByteMeasureAt = nowMs;
      }
      hook.snapshot = {
        sequence: event.snapshot.sequence,
        timeMs: event.snapshot.timeMs,
        vehicles: event.snapshot.vehicles.length,
        controller: event.snapshot.controller,
        incidents: event.snapshot.incidents.map((incident) => `${incident.kind}:${incident.status}`),
        closedRoads: event.snapshot.roadConditions.filter((road) => road.closed).length,
        snapshotBytes: measure
          ? JSON.stringify(event.snapshot).length
          : (hook.snapshot?.snapshotBytes ?? 0),
      };
      break;
    }
    case "METRICS":
      hook.metrics = event.metrics;
      break;
    case "RUN_COMPLETE":
      hook.error = null;
      break;
    case "ERROR":
      hook.error = event.message;
      break;
  }
  if (store.config) {
    const previous = hook.config as { scaleIndex?: number; scaleLabel?: string } | null;
    hook.config = {
      ...store.config,
      controller: store.controller,
      seed: store.seed,
      scaleIndex: previous?.scaleIndex,
      scaleLabel: previous?.scaleLabel,
    };
  }
  target.__jevDebug = hook;
}

export function TrafficSimulator() {
  const framesRef = useRef<FrameBuffer>(createFrameBuffer());
  const workerRef = useRef<Worker | null>(null);
  const mapHandleRef = useRef<MapHandle | null>(null);
  const lastScaleRef = useRef<number | null>(null);
  const phase = useUiStore((state) => state.phase);
  const citySize = useUiStore((state) => state.citySize);

  useEffect(() => {
    const worker = new Worker(new URL("../worker/simulation.worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent) => {
      const data = event.data as WorkerEvent;
      updateDebugHook(data);
      const store = useUiStore.getState();
      switch (data.type) {
        case "READY": {
          const model = showcaseCity(data.scaleIndex);
          setFrameModel(framesRef.current, model, buildDirectedPathIndexes(model));
          const entering = store.phase === "entering";
          const scaleChanged = lastScaleRef.current !== null && lastScaleRef.current !== data.scaleIndex;
          lastScaleRef.current = data.scaleIndex;
          store.applyReady(data.config, data.scaleLabel);
          store.setPhase("city");
          if (entering || scaleChanged) {
            // Deliberate transition: the camera flies into Central while the
            // onboarding surface fades away.
            mapHandleRef.current?.flyToCentral();
          }
          break;
        }
        case "SNAPSHOT": {
          pushFrame(framesRef.current, data.snapshot, performance.now());
          break;
        }
        case "METRICS": {
          store.setMetrics(data.metrics);
          break;
        }
        case "RUN_COMPLETE": {
          store.setRunning(false);
          store.setRunComplete(true);
          break;
        }
        case "ERROR": {
          store.setError(data.message);
          store.setRunning(false);
          break;
        }
      }
    };
    worker.onerror = (event) => {
      const store = useUiStore.getState();
      store.setError(event.message || "simulation worker crashed");
      store.setRunning(false);
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback((command: WorkerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  const startRun = useCallback(
    (overrides: Partial<{ citySize: CitySize; trafficLevel: TrafficLevel; seed: number }> = {}) => {
      const state = useUiStore.getState();
      state.setError(null);
      state.setRunComplete(false);
      send({
        type: "INIT",
        citySize: overrides.citySize ?? state.citySize,
        trafficLevel: overrides.trafficLevel ?? state.trafficLevel,
        controller: state.controller,
        seed: overrides.seed ?? state.seed,
      });
    },
    [send],
  );

  const enterCity = useCallback(() => {
    useUiStore.getState().setPhase("entering");
    startRun();
  }, [startRun]);

  const onPause = useCallback(() => {
    send({ type: "PAUSE" });
    useUiStore.getState().setRunning(false);
  }, [send]);

  const onResume = useCallback(() => {
    send({ type: "START" });
    useUiStore.getState().setRunning(true);
  }, [send]);

  const onController = useCallback(
    (controller: ControllerChoice) => {
      // Live switch: no restart, no rebuild.
      useUiStore.getState().setController(controller);
      send({ type: "SET_CONTROLLER", controller });
    },
    [send],
  );

  const onCitySize = useCallback(
    (citySize: CitySize) => {
      useUiStore.getState().setCitySize(citySize);
      startRun({ citySize });
    },
    [startRun],
  );

  const onTrafficLevel = useCallback(
    (trafficLevel: TrafficLevel) => {
      useUiStore.getState().setTrafficLevel(trafficLevel);
      startRun({ trafficLevel });
    },
    [startRun],
  );

  const onSeed = useCallback(
    (seed: number) => {
      useUiStore.getState().setSeed(seed);
      startRun({ seed });
    },
    [startRun],
  );

  const onRestart = useCallback(() => {
    const store = useUiStore.getState();
    store.setError(null);
    store.setRunComplete(false);
    send({ type: "RESET", mode: "same-seed" });
    store.setRunning(true);
  }, [send]);

  const onNewScenario = useCallback(() => {
    const store = useUiStore.getState();
    store.setError(null);
    store.setRunComplete(false);
    send({ type: "RESET", mode: "new-seed" });
    store.setRunning(true);
  }, [send]);

  const onIncident = useCallback(
    (kind: IncidentKind) => {
      send({ type: "INCIDENT", kind });
    },
    [send],
  );

  const onHome = useCallback(() => {
    mapHandleRef.current?.fitCity();
  }, []);

  const handleMap = useCallback((handle: MapHandle | null) => {
    mapHandleRef.current = handle;
  }, []);

  const scaleIndex = scaleIndexForSize(citySize);
  const live = phase === "city";

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#f6f2ea] text-neutral-800">
      <div
        className={`absolute inset-0 transition-[filter,opacity] duration-[1400ms] ease-out ${
          live ? "blur-0 opacity-100" : "opacity-90 blur-[5px]"
        }`}
      >
        <CityMap scaleIndex={scaleIndex} frames={framesRef} live={live} onHandle={handleMap} />
      </div>
      <Onboarding onEnterCity={enterCity} />
      <SimChrome
        onPause={onPause}
        onResume={onResume}
        onController={onController}
        onCitySize={onCitySize}
        onTrafficLevel={onTrafficLevel}
        onSeed={onSeed}
        onRestart={onRestart}
        onNewScenario={onNewScenario}
        onHome={onHome}
      />
      <MetricsHUD />
      <IncidentBar onIncident={onIncident} />
    </div>
  );
}
