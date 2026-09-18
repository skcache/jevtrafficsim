"use client";

/**
 * TrafficSimulator (Task 11): the single client-side owner of the worker.
 * Instantiates the worker once, wires the message listener, keeps only the
 * latest frames (in refs) and metrics (2 Hz store slot), and sends commands.
 * Engine state never crosses into React.
 *
 * Initial behavior (documented): defaults are Medium / Everyday / Adaptive /
 * seed 42 and the run starts automatically once READY arrives.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { IncidentKind } from "@/sim/incidents";
import type { ControllerChoice, WorkerCommand, WorkerEvent } from "@/worker/protocol";
import { useUiStore } from "@/store/ui-store";
import { CityCanvas } from "./CityCanvas";
import { ControlBar } from "./ControlBar";
import { IncidentBar } from "./IncidentBar";
import { MetricsHUD } from "./MetricsHUD";
import { createFrameBuffer, pushFrame, setFrameModel, type FrameBuffer } from "./frame-buffer";

/**
 * Dev-only inspection hook (never rendered): lets automated smoke checks read
 * the latest worker state without scraping pixels. Stripped in production.
 */
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

/** Debug mode is opt-in via ?debug=1 — the default product surface stays clean. */
function debugEnabled(): boolean {
  return (
    typeof window !== "undefined" && window.location.search.includes("debug")
  );
}

let lastByteMeasureAt = -Infinity;

function updateDebugHook(event: WorkerEvent): void {
  if (!debugEnabled()) {
    return;
  }
  const target = window as unknown as { __jevDebug?: JevDebugHook };
  const store = useUiStore.getState();
  const previous = target.__jevDebug;
  const hook: JevDebugHook = previous ?? { config: null, snapshot: null, metrics: null, error: null };
  switch (event.type) {
    case "READY":
      hook.config = event.config;
      hook.snapshot = null;
      hook.error = null;
      break;
    case "SNAPSHOT": {
      // Byte measurement is throttled to 1 Hz: stringifying the full frame at
      // 5 Hz would itself load the main thread at Large + Rush.
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
        incidents: event.snapshot.incidents.map(
          (incident) => `${incident.kind}:${incident.status}`,
        ),
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
  const config = store.config;
  hook.config = config
    ? { ...config, controller: store.controller, seed: store.seed }
    : hook.config;
  target.__jevDebug = hook;
}

export function TrafficSimulator() {
  const framesRef = useRef<FrameBuffer>(createFrameBuffer());
  const workerRef = useRef<Worker | null>(null);
  const [debugOverlay, setDebugOverlay] = useState(false);

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
          setFrameModel(framesRef.current, data.renderModel);
          store.applyReady(data.config);
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
    const initial = useUiStore.getState();
    // Debug runs may shorten the horizon (?debug=1&duration=30000) so smoke
    // checks can exercise RUN_COMPLETE quickly; the product default stands.
    const params = new URLSearchParams(window.location.search);
    const debugDuration =
      debugEnabled() && params.get("duration") ? Number(params.get("duration")) : undefined;
    worker.postMessage({
      type: "INIT",
      citySize: initial.citySize,
      trafficLevel: initial.trafficLevel,
      controller: initial.controller,
      seed: initial.seed,
      durationMs:
        debugDuration !== undefined && Number.isFinite(debugDuration) && debugDuration > 0
          ? debugDuration
          : undefined,
    } satisfies WorkerCommand);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback((command: WorkerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  /** City/traffic changes reset the run with the same seed (worker-side). */
  const initRun = useCallback(
    (overrides: {
      citySize?: CitySize;
      trafficLevel?: TrafficLevel;
      controller?: ControllerChoice;
      seed?: number;
    }) => {
      const state = useUiStore.getState();
      state.setError(null);
      state.setRunComplete(false);
      send({
        type: "INIT",
        citySize: overrides.citySize ?? state.citySize,
        trafficLevel: overrides.trafficLevel ?? state.trafficLevel,
        controller: overrides.controller ?? state.controller,
        seed: overrides.seed ?? state.seed,
      });
    },
    [send],
  );

  const onCitySize = useCallback(
    (citySize: CitySize) => {
      useUiStore.getState().setCitySize(citySize);
      initRun({ citySize });
    },
    [initRun],
  );

  const onTrafficLevel = useCallback(
    (trafficLevel: TrafficLevel) => {
      useUiStore.getState().setTrafficLevel(trafficLevel);
      initRun({ trafficLevel });
    },
    [initRun],
  );

  const onController = useCallback(
    (controller: ControllerChoice) => {
      // In-place switch: no reset, no rebuild, policy changes next tick.
      useUiStore.getState().setController(controller);
      send({ type: "SET_CONTROLLER", controller });
    },
    [send],
  );

  const onStart = useCallback(() => {
    send({ type: "START" });
    useUiStore.getState().setRunning(true);
  }, [send]);

  const onPause = useCallback(() => {
    send({ type: "PAUSE" });
    useUiStore.getState().setRunning(false);
  }, [send]);

  const onRestart = useCallback(() => {
    const store = useUiStore.getState();
    store.setError(null);
    store.setRunComplete(false);
    send({ type: "RESET", mode: "same-seed" });
    store.setRunning(true);
  }, [send]);

  const onNewSeed = useCallback(() => {
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

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#faf9f7] text-neutral-800">
      <CityCanvas frames={framesRef} debug={debugOverlay} />
      <div className="pointer-events-none absolute left-4 top-4 z-10">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-neutral-500">
          Jev Traffic Sim
        </div>
        <StatusLine />
        <button
          type="button"
          onClick={() => setDebugOverlay((value) => !value)}
          className="pointer-events-auto mt-1 text-[10px] tracking-wide text-neutral-300 transition-colors hover:text-neutral-500"
        >
          debug
        </button>
      </div>
      <ControlBar
        onCitySize={onCitySize}
        onTrafficLevel={onTrafficLevel}
        onController={onController}
        onStart={onStart}
        onPause={onPause}
        onRestart={onRestart}
        onNewSeed={onNewSeed}
      />
      <MetricsHUD />
      <IncidentBar onIncident={onIncident} />
      <ErrorBanner />
    </div>
  );
}

function StatusLine() {
  const controller = useUiStore((state) => state.controller);
  const running = useUiStore((state) => state.running);
  const ready = useUiStore((state) => state.ready);
  const runComplete = useUiStore((state) => state.runComplete);
  const label = !ready
    ? "starting…"
    : runComplete
      ? "complete"
      : running
        ? "running"
        : "paused";
  return (
    <div className="mt-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
      {controller} · {label}
    </div>
  );
}

function ErrorBanner() {
  const error = useUiStore((state) => state.error);
  if (!error) {
    return null;
  }
  return (
    <div className="pointer-events-none absolute inset-x-0 top-20 z-20 flex justify-center px-4">
      <div className="pointer-events-auto max-w-md rounded-lg border border-red-900/20 bg-white/95 px-3 py-2 text-xs text-red-800 shadow-sm">
        Simulation stopped: {error}
        <span className="text-red-500"> — use Restart to continue.</span>
      </div>
    </div>
  );
}

