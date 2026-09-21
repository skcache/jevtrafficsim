"use client";

/**
 * TrafficSimulator (Task 11 polish pass): the single client-side owner of the
 * worker and the product composition.
 *
 * Landing (city seen whole) → configuration → "Enter City" (INIT) → the map
 * sharpens and the camera flies into Central → minimal live chrome fades in
 * behind the flight. The map surface compiles the same deterministic showcase
 * geography the worker simulates; no EngineState ever crosses into React.
 * Presentation frames live in a ref shared with the map's rAF loop.
 */
import { MotionConfig } from "motion/react";
import { useCallback, useEffect, useRef } from "react";
import { loadChicagoCity } from "@/cities/chicago-assets";
import type { CuratedTripId } from "@/cities/chicago-trips";
import type { CitySize, TrafficLevel } from "@/sim/types";
import type { IncidentKind } from "@/sim/incidents";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { useUiStore } from "@/store/ui-store";
import type { ControllerChoice, WorkerCommand, WorkerEvent } from "@/worker/protocol";
import { CityMap, type MapHandle } from "./CityMap";
import { createFrameBuffer, pushFrame, setFrameModel, type FrameBuffer } from "./frame-buffer";
import { IncidentBar } from "./IncidentBar";
import { TripHUD } from "./TripHUD";
import { Onboarding } from "./Onboarding";
import { SimChrome } from "./SimChrome";
import { scaleIndexForSize } from "./ui-model";

interface JevDebugHook {
  config: unknown;
  incidentPlan: unknown;
  incidentHistory: unknown[];
  incidentFingerprint: string | null;
  snapshot: {
    sequence: number;
    timeMs: number;
    egoVehicleId: number | null;
    egoState: string | null;
    tripId: string | null;
    roadTrafficEntries: number;
    routeControls: number;
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
    target.__jevDebug ?? {
      config: null,
      incidentPlan: null,
      incidentHistory: [],
      incidentFingerprint: null,
      snapshot: null,
      metrics: null,
      error: null,
    };
  switch (event.type) {
    case "READY":
      hook.config = { ...event.config, scaleIndex: event.scaleIndex, scaleLabel: event.scaleLabel };
      hook.incidentPlan = event.incidentPlan;
      hook.incidentHistory = [...event.incidentHistory];
      hook.incidentFingerprint = event.incidentFingerprint;
      hook.snapshot = null;
      hook.error = null;
      break;
    case "INCIDENT_RESOLVED":
      hook.incidentHistory = [...event.incidentHistory];
      hook.incidentFingerprint = event.incidentFingerprint;
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
        egoVehicleId: event.snapshot.ego?.id ?? null,
        egoState: event.snapshot.ego?.state ?? null,
        tripId: event.snapshot.trip?.tripId ?? null,
        roadTrafficEntries: event.snapshot.roadTraffic.length,
        routeControls: event.snapshot.routeControls.length,
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
  /** True while the landing's background run is the one on screen. */
  const prewarmRef = useRef(false);

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
        case "COMPARE_RESULT": {
          store.setComparison({
            fixed: data.fixed,
            adaptive: data.adaptive,
            verdict: data.verdict,
            fingerprint: data.fingerprint,
          });
          store.setComparing(false);
          break;
        }
        case "READY": {
          store.setScenarioFingerprint(data.scenarioFingerprint);
          // The frozen Chicago geography loads asynchronously (same committed
          // bytes the worker compiled); frames only start once it is in place.
          void loadChicagoCity(data.scaleIndex).then((model) => {
            setFrameModel(framesRef.current, model, buildDirectedPathIndexes(model));
          });
          if (
            prewarmRef.current &&
            (store.phase === "landing" || store.phase === "config")
          ) {
            // Landing/config preview: live traffic behind the UI, no chrome.
            // Phase is part of the guard because a preview build can be
            // superseded by Enter City while Chicago is still loading. In that
            // race, the surviving READY belongs to the live run and must not
            // be swallowed by a stale prewarm flag.
            prewarmRef.current = false;
            break;
          }
          prewarmRef.current = false;
          const entering = store.phase === "entering";
          const scaleChanged = lastScaleRef.current !== null && lastScaleRef.current !== data.scaleIndex;
          lastScaleRef.current = data.scaleIndex;
          store.applyReady(data.config, data.scaleLabel);
          store.setPhase("city");
          if (entering || scaleChanged) {
            // The press owns the transition: the camera flies into Central
            // while the onboarding surface fades away.
            mapHandleRef.current?.flyToCentral();
          }
          break;
        }
        case "INCIDENT_RESOLVED": {
          store.setFeedback(data.label);
          break;
        }
        case "SNAPSHOT": {
          pushFrame(framesRef.current, data.snapshot, performance.now());
          // Trip HUD source: the ego's own progress, at frame rate (5 Hz).
          store.setTripFrame({
            trip: data.snapshot.trip,
            egoState: data.snapshot.ego?.state ?? null,
            egoSpeedMps: data.snapshot.ego?.speed ?? 0,
          });
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
    // Prewarm the landing with the default scenario so the city is alive
    // behind the title; Enter City always starts a fresh deterministic run.
    const defaults = useUiStore.getState();
    prewarmRef.current = true;
    worker.postMessage({
      type: "INIT",
      citySize: defaults.citySize,
      trafficLevel: defaults.trafficLevel,
      tripId: defaults.tripId,
      controller: defaults.controller,
      driver: defaults.driver,
      seed: defaults.seed,
    } satisfies WorkerCommand);
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const send = useCallback((command: WorkerCommand) => {
    workerRef.current?.postMessage(command);
  }, []);

  const startRun = useCallback(
    (overrides: Partial<{ citySize: CitySize; trafficLevel: TrafficLevel; tripId: CuratedTripId; seed: number }> = {}) => {
      const state = useUiStore.getState();
      state.setError(null);
      state.setRunComplete(false);
      send({
        type: "INIT",
        citySize: overrides.citySize ?? state.citySize,
        trafficLevel: overrides.trafficLevel ?? state.trafficLevel,
        tripId: overrides.tripId ?? state.tripId,
        controller: state.controller,
        driver: state.driver,
        seed: overrides.seed ?? state.seed,
      });
    },
    [send],
  );

  /**
   * Run the CURRENT scenario headlessly under both controllers (Issue #28).
   * The worker builds one world and steps it twice, so the comparison never
   * depends on how long the user watched the live run.
   */
  const compareControllers = useCallback(() => {
    const state = useUiStore.getState();
    state.setError(null);
    state.setComparison(null);
    state.setComparing(true);
    send({
      type: "COMPARE",
      tripId: state.tripId,
      trafficLevel: state.trafficLevel,
      driver: state.driver,
      seed: state.seed,
    });
  }, [send]);

  const previewSetup = useCallback(() => {
    // Configuration is a live traffic preview, not a static mock. Mark the
    // next READY as prewarm-only so changing trip/traffic/controller/seed
    // refreshes the city behind the setup panel without entering the challenge.
    prewarmRef.current = true;
    startRun({ citySize: "large" });
  }, [startRun]);

  const enterCity = useCallback(() => {
    const store = useUiStore.getState();
    store.setCitySize("large");
    store.setPhase("entering");
    startRun({ citySize: "large" });
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

  const onTripId = useCallback(
    (tripId: CuratedTripId) => {
      const store = useUiStore.getState();
      store.setTripId(tripId);
      startRun({ citySize: "large", tripId });
    },
    [startRun],
  );

  const onTrafficLevel = useCallback(
    (trafficLevel: TrafficLevel) => {
      const store = useUiStore.getState();
      store.setTrafficLevel(trafficLevel);
      // Mid-trip this is a LIVE change: the city gets busier or quieter from
      // this moment on, and the trip keeps its clock, route and ego. Only a
      // change made before the run starts (or an explicit trip change) rebuilds.
      if (store.phase === "city" || store.phase === "entering") {
        send({ type: "SET_TRAFFIC", trafficLevel });
        return;
      }
      startRun({ trafficLevel });
    },
    [send, startRun],
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
    store.resetMetrics();
    send({ type: "RESET", mode: "same-seed" });
    store.setRunning(true);
  }, [send]);

  const onNewScenario = useCallback(() => {
    const store = useUiStore.getState();
    store.setError(null);
    store.setRunComplete(false);
    store.resetMetrics();
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

  const onZoomIn = useCallback(() => {
    mapHandleRef.current?.zoomIn();
  }, []);

  const onZoomOut = useCallback(() => {
    mapHandleRef.current?.zoomOut();
  }, []);

  const onChangeSetup = useCallback(() => {
    useUiStore.getState().setPhase("config");
  }, []);

  const handleMap = useCallback((handle: MapHandle | null) => {
    mapHandleRef.current = handle;
  }, []);

  // Follow camera: the map owns the state; the chrome only mirrors and toggles it.
  const following = useUiStore((state) => state.following);
  const onFollow = useCallback(() => {
    mapHandleRef.current?.followEgo();
  }, []);

  const scaleIndex = scaleIndexForSize(citySize);
  const live = phase === "city";

  return (
    <MotionConfig reducedMotion="user">
      <div className="absolute inset-0 overflow-hidden bg-paper text-ink">
        <CityMap scaleIndex={scaleIndex} frames={framesRef} live={live} onHandle={handleMap} />
        {/* The city stays sharp; a warm wash settles the landing, nothing more. */}
        <div
          className={`pointer-events-none absolute inset-0 z-10 bg-paper transition-opacity duration-[900ms] ease-out ${
            live ? "opacity-0" : "opacity-30"
          }`}
          aria-hidden="true"
        />
        <Onboarding onEnterCity={enterCity} onPreviewSetup={previewSetup} onCompare={compareControllers} />
        <SimChrome
          following={following}
          onFollow={onFollow}
          onPause={onPause}
          onResume={onResume}
          onController={onController}
          onTripId={onTripId}
          onTrafficLevel={onTrafficLevel}
          onSeed={onSeed}
          onRestart={onRestart}
          onNewScenario={onNewScenario}
          onZoomIn={onZoomIn}
          onZoomOut={onZoomOut}
          onHome={onHome}
          onChangeSetup={onChangeSetup}
        />
        <TripHUD />
        <IncidentBar onIncident={onIncident} />
      </div>
    </MotionConfig>
  );
}
