"use client";

/**
 * CityMap (Task 11 polish pass): the product's map surface.
 *
 * MapLibre GL renders the static showcase geography from LOCAL in-memory
 * GeoJSON (no tiles, no external basemap, no attribution) and owns the camera
 * (pan / wheel zoom / pinch / double-click). deck.gl (via MapLibreOverlay)
 * draws the dynamic layers — the ego, the control it is about to meet, road
 * traffic state and incident overlays — from the bounded per-tick presentation
 * snapshots, interpolated to display rate in one rAF loop.
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
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { setFrameModel } from "./frame-buffer";
import { lngLatToMetric, metricToLngLat, type MapModel } from "@/cities/map-model";
import {
  frameAlpha,
  interpolateEgoRoadProgress,
  interpolateVehicles,
} from "@/render/interpolate";
import {
  carriagewayPairs,
  laneCentreOffsetMetres,
  widthMetresForRoad,
} from "@/render/road-presentation";
import { roadPressure } from "@/render/congestion";
import {
  boundsLngLat as cameraBoundsLngLat,
  clampToBounds,
  FIT_PADDING,
  maxPanBounds,
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
import { buildControlLayers, controlSpriteFor } from "@/render/control-layers";
import { deriveControlTile, sameControlTile, type ControlTileState } from "@/render/control-tile";
import { ControlTile } from "./ControlTile";
import { SIM_TICK_MS } from "@/worker/protocol";
import { canApproachProceedForPhase, deriveApproachGroups } from "@/sim/signals";
import type { FrameBuffer } from "./frame-buffer";

/**
 * The worker posts exactly one frame per real tick (see the worker's runTick),
 * so this must be SIM_TICK_MS alone. Scaling it by SNAPSHOT_EVERY_TICKS made
 * alpha crawl to a fraction of its range before the next frame arrived, and
 * every arrival snapped the world forward — the stutter.
 */
const EXPECTED_FRAME_INTERVAL_MS = SIM_TICK_MS;

/**
 * Time constant for the arrival-interval estimate, in wall milliseconds.
 *
 * Long on purpose: the window must follow the producer's real cadence without
 * chasing a single outlier tick.
 */
const ARRIVAL_INTERVAL_TAU_MS = 120;

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
  /** Latest incident plate positions (metric), for the dev camera helper. */
  const platesRef = useRef<readonly { x: number; y: number; label: string }[]>([]);
  /** Metric anchor of the active crash, for the dev camera hook. */
  const crashRef = useRef<{ x: number; y: number } | null>(null);
  /** Last rendered frame, for the dev motion-QA hook. */
  const frameRef = useRef<
    { id: number; roadId: number | null; x: number; y: number; headingRadians: number; blockedWaitMs: number }[]
  >([]);
  const destSpritesRef = useRef<DestinationSpriteSet | null>(null);
  /** Alpha actually used for the last drawn frame (QA/debug readout). */
  const alphaRef = useRef<number>(1);
  /** Wall-clock arrival interval, low-passed. The render window follows it. */
  const expectedIntervalRef = useRef<number>(EXPECTED_FRAME_INTERVAL_MS);
  const lastArrivalRef = useRef<number>(Number.NaN);
  /** Recent arrival gaps, so QA can read the real cadence in one sample. */
  const arrivalGapsRef = useRef<number[]>([]);
  /** Follow camera state; north-up, driven by the interpolated car. */
  const followRef = useRef<FollowState>(createFollowState());
  /** While a camera ease owns the frame (enter-city flight, recenter). */
  const easeGuardUntilRef = useRef(0);
  const lastRenderAtRef = useRef(0);
  const routeSegmentsRef = useRef<RouteSegment[]>([]);
  /** Controls the ego is about to meet this frame (at most a couple). */
  const controlsRef = useRef<ContextualControl[]>([]);
  /**
   * The compact top-right control tile (Issue #46). Derived from the SAME
   * controls as the roadside marker, and pushed into React state only when the
   * tile would actually change (a handful of times per trip) — the render loop
   * is not allowed to rerender the component tree per frame.
   */
  const [controlTile, setControlTile] = useState<ControlTileState | null>(null);
  const controlTileRef = useRef<ControlTileState | null>(null);
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
  const [loadAttempt, setLoadAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    loadChicagoCity(scaleIndex)
      .then((loaded) => {
        if (!cancelled) {
          if (frames.current.model === null) {
            setFrameModel(frames.current, loaded, buildDirectedPathIndexes(loaded));
          }
          setModel(loaded);
          setLoadError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadError("Chicago map data is temporarily unavailable.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [scaleIndex, loadAttempt, frames]);

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
    } else {
      laneOffsetsRef.current = null;
      congestionRoadsRef.current = [];
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
    // Soft pan boundary: the camera centre is confined to the network box grown
    // by MAX_PAN_PADDING_FRACTION, so a drag can look past the city edge for
    // context but cannot leave the map behind. Deliberately NOT MapLibre's
    // maxBounds: that also constrains zoom-out (measured: a 25%-padded box
    // pinned the map at zoom 13.09 and put the app's own minZoom 12 out of
    // reach). Read through the refs so a scale change re-boxes the same map.
    map.on("move", () => {
      const active = modelRef.current;
      if (!active) {
        return;
      }
      const center = map.getCenter();
      const [x, y] = lngLatToMetric(active.projection, center.lng, center.lat);
      const [clampedX, clampedY] = clampToBounds(maxPanBounds(active), x, y);
      if (clampedX !== x || clampedY !== y) {
        map.setCenter(metricToLngLat(active.projection, clampedX, clampedY));
      }
    });
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

    /**
     * Hand the camera to an animation for its own duration.
     *
     * Per-frame follow tracking uses `jumpTo`, and `jumpTo` stops whatever
     * animation is running. Without this, the Enter City flight was cut off
     * part-way (measured: it landed at zoom 14.86 instead of the street preset's
     * 15.4, and stayed there for the whole trip), and a user's zoom-out while
     * following was cancelled on the next frame. Extending by `Math.max` means a
     * later, shorter request can never shorten an earlier, longer one.
     */
    const ownCameraFor = (durationMs: number) => {
      easeGuardUntilRef.current = Math.max(
        easeGuardUntilRef.current,
        performance.now() + durationMs + 120,
      );
    };

    const handle: MapHandle = {
      flyToCentral: (options) => {
        // Enter City should immediately demonstrate the PRODUCT: roughly
        // four-to-seven blocks, legible vehicle classes and signal state. A
        // generic downtown fit was technically geographic but too zoomed out
        // to explain why this is a traffic simulator.
        const street = presetPose("street");
        const duration = options?.immediate ? 0 : 1350;
        ownCameraFor(duration);
        map.easeTo({
          center: [street.center[0], street.center[1]],
          zoom: street.zoom,
          duration,
          easing: (t) => 1 - Math.pow(1 - t, 3),
        });
      },
      fitCity: (options) => {
        // The active road network, not every polygon and label anchor: the old
        // bounds reached east across the empty lake and left Chicago small in
        // the frame.
        const duration = options?.immediate ? 0 : 1400;
        ownCameraFor(duration);
        map.fitBounds(cameraBoundsLngLat(initialModel, networkBounds(initialModel)), {
          padding: FIT_PADDING,
          duration,
          maxZoom: 17.4,
          easing: (t) => 1 - Math.pow(1 - t, 3),
        });
      },
      zoomIn: () => {
        ownCameraFor(320);
        map.zoomTo(map.getZoom() + 1, { duration: 320 });
      },
      zoomOut: () => {
        ownCameraFor(320);
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
        ownCameraFor(FOLLOW_SCALE.recenterEaseMs);
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
      // Deliberately no "frame the whole trip" move on arrival: measured, it
      // pulled the result back to zoom 13.6 - a city-wide view over mostly lake,
      // which read as the map losing the thread rather than as a finish. The
      // camera stays with the car; the result card takes the middle.
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
        // Draw time is the phase between the two most recent frames, taken
        // straight from wall time.
        //
        // Frame arrivals jitter with the worker's tick (measured p95 ~130 ms
        // against a 100 ms nominal), so the WINDOW must follow the real cadence —
        // that is what expectedIntervalRef is. The PHASE inside it must not be
        // smoothed: a low-pass of the frame clock lags a ramp by `rate x tau`,
        // and the rate is the playback compression, so at 8x the clock sat ~560
        // simulated ms behind an 800 ms window. The phase then pinned at 0 for
        // most of every window (measured: 56% of display frames showed ZERO
        // motion) and jumped 7-9 m at each arrival. Every consumer of this value
        // (ego, route trim, contextual controls) reads the same phase, so they
        // move together and every position still comes from a road path.
        const currentFrame = buffer.current;
        if (!currentFrame) {
          raf = requestAnimationFrame(render);
          return;
        }
        // MEASURE the arrival cadence; do not assume it.
        //
        // Frames are posted once per worker tick, and a tick that runs long
        // delivers late - measured p95 ~205 ms against the 100 ms nominal. With a
        // fixed 100 ms window the alpha pinned at 1 on every late frame, so the
        // render clock reached the current frame and then STOPPED until the next
        // frame landed: the car froze, then jumped, once per tick. That
        // freeze-and-snap is what "the animation is jittery" looks like. The
        // window now follows the real cadence through a slow low-pass, so alpha
        // arrives at 1 exactly as the next frame arrives and the motion is
        // continuous.
        const arrival = buffer.currentReceivedAtMs;
        if (arrival !== lastArrivalRef.current) {
          const previousArrival = lastArrivalRef.current;
          lastArrivalRef.current = arrival;
          if (Number.isFinite(previousArrival)) {
            const gap = arrival - previousArrival;
            if (gap > 5 && gap < 2000) {
              const k = 1 - Math.exp(-gap / ARRIVAL_INTERVAL_TAU_MS);
              expectedIntervalRef.current += (gap - expectedIntervalRef.current) * k;
              arrivalGapsRef.current.push(gap);
              if (arrivalGapsRef.current.length > 60) {
                arrivalGapsRef.current.shift();
              }
            }
          }
        }
        const alpha = frameAlpha(now, arrival, expectedIntervalRef.current);
        alphaRef.current = alpha;
        const previousTime = buffer.previous?.timeMs ?? currentFrame.timeMs;
        const currentTime = currentFrame.timeMs;
        // The simulated time the screen is showing (between the two frames).
        // Debug readout only: the render loop no longer carries clock state.
        const displaySimMs = previousTime + alpha * (currentTime - previousTime);
        // One vehicle in the frame now: the ego. Background traffic reaches the
        // map only as sparse road aggregates. Route/control presentation uses
        // the SAME display-time progress as the visible car, otherwise a smooth
        // car would drag a snapshot-cadence route/light behind it.
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
        // The stop-line clamp that used to run here is GONE (issue #56).
        //
        // It re-placed any vehicle whose APPROACH was not permitted onto the
        // painted stop line, comparing the raw interpolated progress against it.
        // The interpolation now warps the final approach so the simulation's node
        // maps onto the line by construction, which makes the clamp redundant for
        // queued cars and actively wrong for moving ones: a car crossing on a
        // phase change was yanked several metres backwards mid-motion. One
        // mechanism, in one place, with a continuous derivative.
        // The followed car is NOT queue-packed.
        //
        // Packing exists to make a queue read as one object: it re-places each
        // queued vehicle on its packed slot. Applied to the hero, that is a hop
        // of several metres the moment it becomes queued — measured at 8-10 m in
        // a single frame, i.e. the car the user is watching jumps at every red
        // light. The protagonist is the one vehicle whose position must be the
        // simulation's own, so it keeps the authoritative progress (already
        // corrected to the rendered stop line by the interpolation's own
        // stop-line warp, so nothing else may move it.
        // ONE vehicle is drawn on this map: the simulation's own protagonist.
        const vehicles = interpolated;
        // Every rendered position now comes directly from a road path, a bounded
        // junction turn, or queue packing on that same road. Do not "settle"
        // positions with a free-space x/y lerp: that smoothing can leave the
        // carriageway on curves and was the source of drifting vehicles.
        const settled = vehicles;
        // One car, one route, and the road colours underneath: the city's own
        // congestion overlay carries the traffic story. A synthesised fleet of
        // sprites was tried and removed - at 6 000+ sprites it read as grey
        // confetti, and its cars sat on parks, water and each other because a
        // per-road count is not a set of vehicle positions.
        const fleet = settled;
        // Debug-only readout of what the renderer is actually working with:
        // how many sprites the fleet synthesised, and what the zoom grammar is
        // allowing through. `?debug` is the product's own debug path.
        if (window.location.search.includes("debug")) {
          (window as unknown as { __cityDebug?: unknown }).__cityDebug = {
            zoom: Number(zoomRef.current.toFixed(2)),
            live: liveRef.current,
            trafficHidden: trafficHiddenRef.current,
            egoRoad: buffer.current?.ego?.roadId ?? null,
            occupiedRoads: buffer.current?.roadTraffic.length ?? 0,
            fleet: fleet.length,
            // The rendered hero, not the simulation's idea of it: this is what a
            // QA pass can measure against the road path (lateral offset, nose vs
            // motion) without instrumenting the render loop.
            egoScreen:
              settled[0] && mapRef.current
                ? (() => {
                    const point = mapRef.current!.project(
                      metricToLngLat(
                        modelRef.current!.projection,
                        settled[0]!.x,
                        settled[0]!.y,
                      ),
                    );
                    return [Math.round(point.x), Math.round(point.y)];
                  })()
                : null,
            egoProgress: buffer.current?.ego?.progress ?? null,
            egoRoadId: buffer.current?.ego?.roadId ?? null,
            tripCompleted: buffer.current?.trip?.completed ?? null,
            egoId: buffer.current?.ego?.id ?? null,
            egoSpeed: buffer.current?.ego?.speed ?? null,
            // Motion root-cause instrumentation (issue #56): the frame's own
            // numbers, so a probe can attribute a rendered step to the stop-line
            // residual rather than guessing at it.
            egoRoadLength:
              buffer.current?.ego && buffer.current.ego.roadId !== null
                ? (buffer.model.city.roads[buffer.current.ego.roadId]?.length ?? null)
                : null,
            egoRoadKind:
              buffer.current?.ego && buffer.current.ego.roadId !== null
                ? (buffer.model.city.roads[buffer.current.ego.roadId]?.kind ?? null)
                : null,
            egoPermitted: (() => {
              const ego = buffer.current?.ego;
              if (!ego || ego.roadId === null) return null;
              const road = buffer.model.city.roads[ego.roadId];
              if (!road) return null;
              const signal = buffer.current?.routeControls.find(
                (control) => control.intersectionId === road.to,
              );
              if (!signal) return null;
              const groups = deriveApproachGroups(buffer.model.city, road.to);
              if (groups.length === 0) return null;
              return canApproachProceedForPhase(
                groups,
                signal.stage,
                ((signal.phaseIndex % groups.length) + groups.length) % groups.length,
                ego.roadId,
              );
            })(),
            controlCount: controlsRef.current.length,
            // Classification for the highway-control audit: what is on screen,
            // how far ahead, whether it is retiring behind the car, and how much
            // of the ego's own road remains. A control that lies ON the ego's own
            // road while that road is expressway-class is the bogus case.
            controlDetails: controlsRef.current.map((control) => ({
              id: control.intersectionId,
              kind: control.kind,
              d: Number(control.distanceAheadM.toFixed(1)),
              life: control.lifecycle,
              prom: control.prominence,
            })),
            egoRemainingM:
              buffer.current?.ego && buffer.current.ego.roadId !== null
                ? (() => {
                    const road = buffer.model.city.roads[buffer.current!.ego!.roadId!];
                    return road ? Number((road.length - buffer.current!.ego!.progress).toFixed(1)) : null;
                  })()
                : null,
            pxPerMetre: mapRef.current
              ? (() => {
                  const projection = modelRef.current!.projection;
                  const a = mapRef.current!.project(metricToLngLat(projection, 0, 0));
                  const b = mapRef.current!.project(metricToLngLat(projection, 100, 0));
                  return Number((Math.hypot(b.x - a.x, b.y - a.y) / 100).toFixed(4));
                })()
              : null,
            // Render-clock state: the QA surface for animation smoothness. A
            // probe samples these per animation frame to see what the display
            // actually got, rather than inferring it from frame arrivals.
            receivedAtMs: buffer.currentReceivedAtMs,
            alpha: Number(alphaRef.current.toFixed(4)),
            displaySimMs: Number(displaySimMs.toFixed(1)),
            frameIntervalMs: Number(expectedIntervalRef.current.toFixed(1)),
            arrivalGapsMs: arrivalGapsRef.current.slice(-40),
            cameraCenter: [
              Number(mapRef.current!.getCenter().lng.toFixed(6)),
              Number(mapRef.current!.getCenter().lat.toFixed(6)),
            ],
            cameraZoom: Number(mapRef.current!.getZoom().toFixed(3)),
            ego: settled[0]
              ? [
                  Number(settled[0].x.toFixed(3)),
                  Number(settled[0].y.toFixed(3)),
                  Number(settled[0].headingRadians.toFixed(5)),
                ]
              : null,
          };
        }
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
          if (window.location.search.includes("debug")) {
            const counts = { free: 0, slowed: 0, congested: 0 };
            for (const segment of segments) counts[segment.traffic] += 1;
            const debugSink = window as unknown as {
              __cityDebug?: { route?: unknown; routeRoads?: unknown };
            };
            debugSink.__cityDebug!.route = counts;
            // The route's own roads, with the sim's severity and occupancy: this is
            // what decides whether the route band can ever show amber or red.
            const routeRoadIds = new Set(snapshot.trip.routeRoadIds);
            debugSink.__cityDebug!.routeRoads = (buffer.current?.roadTraffic ?? [])
              .filter((entry) => routeRoadIds.has(entry.roadId))
              .map((entry) => [
                entry.roadId,
                entry.severity,
                Number((entry.capacity > 0 ? entry.occupancy / entry.capacity : 0).toFixed(2)),
                entry.vehicleCount,
              ])
              .slice(0, 40);
          }
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

        // Whole-city traffic remains visible at every challenge zoom, route roads
        // included: excluding them is what kept the one road the user watches
        // permanently free of amber and red.
        const congestion =
          !trafficHiddenRef.current && buffer.current
            ? buildCongestionLayers(
                congestionRoadsRef.current ?? [],
                // Route roads are NOT excluded. They used to be, on the theory
                // that the route band carried its own traffic colour - but the
                // band renders "free" whenever the road's severity is not severe,
                // so the single road the user watches was the one road in the
                // city that could never show amber or red. The overlay is a
                // centre stripe and the band is 15 m wide, so both read.
                roadPressure(buffer.current),
                zoomRef.current,
              )
            : [];
        // Contextual controls, derived from the CURRENT route so a reroute
        // swaps them automatically and a passed control retires at once. These
        // are the ONLY controls the public map draws (issue #46): the citywide
        // signal network that used to sit underneath them is gone.
        const controls = deriveContextualControls({
          model: buffer.model,
          indexes: buffer.paths,
          laneOffsets,
          trip: snapshot?.trip ?? null,
          ego: displayEgoProgress,
          routeControls: snapshot?.routeControls ?? [],
        });
        controlsRef.current = controls;
        // The top-right tile is derived from those same controls, from the same
        // sprite decision the marker uses, so marker and tile always agree. It
        // exists only while a control is upcoming; once the ego passes one, the
        // tile for it is gone. React is updated only when the tile CHANGES, so
        // the frame loop stays render-free.
        const tile =
          liveRef.current && !trafficHiddenRef.current ? deriveControlTile(controls) : null;
        if (!sameControlTile(controlTileRef.current, tile)) {
          controlTileRef.current = tile;
          setControlTile(tile);
        }
        routeMixRef.current = routeTrafficMix(segments);
        lastEgoMetricRef.current = egoRendered
          ? { x: egoRendered.x, y: egoRendered.y, headingRadians: egoRendered.headingRadians }
          : null;

        // Follow camera: driven by the INTERPOLATED on-screen car (60 Hz), not
        // the worker snapshot cadence, and north-up. A camera ease in flight wins
        // the frame; once it ends, per-frame tracking resumes silently.
        const dtMs = lastRenderAtRef.current > 0 ? Math.min(250, now - lastRenderAtRef.current) : 16;
        lastRenderAtRef.current = now;
        const follow = advanceFollow(followRef.current, lastEgoMetricRef.current, dtMs);
        followRef.current = follow.state;
        // Never fight an animation. The guard covers the request's nominal
        // duration, but the main thread can be blocked for seconds while the
        // city model loads, which would let the guard expire while the ease is
        // still mid-flight — and jumpTo cancels eases, so the camera would freeze
        // wherever the interruption caught it (measured: Enter City landing at
        // zoom 14.76 instead of the street preset's 15.4, for the whole trip).
        if (
          follow.target &&
          followRef.current.following &&
          !buffer.current?.trip?.completed &&
          now >= easeGuardUntilRef.current &&
          // An animation in flight counts as "moving" in MapLibre, and while we
          // are following the only thing that can move the map is an animation we
          // started (a drag turns following off), so this is exactly the check we
          // need. It has to be `isMoving`: this build declares `isEasing` in its
          // types but does not expose it at runtime, so the guard silently did
          // nothing when it used that.
          !activeMap.isMoving()
        ) {
          if (window.location.search.includes("debug") && !(window as unknown as { __followOn?: boolean }).__followOn) {
            (window as unknown as { __followOn?: boolean }).__followOn = true;
          }
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
        const routeLayers: Layer[] =
          trafficHiddenRef.current || !liveRef.current
            ? []
            : buildRouteLayers(segments);
        const challengeTopLayers: Layer[] =
          trafficHiddenRef.current || !liveRef.current
            ? []
            : [
                ...buildDestinationLayers(projection, destination, destSpritesRef.current),
                // Contextual controls take over from the tiny network marker as
                // the ego approaches, then retire back to network scale.
                ...buildControlLayers(projection, controls, controlSpritesRef.current),
              ];

        // City traffic is NOT challenge chrome. The vehicles belong to the city
        // whether or not a challenge is running, so they are drawn from the
        // moment a frame exists — the title screen is the first look anybody gets
        // at this product, and it used to show a city with nothing on its roads.
        // Only ?notraffic=1 removes them. The zoom grammar still decides whether
        // individual vehicles are the right instrument at the current framing.
        const cityVehicleLayers: Layer[] =
          trafficHiddenRef.current || !buffer.current
            ? []
            : buildVehicleLayers(
                projection,
                fleet,
                iconsRef.current ?? createVehicleSprites() ?? EMPTY_ICONS,
                zoomRef.current,
                buffer.current.ego?.id ?? null,
              );

        // Layer order is intentional. Traffic + hazards sit on the road network;
        // the blue route sits above that system; the ego and the ONE relevant
        // live control own the top hierarchy. There is no citywide control
        // layer: the public map shows a control only where the ego is about to
        // meet one (issue #46).
        const layers: Layer[] = [
          ...routeLayers,
          // Congestion rides ABOVE the route band. The band is 15 m wide and
          // near-opaque, so with the old order a route road never showed the
          // amber/red pressure the rest of the city showed - the road the user
          // is actually watching was the one road with no traffic on it. The
          // overlay is a centre stripe (2-6 m), so the band still reads as the
          // route on both sides of it.
          ...networkTrafficLayers,
          ...challengeTopLayers,
          ...cityVehicleLayers,
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
            // The marker's own sprite and the tile's own state, side by side:
            // this is what lets a probe prove they agree instead of assuming it.
            upcomingControlSprite: upcoming ? controlSpriteFor(upcoming) : null,
            controlTile: controlTileRef.current,
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
      // when it lands rather than cutting it off mid-ease. `Math.max` keeps a
      // real flight's longer guard intact.
      easeGuardUntilRef.current = live
        ? Math.max(easeGuardUntilRef.current, performance.now() + 400)
        : 0;
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
        The ONE control surface in the live view (Issue #46): a compact tile in
        the top-right corner while a control ahead is relevant, showing the same
        authoritative state as the roadside marker. Nothing else in the chrome
        speaks about controls.
      */}
      <ControlTile state={controlTile} />
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
          <span className="text-meta text-ink-70">{loadError}</span>
          <button type="button" className="ml-3 text-meta underline" onClick={() => { setLoadError(null); setLoadAttempt((value) => value + 1); }}>
            Retry map
          </button>
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
