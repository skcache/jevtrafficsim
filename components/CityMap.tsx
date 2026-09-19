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
 * Presentation grammar: a warm printed city. Land, water, parks, district
 * tints and three road classes carry the hierarchy; buildings gain a long
 * shadow at street zoom; labels follow a rank ladder and incidents surface
 * their own plates. React renders this component once per scale; nothing here
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
import { frameAlpha, interpolateVehicles } from "@/render/interpolate";
import { packQueues, settlePlacements, type DisplayedPlacement } from "@/render/queue-packing";
import {
  carriagewayPairs,
  laneCentreOffsetMetres,
  widthMetresForRoad,
} from "@/render/road-presentation";
import { roadPressure } from "@/render/congestion";
import {
  boundsLngLat as cameraBoundsLngLat,
  centralBounds,
  FIT_PADDING,
  networkBounds,
  presetPose,
  PRESET_PADDING,
} from "@/render/camera-presets";
import { buildChicagoStyle } from "@/render/chicago-style";
import { CLOSE_TIER_MINZOOM } from "@/render/zoom-grammar";
import { buildShowcaseGeoJson, type ShowcaseGeoJson } from "@/render/map-geojson";
import {
  buildCongestionLayers,
  buildIncidentLayers,
  type CongestionRoad,
  buildSignalLayers,
  buildSignalPlans,
  buildVehicleLayers,
  type IncidentExtras,
} from "@/render/deck-layers";
import { waitHeatBucket } from "@/render/map-geometry";
import { type VehicleIconSet } from "@/render/vehicle-icons";
import { createVehicleSprites } from "@/render/vehicle-sprites";
import { createSignalSprites, type SignalSpriteSet } from "@/render/signal-sprites";
import { SIM_TICK_MS, SNAPSHOT_EVERY_TICKS } from "@/worker/protocol";
import type { FrameBuffer } from "./frame-buffer";

const EXPECTED_FRAME_INTERVAL_MS = SIM_TICK_MS * SNAPSHOT_EVERY_TICKS;

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
  const signalSpritesRef = useRef<SignalSpriteSet | null>(null);
  /** Per-road lane-centre offsets in metres for the current model. */
  const laneOffsetsRef = useRef<number[] | null>(null);
  /** Per-road lng/lat paths + physical widths, for the congestion overlay. */
  const congestionRoadsRef = useRef<CongestionRoad[]>([]);
  /** Latest incident plate positions (metric), for the dev camera helper. */
  const platesRef = useRef<readonly { x: number; y: number; label: string }[]>([]);
  /** Metric anchor of the active crash, for the dev camera hook. */
  const crashRef = useRef<{ x: number; y: number } | null>(null);
  /** What was drawn last frame, so queue re-placements can settle instead of jumping. */
  const displayedRef = useRef<Map<number, DisplayedPlacement>>(new Map());
  const lastFrameMsRef = useRef(0);
  /** Last rendered frame, for the dev motion-QA hook. */
  const frameRef = useRef<
    { id: number; roadId: number | null; x: number; y: number; headingRadians: number; blockedWaitMs: number }[]
  >([]);
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
  const signalPlans = useMemo(() => (model ? buildSignalPlans(model) : null), [model]);
  const modelRef = useRef<MapModel | null>(model);
  const geoRef = useRef(geo);
  const plansRef = useRef(signalPlans);
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
    plansRef.current = signalPlans;
  }, [model, geo, signalPlans]);

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
    signalSpritesRef.current = createSignalSprites();
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
        map.fitBounds(cameraBoundsLngLat(initialModel, centralBounds(initialModel)), {
          padding: PRESET_PADDING,
          duration: options?.immediate ? 0 : 1500,
          maxZoom: 17.4,
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
    };

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
        const alpha = frameAlpha(now, buffer.currentReceivedAtMs, EXPECTED_FRAME_INTERVAL_MS);
        const progress = new Map<number, number>();
        if (buffer.current) {
          for (const vehicle of buffer.current.vehicles) {
            progress.set(vehicle.id, vehicle.progress);
          }
        }
        const laneOffsets = laneOffsetsRef.current ?? [];
        const congestion =
          !trafficHiddenRef.current && zoomRef.current < CLOSE_TIER_MINZOOM && buffer.current
            ? buildCongestionLayers(
                congestionRoadsRef.current ?? [],
                roadPressure(buffer.current),
                zoomRef.current,
              )
            : [];
        const interpolated = buffer.current
          ? interpolateVehicles(buffer.paths, buffer.previous, buffer.current, alpha, {
              nowMs: now,
              receivedAtMs: buffer.currentReceivedAtMs,
              laneOffsets,
              city: buffer.model.city,
            })
          : [];
        // Presentation-only queue packing: same simulation state, same pixels.
        const vehicles = buffer.current
          ? packQueues(
              buffer.model.city,
              buffer.paths,
              laneOffsets,
              interpolated,
              (id) => progress.get(id) ?? 0,
            )
          : [];
        // Settle re-placements: queue packing moves a vehicle from where it
        // stopped to its packed position, which raw is a teleport.
        const dtSeconds =
          lastFrameMsRef.current === 0 ? 0.016 : (now - lastFrameMsRef.current) / 1000;
        lastFrameMsRef.current = now;
        const settled = settlePlacements(vehicles, displayedRef.current, dtSeconds);
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
        const incidents = buildIncidentLayers(buffer.current, buffer.model);
        // `?notraffic=1` hides every traffic primitive so the basemap can be
        // reviewed on its own. Dev-only, never rendered, like the camera hook.
        const layers: Layer[] = trafficHiddenRef.current
          ? []
          : [
              ...buildVehicleLayers(
                projection,
                settled,
                iconsRef.current ?? createVehicleSprites() ?? EMPTY_ICONS,
                zoomRef.current,
              ),
              ...buildSignalLayers(
                projection,
                buffer.model,
                buffer.current,
                plansRef.current ?? new Map(),
                buffer.paths,
                zoomRef.current,
                signalSpritesRef.current,
              ),
              ...incidents.layers,
              ...congestion,
            ];
        overlayRef.current?.setProps({ layers });
        platesRef.current = incidents.extras.plates;
        crashRef.current = incidents.extras.crash;
        syncPlates(incidents.extras.plates);
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
          (window as unknown as { __jevLayers?: unknown }).__jevLayers = {
            hottest: hotspots[0] ?? null,
            hotspots,
            vehicleCount: vehicles.length,
            snapshotVehicles: buffer.current?.vehicles.length ?? 0,
            layerIds: layers.map((layer) => layer.id),
            // Signals hide themselves when the atlas is missing rather than
            // falling back to a coloured dot, so debug reports it explicitly.
            signalSprites: signalSpritesRef.current ? "ok" : "missing",
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
      plates.forEach((marker) => marker.remove());
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // `ready` is the async-geography gate: the effect must re-run when the
    // model first arrives, and only then.
  }, [frames, onHandle, ready]);

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
      setData("water", current.water);
      setData("parks", current.parks);
      setData("buildings", current.buildings);
      setData("roads-local", current.roadsLocal);
      setData("roads-arterial", current.roadsArterial);
      setData("roads-highway", current.roadsHighway);
      setData("bridges", current.bridges);
      setData("landmarks", current.landmarks);
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
