"use client";

/**
 * CityMap (Task 11 polish pass): the product's map surface.
 *
 * MapLibre GL renders the static showcase geography from LOCAL in-memory
 * GeoJSON (no tiles, no external basemap, no attribution) and owns the camera
 * (pan / wheel zoom / pinch / double-click). deck.gl (via MapLibreOverlay)
 * draws the dynamic layers — vehicles, signals, incident overlays — from the
 * bounded 5 Hz presentation snapshots, interpolated to display rate in one
 * rAF loop.
 *
 * Presentation grammar: muted city context under explicit simulation state.
 * Blocks, water, major parks and road hierarchy orient the user; vehicles,
 * right-of-way gates, congestion and incidents carry the experiment. React renders this component once per scale; nothing here
 * rerenders per frame. No simulation logic on this thread.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import {
  Map as MapLibreMap,
  Marker,
  setWorkerUrl,
  type GeoJSONSource,
  type IControl,
  type StyleSpecification,
} from "maplibre-gl";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import type { Layer } from "@deck.gl/core";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { loadChicagoCity } from "@/cities/chicago-assets";
import { metricToLngLat, type MapModel } from "@/cities/map-model";
import {
  clamp01,
  frameAlpha,
  interpolateEgoRoadProgress,
  interpolateVehicles,
  smoothRenderClock,
} from "@/render/interpolate";
import { clampVehiclesAtSignals, packQueues } from "@/render/queue-packing";
import {
  carriagewayPairs,
  laneCentreOffsetMetres,
  widthMetresForRoad,
} from "@/render/road-presentation";
import { roadPressure } from "@/render/congestion";
import {
  boundsLngLat as cameraBoundsLngLat,
  FIT_PADDING,
  networkBounds,
  presetPose,
} from "@/render/camera-presets";
import { buildChicagoStyle } from "@/render/chicago-style";
import { buildShowcaseGeoJson, type ShowcaseGeoJson } from "@/render/map-geojson";
import {
  buildCongestionLayers,
  buildIncidentLayers,
  type CongestionRoad,
  buildVehicleLayers,
  type IncidentExtras,
} from "@/render/deck-layers";
import { waitHeatBucket } from "@/render/map-geometry";
import { useUiStore } from "@/store/ui-store";
import { type VehicleIconSet } from "@/render/vehicle-icons";
import { createVehicleSprites } from "@/render/vehicle-sprites";
import { createDestinationSprites, type DestinationSpriteSet } from "@/render/destination-sprite";
import { advanceFollow, createFollowState, disableFollow, enableFollow, type FollowState } from "@/render/follow-camera";
import { FOLLOW_SCALE } from "@/render/scale";
import { applyRoadFocus } from "@/render/chicago-style";
import { buildRouteSegments, routeTrafficMix, type RouteSegment } from "@/render/route-path";
import { classifySnapshotRoads, type RouteTrafficClass } from "@/render/route-traffic";
import { buildDestinationLayers, buildRouteLayers } from "@/render/route-layers";
import { createControlSprites, type ControlSpriteSet } from "@/render/control-sprites";
import {
  deriveContextualControls,
  upcomingControl,
  type ContextualControl,
} from "@/render/contextual-controls";
import { buildControlLayers } from "@/render/control-layers";
import { buildNetworkSignalLayers, networkSignalMarkers, type NetworkSignalMarker } from "@/render/network-controls";
import { SIM_TICK_MS } from "@/worker/protocol";
import type { FrameBuffer } from "./frame-buffer";

/**
 * The worker posts exactly one frame per real tick (see the worker's runTick),
 * so this must be SIM_TICK_MS alone. Scaling it by SNAPSHOT_EVERY_TICKS made
 * alpha crawl to a fraction of its range before the next frame arrived, and
 * every arrival snapped the world forward — the stutter.
 */
const EXPECTED_FRAME_INTERVAL_MS = SIM_TICK_MS;

/**
 * MapLibre's module worker, self-hosted (public/maplibre/). The bundled
 * worker URL does not resolve under the Turbopack production build (it came
 * out empty and every source stalled), so we point MapLibre at the exact
 * files from the installed package instead of guessing at bundler output.
 */
const MAPLIBRE_WORKER_URL = "/maplibre/maplibre-gl-worker.mjs";
let workerUrlConfigured = false;
function configureMapLibreWorker(): void {
  if (!workerUrlConfigured) {
    setWorkerUrl(MAPLIBRE_WORKER_URL);
    workerUrlConfigured = true;
  }
}

export interface MapHandle {
  flyToCentral: (options?: { immediate?: boolean }) => void;
  fitCity: (options?: { immediate?: boolean }) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  getZoom: () => number;
  /** Resume following the ego car, easing back to it (Issue #25). */
  followEgo: () => void;
  isFollowing: () => boolean;
}

interface CityMapProps {
  scaleIndex: number;
  frames: RefObject<FrameBuffer>;
  /** Camera + interaction unlocked once the user is in the city. */
  live: boolean;
  onHandle?: (handle: MapHandle | null) => void;
}

function buildStyle(geo: ShowcaseGeoJson): StyleSpecification {
  return buildChicagoStyle(geo);
}

export function CityMap({ scaleIndex, frames, live, onHandle }: CityMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const zoomRef = useRef(16);
  const iconsRef = useRef<VehicleIconSet | null>(null);
  const controlSpritesRef = useRef<ControlSpriteSet | null>(null);
  /** Per-road lane-centre offsets in metres for the current model. */
  const laneOffsetsRef = useRef<number[] | null>(null);
  /** Per-road lng/lat paths + physical widths, for the whole-city traffic layer. */
  const congestionRoadsRef = useRef<CongestionRoad[]>([]);
  /** Static low-prominence signal network: citywide system context, no worker payload. */
  const networkSignalsRef = useRef<NetworkSignalMarker[]>([]);
  /** Latest incident plate positions (metric), for the dev camera helper. */
  const platesRef = useRef<readonly { x: number; y: number; label: string }[]>([]);
  /** Metric anchor of the active crash, for the dev camera hook. */
  const crashRef = useRef<{ x: number; y: number } | null>(null);
  /** Last rendered frame, for the dev motion-QA hook. */
  const frameRef = useRef<
    { id: number; roadId: number | null; x: number; y: number; headingRadians: number; blockedWaitMs: number }[]
  >([]);
  const destSpritesRef = useRef<DestinationSpriteSet | null>(null);
  /** Smoothed render clock (simulated ms) and the wall time it last advanced. */
  const renderClockRef = useRef<number>(Number.NaN);
  const renderClockNowRef = useRef<number>(Number.NaN);
  /** Follow camera state; north-up, driven by the interpolated car. */
  const followRef = useRef<FollowState>(createFollowState());
  /** While a camera ease owns the frame (enter-city flight, recenter). */
  const easeGuardUntilRef = useRef(0);
  const lastRenderAtRef = useRef(0);
  const routeSegmentsRef = useRef<RouteSegment[]>([]);
  /** Controls the ego is about to meet this frame (at most a couple). */
  const controlsRef = useRef<ContextualControl[]>([]);
  /** Last interpolated car position in map metres (for recenter). */
  const lastEgoMetricRef = useRef<{ x: number; y: number; headingRadians: number } | null>(null);
  const routeMixRef = useRef<Record<RouteTrafficClass, number>>({ free: 0, slowed: 0, congested: 0 });
  const liveRef = useRef(live);
  /** `?notraffic=1`: hide every traffic primitive for a basemap review. */
  const trafficHiddenRef = useRef(
    typeof window !== "undefined" && new URLSearchParams(window.location.search).has("notraffic"),
  );
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const [model, setModel] = useState<MapModel | null>(null);
  // The map is created once, as soon as the first geography is available: the
  // model is loaded asynchronously from the frozen Chicago assets.
  const ready = model !== null;
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    loadChicagoCity(scaleIndex)
      .then((loaded) => {
        if (!cancelled) {
          setModel(loaded);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scaleIndex]);

  const geo = useMemo(() => (model ? buildShowcaseGeoJson(model) : null), [model]);
  const modelRef = useRef<MapModel | null>(model);
  const geoRef = useRef(geo);
  useEffect(() => {
    modelRef.current = model;
    geoRef.current = geo;
    if (model) {
      const pairs = carriagewayPairs(model);
      laneOffsetsRef.current = model.city.roads.map((road) =>
        laneCentreOffsetMetres(model, road.id, pairs),
      );
      // Lng/lat paths for the far-zoom congestion overlay: converted once per
      // model, so the per-frame cost is only the pressure walk over vehicles.
      congestionRoadsRef.current = model.city.roads.map((road) => ({
        roadId: road.id,
        path: (model.directedPaths[road.id] ?? []).map(([x, y]) =>
          metricToLngLat(model.projection, x, y),
        ),
        widthM: widthMetresForRoad(model, road.id, pairs),
      }));
      networkSignalsRef.current = networkSignalMarkers(model);
    } else {
      laneOffsetsRef.current = null;
      congestionRoadsRef.current = [];
      networkSignalsRef.current = [];
    }
  }, [model, geo]);

  // Map lifecycle: created once, as soon as the frozen geography is loaded.
  useEffect(() => {
    const container = containerRef.current;
    const initialGeo = geoRef.current;
    const initialModel = modelRef.current;
    if (!container || !initialGeo || !initialModel) {
      return;
    }
    const projection = initialModel.projection;
    configureMapLibreWorker();
    const map = new MapLibreMap({
      container,
      style: buildStyle(initialGeo),
      center: metricToLngLat(projection, 1940, 1550),
      zoom: 15.5,
      minZoom: 12,
      maxZoom: 19.5,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    map.dragRotate.disable();
    const overlay = new MapLibreOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay as unknown as IControl);
    mapRef.current = map;
    overlayRef.current = overlay;
    zoomRef.current = map.getZoom();
    // Sprites are built once, never per frame.
    iconsRef.current = createVehicleSprites();
    controlSpritesRef.current = createControlSprites();
    destSpritesRef.current = createDestinationSprites();
    if (window.location.search.includes("debug")) {
      // Dev-only diagnostics (URL-gated).
      (window as unknown as { __jevMapInstance?: unknown }).__jevMapInstance = map;
      map.on("error", (event) => {
        const detail = (event as unknown as { error?: { message?: string } }).error;
        console.error("[maplibre-error]", detail?.message ?? String(event));
      });
    }

    const plates = new Map<string, Marker>();
    let plateKey = "";
    function syncPlates(entries: IncidentExtras["plates"]) {
      const nextKey = entries.map((entry) => `${entry.id}:${entry.label}`).join("|");
      if (nextKey === plateKey) {
        return;
      }
      plateKey = nextKey;
      const keep = new Set(entries.map((entry) => entry.id));
      for (const [id, marker] of plates) {
        if (!keep.has(id)) {
          marker.remove();
          plates.delete(id);
        }
      }
      for (const entry of entries) {
        const existing = plates.get(entry.id);
        if (existing) {
          existing.setLngLat(metricToLngLat(projection, entry.x, entry.y));
          continue;
        }
        const element = document.createElement("div");
        element.className = "jev-plate";
        const dot = document.createElement("span");
        dot.className = "jev-plate-dot";
        element.appendChild(dot);
        element.appendChild(document.createTextNode(entry.label));
        const marker = new Marker({ element, anchor: "bottom" })
          .setLngLat(metricToLngLat(projection, entry.x, entry.y))
          .addTo(map);
        plates.set(entry.id, marker);
      }
    }

    const onZoom = () => {
      zoomRef.current = map.getZoom();
    };
    map.on("zoom", onZoom);

    const handle: MapHandle = {
      flyToCentral: (options) => {
        // Enter City should immediately demonstrate the PRODUCT: roughly
        // four-to-seven blocks, legible vehicle classes and signal state. A
        // generic downtown fit was technically geographic but too zoomed out
        // to explain why this is a traffic simulator.
        const street = presetPose("street");
        map.easeTo({
          center: [street.center[0], street.center[1]],
          zoom: street.zoom,
          duration: options?.immediate ? 0 : 1350,
          easing: (t) => 1 - Math.pow(1 - t, 3),
        });
      },
      fitCity: (options) => {
        // The active road network, not every polygon and label anchor: the old
        // bounds reached east across the empty lake and left Chicago small in
        // the frame.
        map.fitBounds(cameraBoundsLngLat(initialModel, networkBounds(initialModel)), {
          padding: FIT_PADDING,
          duration: options?.immediate ? 0 : 1400,
          maxZoom: 17.4,
          easing: (t) => 1 - Math.pow(1 - t, 3),
        });
      },
      zoomIn: () => {
        map.zoomTo(map.getZoom() + 1, { duration: 320 });
      },
      zoomOut: () => {
        map.zoomTo(map.getZoom() - 1, { duration: 320 });
      },
      getZoom: () => map.getZoom(),
      followEgo: () => {
        // Resume following immediately: switch state on, then ease the camera
        // back to the car once, so the user sees where it went instead of a
        // teleport. Per-frame tracking takes over when the ease ends.
        followRef.current = enableFollow(followRef.current);
        useUiStore.getState().setFollowing(true);
        const ego = lastEgoMetricRef.current;
        easeGuardUntilRef.current = performance.now() + FOLLOW_SCALE.recenterEaseMs;
        if (ego) {
          map.easeTo({
            center: metricToLngLat(projection, ego.x, ego.y),
            bearing: 0,
            pitch: 0,
            duration: FOLLOW_SCALE.recenterEaseMs,
            easing: (t) => 1 - Math.pow(1 - t, 3),
          });
        }
      },
      isFollowing: () => followRef.current.following,
    };

    // Manual pan is the user taking the camera: follow yields at once and the
    // chrome offers Recenter. Zoom is NOT a takeover — zooming while following
    // is how the route gets inspected — so no zoom listener here.
    //
    // The rule is enforced from the raw pointer stream on the map canvas, not
    // only from MapLibre's gesture events: the intent is "the user dragged the
    // map", and that must hold regardless of how the library reports drags.
    const onUserDrag = () => {
      if (followRef.current.following) {
        followRef.current = disableFollow(followRef.current);
        useUiStore.getState().setFollowing(false);
      }
    };
    map.on("dragstart", onUserDrag);
    const canvasContainer = map.getCanvasContainer();
    let pointerOrigin: { x: number; y: number } | null = null;
    const onPointerDown = (event: PointerEvent) => {
      pointerOrigin = { x: event.clientX, y: event.clientY };
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!pointerOrigin) {
        return;
      }
      if (Math.hypot(event.clientX - pointerOrigin.x, event.clientY - pointerOrigin.y) < 5) {
        return;
      }
      pointerOrigin = null;
      onUserDrag();
    };
    const onPointerUp = () => {
      pointerOrigin = null;
    };
    canvasContainer.addEventListener("pointerdown", onPointerDown);
    canvasContainer.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);

    map.on("load", () => {
      // The landing is a composed view — the river meeting the Loop — not a
      // generic fitBounds over everything the city happens to contain.
      const hero = presetPose("hero");
      map.jumpTo({ center: [hero.center[0], hero.center[1]], zoom: hero.zoom });
      if (window.location.search.includes("debug")) {
        // Dev-only camera inspection hook (never rendered, URL-gated).
        (window as unknown as { __jevMap?: unknown }).__jevMap = {
          getZoom: () => map.getZoom(),
          getCenter: () => map.getCenter(),
          fitCity: () => handle.fitCity({ immediate: true }),
          /** Dev-only: the vehicle sprite atlas, for inspecting the artwork. */
          spriteAtlas: () => iconsRef.current?.atlas ?? null,
          /**
           * Dev-only: the last rendered vehicle frame, so motion can be
           * measured (step size, heading change) instead of eyeballed.
           */
          vehicles: () => frameRef.current,
          flyToCentral: () => handle.flyToCentral({ immediate: true }),
          /**
           * Dev-only: centre the camera on the first active incident plate, so a
           * screenshot can show the incident the app actually chose rather than
           * wherever the camera happened to be. Never rendered, URL-gated.
           */
          focusIncident: (zoom = 16.4, index = 0) => {
            const plates = platesRef.current;
            // Negative index counts back from the newest incident, so a capture
            // can target the one it just triggered rather than an older one
            // that is still active.
            const plate = index < 0 ? plates[plates.length + index] : plates[index];
            if (!plate) {
              return false;
            }
            map.stop();
            map.jumpTo({
              center: metricToLngLat(projection, plate.x, plate.y),
              zoom,
            });
            return true;
          },
          /**
           * Dev-only: centre the camera on the active crash. A crash has no DOM
           * plate, so focusIncident cannot frame one — which is why the crash
           * shot was previously taken wherever the camera happened to be.
           */
          focusCrash: (zoom = 16.6) => {
            const crash = crashRef.current;
            if (!crash) {
              return false;
            }
            map.stop();
            map.jumpTo({
              center: metricToLngLat(projection, crash.x, crash.y),
              zoom,
            });
            return true;
          },
        };
      }
      onHandle?.(handle);
    });

    let raf = 0;
    const render = (now: number) => {
      const buffer = frames.current;
      const activeMap = mapRef.current;
      if (buffer && activeMap && buffer.model && buffer.paths) {
        // Draw time is a SMOOTHED position between the two frames, not the raw
        // arrival-based alpha. Frame arrivals jitter with the worker's tick
        // (measured p95 ~205 ms against a 100 ms nominal), and a raw alpha
        // saturates at 1 on every late frame — a frozen world that snaps
        // forward. The render clock follows the frame clock through a short
        // low-pass in simulated time, so every downstream consumer (ego, route
        // trim, contextual controls, queue packing) smooths together and stays
        // on its road.
        const currentFrame = buffer.current;
        if (!currentFrame) {
          raf = requestAnimationFrame(render);
          return;
        }
        const frameAlphaValue = frameAlpha(now, buffer.currentReceivedAtMs, EXPECTED_FRAME_INTERVAL_MS);
        const previousTime = buffer.previous?.timeMs ?? currentFrame.timeMs;
        const currentTime = currentFrame.timeMs;
        const targetClock = previousTime + frameAlphaValue * (currentTime - previousTime);
        const lastNow = renderClockNowRef.current;
        renderClockNowRef.current = now;
        const renderDtMs = Number.isFinite(lastNow) ? now - lastNow : 0;
        const clock = smoothRenderClock(
          renderClockRef.current,
          targetClock,
          renderDtMs,
          Math.max(1, currentTime - previousTime),
        );
        renderClockRef.current = clock;
        const alpha =
          currentTime > previousTime ? clamp01((clock - previousTime) / (currentTime - previousTime)) : frameAlphaValue;
        // One vehicle in the frame now: the ego. Background traffic reaches the
        // map only as sparse road aggregates. Route/control presentation uses
        // the SAME display-time progress as the visible car, otherwise a smooth
        // car would drag a 5 Hz route/light behind it.
        const displayEgoProgress = interpolateEgoRoadProgress(
          buffer.previous,
          buffer.current,
          alpha,
          buffer.paths,
        );
        const progress = new Map<number, number>();
        if (buffer.current?.ego && displayEgoProgress) {
          progress.set(buffer.current.ego.id, displayEgoProgress.progress);
        }
        const laneOffsets = laneOffsetsRef.current ?? [];
        const interpolated = buffer.current
          ? interpolateVehicles(buffer.paths, buffer.previous, buffer.current, alpha, {
              nowMs: now,
              receivedAtMs: buffer.currentReceivedAtMs,
              laneOffsets,
              city: buffer.model.city,
            })
          : [];
        // Presentation-only queue packing: same simulation state, same pixels.
        const signalClamped = buffer.current
          ? clampVehiclesAtSignals(
              buffer.model.city,
              buffer.paths,
              laneOffsets,
              interpolated,
              (id) => progress.get(id) ?? 0,
              buffer.current.routeControls,
            )
          : [];
        const vehicles = buffer.current
          ? packQueues(
              buffer.model.city,
              buffer.paths,
              laneOffsets,
              signalClamped,
              (id) => progress.get(id) ?? 0,
            )
          : [];
        // Every rendered position now comes directly from a road path, a bounded
        // junction turn, or queue packing on that same road. Do not "settle"
        // positions with a free-space x/y lerp: that smoothing can leave the
        // carriageway on curves and was the source of drifting vehicles.
        const settled = vehicles;
        if (window.location.search.includes("debug")) {
          frameRef.current = settled.map((vehicle) => ({
            id: vehicle.id,
            roadId: vehicle.roadId,
            x: vehicle.x,
            y: vehicle.y,
            headingRadians: vehicle.headingRadians,
            blockedWaitMs: vehicle.blockedWaitMs,
          }));
        }
        // ---- Route-first presentation (Issue #25) -----------------------
        // The route comes from the frame's trip payload, which the worker
        // rebuilds from the vehicle's own route — so a reroute repaints here
        // immediately and the curated trip's original roads are never reused.
        const snapshot = buffer.current;
        let segments: RouteSegment[] = [];
        let destination: { x: number; y: number; completed: boolean } | null = null;
        const egoRendered = settled[0] ?? null;
        if (snapshot?.trip) {
          segments = buildRouteSegments(
            buffer.model,
            snapshot.trip,
            // Progress comes from the frame's ego (the rendered vehicle carries
            // display geometry only); roadId decides whether to trim.
            displayEgoProgress,
            classifySnapshotRoads(snapshot),
          );
          const destinationNode = buffer.model.city.intersections[snapshot.trip.destinationIntersectionId];
          if (destinationNode) {
            destination = {
              x: destinationNode.x,
              y: destinationNode.y,
              completed: snapshot.trip.completed,
            };
          }
        }
        routeSegmentsRef.current = segments;

        // Whole-city traffic remains visible at every challenge zoom. Hide it
        // only under the BLUE route that is actually still visible. Roads the
        // ego already drove immediately return to the city traffic layer rather
        // than leaving a permanent traffic-free hole behind the car.
        const visibleRouteRoadIds = liveRef.current
          ? new Set(segments.map((segment) => segment.roadId))
          : new Set<number>();
        const congestion =
          !trafficHiddenRef.current && buffer.current
            ? buildCongestionLayers(
                congestionRoadsRef.current ?? [],
                roadPressure(buffer.current).filter(
                  (entry) => !visibleRouteRoadIds.has(entry.roadId),
                ),
                zoomRef.current,
              )
            : [];
        // Contextual controls, derived from the CURRENT route so a reroute
        // swaps them automatically and a passed control retires at once.
        const controls = deriveContextualControls({
          model: buffer.model,
          indexes: buffer.paths,
          laneOffsets,
          trip: snapshot?.trip ?? null,
          ego: displayEgoProgress,
          routeControls: snapshot?.routeControls ?? [],
        });
        controlsRef.current = controls;
        const contextualIntersectionIds = liveRef.current
          ? new Set(controls.map((control) => control.intersectionId))
          : new Set<number>();
        const quietNetworkSignals = networkSignalsRef.current.filter(
          (marker) => !contextualIntersectionIds.has(marker.intersectionId),
        );
        routeMixRef.current = routeTrafficMix(segments);
        lastEgoMetricRef.current = egoRendered
          ? { x: egoRendered.x, y: egoRendered.y, headingRadians: egoRendered.headingRadians }
          : null;

        // Follow camera: driven by the INTERPOLATED on-screen car (60 Hz), not
        // the 5 Hz worker snapshot, and north-up. A camera ease in flight wins
        // the frame; once it ends, per-frame tracking resumes silently.
        const dtMs = lastRenderAtRef.current > 0 ? Math.min(250, now - lastRenderAtRef.current) : 16;
        lastRenderAtRef.current = now;
        const follow = advanceFollow(followRef.current, lastEgoMetricRef.current, dtMs);
        followRef.current = follow.state;
        if (follow.target && followRef.current.following && now >= easeGuardUntilRef.current) {
          activeMap.jumpTo({
            center: metricToLngLat(projection, follow.target[0], follow.target[1]),
            bearing: 0,
            pitch: 0,
          });
        }

        const incidents = buildIncidentLayers(buffer.current, buffer.model);
        // `?notraffic=1` hides every traffic primitive so the basemap can be
        // reviewed on its own. Dev-only, never rendered, like the camera hook.
        const networkTrafficLayers: Layer[] = trafficHiddenRef.current
          ? []
          : [
              // Traffic mode is visible even before the user enters a trip.
              // This is deliberate proof that the challenge sits on top of a
              // live citywide system rather than animating one private route.
              ...congestion,
              // Hazards belong to the city traffic system too. Keep their
              // geographic markers visible during landing/config preview so
              // the map can show "traffic + incidents" before the ego route
              // becomes the foreground experience.
              ...incidents.layers,
            ];
        const networkSignalLayers: Layer[] = trafficHiddenRef.current
          ? []
          : buildNetworkSignalLayers(
              projection,
              quietNetworkSignals,
              controlSpritesRef.current,
              zoomRef.current,
            );
        const routeLayers: Layer[] =
          trafficHiddenRef.current || !liveRef.current
            ? []
            : buildRouteLayers(segments);
        const challengeTopLayers: Layer[] =
          trafficHiddenRef.current || !liveRef.current
            ? []
            : [
                ...buildDestinationLayers(projection, destination, destSpritesRef.current),
                ...buildVehicleLayers(
                  projection,
                  settled,
                  iconsRef.current ?? createVehicleSprites() ?? EMPTY_ICONS,
                  zoomRef.current,
                ),
                // Contextual controls take over from the tiny network marker as
                // the ego approaches, then retire back to network scale.
                ...buildControlLayers(projection, controls, controlSpritesRef.current),
              ];

        // Layer order is intentional. Traffic + hazards sit on the road network;
        // the blue route sits above that system; tiny citywide signal
        // infrastructure remains visible until its contextual replacement takes
        // over; the ego and relevant live control own the top hierarchy.
        const layers: Layer[] = [
          ...networkTrafficLayers,
          ...routeLayers,
          ...networkSignalLayers,
          ...challengeTopLayers,
        ];
        overlayRef.current?.setProps({ layers });

        // Keep verbose incident plates out of onboarding so the setup remains
        // calm, but retain the actual crash/closure/event geometry underneath.
        const showIncidentLabels = liveRef.current && !trafficHiddenRef.current;
        const visiblePlates = showIncidentLabels ? incidents.extras.plates : [];
        platesRef.current = visiblePlates;
        crashRef.current = !trafficHiddenRef.current ? incidents.extras.crash : null;
        syncPlates(visiblePlates);
        if (window.location.search.includes("debug")) {
          const buckets = [0, 0, 0, 0, 0];
          for (const vehicle of settled) {
            buckets[waitHeatBucket(vehicle.blockedWaitMs)] += 1;
          }
          const hotspots = [...vehicles]
            .sort((a, b) => b.blockedWaitMs - a.blockedWaitMs)
            .slice(0, 8)
            .map((vehicle) => ({
              x: Math.round(vehicle.x),
              y: Math.round(vehicle.y),
              waitMs: Math.round(vehicle.blockedWaitMs),
            }));
          // Challenge diagnostics (Issue #24): there is no fleet in the frame
          // any more, so report the ego and the road state that replaced it.
          const ego = buffer.current?.ego ?? null;
          const trip = buffer.current?.trip ?? null;
          const upcoming = upcomingControl(controls);
          (window as unknown as { __jevLayers?: unknown }).__jevLayers = {
            hottest: hotspots[0] ?? null,
            hotspots,
            renderedVehicles: vehicles.length,
            egoVehicleId: ego?.id ?? null,
            egoState: ego?.state ?? null,
            egoBlockedWaitMs: ego ? Math.round(ego.blockedWaitMs) : null,
            tripId: trip?.tripId ?? null,
            tripRouteLength: trip?.routeRoadIds.length ?? 0,
            tripRouteIndex: trip?.routeIndex ?? 0,
            tripCompleted: trip?.completed ?? null,
            roadTrafficEntries: buffer.current?.roadTraffic.length ?? 0,
            occupiedRoadsWithQueues:
              buffer.current?.roadTraffic.filter((road) => road.queuedCount > 0).length ?? 0,
            routeControls: buffer.current?.routeControls.length ?? 0,
            // Contextual controls (Issue #26): the ego's near-term road
            // controls, never the citywide signal forest.
            visibleControlCount: controls.length,
            upcomingControlKind: upcoming?.kind ?? null,
            upcomingControlIntersectionId: upcoming?.intersectionId ?? null,
            upcomingControlDistanceM: upcoming ? Math.round(upcoming.distanceAheadM) : null,
            upcomingControlProminence: upcoming?.prominence ?? null,
            upcomingSignalStage: upcoming?.signal?.stage ?? null,
            egoApproachPermitted: upcoming?.signal?.egoApproachPermitted ?? null,
            routeSegments: segments.length,
            routeMix: routeMixRef.current,
            routeTrafficByRoad: segments.slice(0, 12).map((segment) => `${segment.roadId}:${segment.traffic}`),
            destination: destination ? { x: Math.round(destination.x), y: Math.round(destination.y), completed: destination.completed } : null,
            following: followRef.current.following,
            cameraCenter: [Math.round(mapRef.current?.getCenter().lng ?? 0), Math.round(mapRef.current?.getCenter().lat ?? 0)],
            snapshotBytes: buffer.current ? JSON.stringify(buffer.current).length : 0,
            layerIds: layers.map((layer) => layer.id),
            // Controls hide themselves when the atlas is missing rather than
            // falling back to a coloured dot, so debug reports it explicitly.
            controlSprites: controlSpritesRef.current ? "ok" : "missing",
            waitBuckets: buckets,
            maxWaitMs: vehicles.reduce(
              (max, vehicle) => Math.max(max, vehicle.blockedWaitMs),
              0,
            ),
            types: vehicles.reduce<Record<string, number>>((counts, vehicle) => {
              counts[vehicle.type] = (counts[vehicle.type] ?? 0) + 1;
              return counts;
            }, {}),
          };
        }
      }
      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      map.off("zoom", onZoom);
      map.off("dragstart", onUserDrag);
      canvasContainer.removeEventListener("pointerdown", onPointerDown);
      canvasContainer.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      plates.forEach((marker) => marker.remove());
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // `ready` is the async-geography gate: the effect must re-run when the
    // model first arrives, and only then.
  }, [frames, onHandle, ready]);

  // Route-first focus (Issue #25): while a trip is live, the basemap roads
  // step back so the ego's route is the dominant object. Leaving the city
  // restores the authored cartography exactly.
  useEffect(() => {
    const map = mapRef.current;
    followRef.current = live ? enableFollow(followRef.current) : disableFollow(followRef.current);
    useUiStore.getState().setFollowing(live);
    if (map) {
      // Enter City's flight owns the camera for a moment; following takes over
      // when it lands rather than cutting it off mid-ease.
      easeGuardUntilRef.current = live ? performance.now() + 1_600 : 0;
      const apply = () => applyRoadFocus(map, live);
      if (map.isStyleLoaded()) {
        apply();
      } else {
        map.once("load", apply);
      }
    }
  }, [live, ready]);

  // Scale changes: swap the local GeoJSON sources; geography is nested.
  useEffect(() => {
    const map = mapRef.current;
    const current = geoRef.current;
    if (!map || !current) {
      return;
    }
    const apply = () => {
      const setData = (id: string, data: unknown) => {
        const source = map.getSource(id) as GeoJSONSource | undefined;
        source?.setData(data as never);
      };
      setData("land", current.land);
      setData("blocks", current.blocks);
      setData("water", current.water);
      setData("parks", current.parks);
      setData("roads-local", current.roadsLocal);
      setData("roads-arterial", current.roadsArterial);
      setData("roads-highway", current.roadsHighway);
      setData("bridges", current.bridges);
      setData("labels", current.labels);
      setData("street-labels", current.streetLabels);
    };
    if (map.isStyleLoaded()) {
      apply();
    } else {
      map.once("load", apply);
    }
  }, [geo]);

  // Interaction follows the onboarding phase: the map is scenery until live.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    if (live) {
      map.dragPan.enable();
      map.scrollZoom.enable();
      map.doubleClickZoom.enable();
      map.touchZoomRotate.enable();
    } else {
      map.dragPan.disable();
      map.scrollZoom.disable();
      map.doubleClickZoom.disable();
      map.touchZoomRotate.disable();
    }
  }, [live]);

  return (
    <>
      <div
        ref={containerRef}
        className="absolute inset-0 h-full w-full"
        aria-label="Chicago map"
      />
      {/*
        Required attribution: the browser geography is derived from
        OpenStreetMap. Small, in a map corner, never hidden behind settings.
      */}
      <div className="pointer-events-none absolute right-2 top-2 z-10">
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          className="pointer-events-auto text-[10px] leading-none text-ink-38 on-map-soft transition-colors hover:text-ink-70"
        >
          © OpenStreetMap contributors
        </a>
      </div>
      {loadError !== null && (
        <div className="surface-overlay absolute left-1/2 top-1/2 z-20 -translate-x-1/2 -translate-y-1/2 px-4 py-3">
          <span className="text-meta text-ink-70">Map data failed to load: {loadError}</span>
        </div>
      )}
    </>
  );
}

const EMPTY_ICONS: VehicleIconSet = {
  atlas: "",
  mapping: {
    car: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: true },
    truck: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: true },
    bicycle: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: true },
  },
};
