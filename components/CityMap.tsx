"use client";

/**
 * CityMap (Task 11 visual correction): the product's map surface.
 *
 * MapLibre GL renders the static showcase geography from LOCAL in-memory
 * GeoJSON (no tiles, no external basemap, no attribution) and owns the camera
 * (pan / wheel zoom / pinch / double-click). deck.gl (via MapboxOverlay) draws
 * the dynamic layers — vehicles, signals, incident overlays — from the bounded
 * 5 Hz presentation snapshots, interpolated to display rate in one rAF loop.
 *
 * React renders this component once per scale; nothing here rerenders per
 * frame. No simulation logic on this thread.
 */
import "maplibre-gl/dist/maplibre-gl.css";
import {
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  setWorkerUrl,
  type GeoJSONSource,
  type IControl,
  type LayerSpecification,
  type StyleSpecification,
} from "maplibre-gl";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import type { Layer } from "@deck.gl/core";
import { useEffect, useMemo, useRef, type RefObject } from "react";
import { showcaseCity, type ShowcaseMapModel } from "@/cities/showcase-city";
import { frameAlpha, interpolateVehicles } from "@/render/interpolate";
import { buildShowcaseGeoJson, type ShowcaseGeoJson } from "@/render/showcase-geojson";
import {
  buildIncidentLayers,
  buildSignalLayers,
  buildSignalPlans,
  buildVehicleLayer,
  toLngLat,
} from "@/render/deck-layers";
import { waitHeatBucket } from "@/render/showcase-geometry";
import { createVehicleIcons, type VehicleIconSet } from "@/render/vehicle-icons";
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
  getZoom: () => number;
}

interface CityMapProps {
  scaleIndex: number;
  frames: RefObject<FrameBuffer>;
  /** Camera + interaction unlocked once the user is in the city. */
  live: boolean;
  onHandle?: (handle: MapHandle | null) => void;
}

function boundsLngLat(bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
  const [west, south] = toLngLat(bounds.minX, bounds.minY);
  const [east, north] = toLngLat(bounds.maxX, bounds.maxY);
  return [
    [west, south],
    [east, north],
  ] as [[number, number], [number, number]];
}

const zoomWidth = (z12: number, z16: number, z19: number) =>
  ["interpolate", ["linear"], ["zoom"], 12, z12, 16, z16, 19, z19] as unknown as number;

function buildStyle(geo: ShowcaseGeoJson): StyleSpecification {
  const sources: StyleSpecification["sources"] = {
    land: { type: "geojson", data: geo.land as never },
    districts: { type: "geojson", data: geo.districts as never },
    water: { type: "geojson", data: geo.water as never },
    parks: { type: "geojson", data: geo.parks as never },
    buildings: { type: "geojson", data: geo.buildings as never },
    "roads-local": { type: "geojson", data: geo.roadsLocal as never },
    "roads-arterial": { type: "geojson", data: geo.roadsArterial as never },
    "roads-highway": { type: "geojson", data: geo.roadsHighway as never },
    bridges: { type: "geojson", data: geo.bridges as never },
    landmarks: { type: "geojson", data: geo.landmarks as never },
  };
  const layers: LayerSpecification[] = [
    { id: "land", type: "fill", source: "land", paint: { "fill-color": "#f6f2ea" } },
    {
      id: "district-tint",
      type: "fill",
      source: "districts",
      paint: {
        "fill-color": [
          "match",
          ["get", "kind"],
          "downtown",
          "#efe9dd",
          "civic",
          "#f1ece2",
          "residential",
          "#f2efe6",
          "market",
          "#f0e9dc",
          "riverside",
          "#eef0e9",
          "industrial",
          "#eeeae1",
          "arena",
          "#f0ece2",
          "outer",
          "#f2efe6",
          "#f2efe6",
        ],
        "fill-opacity": 0.55,
      },
    },
    {
      id: "water",
      type: "fill",
      source: "water",
      paint: { "fill-color": "#c8dde6" },
    },
    {
      id: "water-edge",
      type: "line",
      source: "water",
      paint: { "line-color": "#b3ccd8", "line-width": zoomWidth(0.6, 1.4, 2.4) },
    },
    { id: "parks", type: "fill", source: "parks", paint: { "fill-color": "#d7e3cc" } },
    {
      id: "parks-edge",
      type: "line",
      source: "parks",
      minzoom: 13.5,
      paint: { "line-color": "#c3d3b4", "line-width": zoomWidth(0.5, 1, 1.6) },
    },
    {
      id: "buildings",
      type: "fill",
      source: "buildings",
      minzoom: 14.2,
      paint: {
        "fill-color": ["case", ["get", "prominent"], "#d9d2c3", "#e4ded2"],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 14.2, 0.0, 15, 1],
      },
    },
    {
      id: "buildings-outline",
      type: "line",
      source: "buildings",
      minzoom: 15.2,
      paint: { "line-color": "#cdc5b5", "line-width": zoomWidth(0.3, 0.6, 0.9) },
    },
    {
      id: "landmarks",
      type: "fill",
      source: "landmarks",
      paint: { "fill-color": "#ded7c8", "fill-opacity": 0.95 },
    },
    {
      id: "landmarks-outline",
      type: "line",
      source: "landmarks",
      paint: { "line-color": "#c6bda9", "line-width": zoomWidth(0.6, 1.2, 1.8) },
    },
    // Roads: casing + fill, local < arterial < highway.
    {
      id: "roads-local-casing",
      type: "line",
      source: "roads-local",
      paint: {
        "line-color": "#e9e4d8",
        "line-width": zoomWidth(1.2, 3.6, 7),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 12.6, 0, 13.4, 1],
      },
    },
    {
      id: "roads-local",
      type: "line",
      source: "roads-local",
      paint: {
        "line-color": "#ffffff",
        "line-width": zoomWidth(0.8, 2.6, 5.4),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 12.6, 0, 13.4, 1],
      },
    },
    {
      id: "roads-arterial-casing",
      type: "line",
      source: "roads-arterial",
      paint: { "line-color": "#e3ddcf", "line-width": zoomWidth(2.2, 6.4, 12) },
    },
    {
      id: "roads-arterial",
      type: "line",
      source: "roads-arterial",
      paint: { "line-color": "#fffdf8", "line-width": zoomWidth(1.6, 4.8, 9.6) },
    },
    {
      id: "roads-highway-casing",
      type: "line",
      source: "roads-highway",
      paint: { "line-color": "#dfc182", "line-width": zoomWidth(4.4, 12, 22) },
    },
    {
      id: "roads-highway",
      type: "line",
      source: "roads-highway",
      paint: { "line-color": "#f7dcab", "line-width": zoomWidth(3.4, 9.6, 18) },
    },
    {
      id: "bridges-casing",
      type: "line",
      source: "bridges",
      paint: { "line-color": "#d8d0c0", "line-width": zoomWidth(2.6, 7.2, 13) },
    },
    {
      id: "bridges",
      type: "line",
      source: "bridges",
      paint: { "line-color": "#fdf9f0", "line-width": zoomWidth(2, 5.6, 10.4) },
    },
    {
      id: "road-markings",
      type: "line",
      source: "roads-arterial",
      minzoom: 16.2,
      paint: {
        "line-color": "#f0ead9",
        "line-width": zoomWidth(0.4, 0.8, 1.2),
        "line-dasharray": [3, 3],
      },
    },
    {
      id: "road-markings-highway",
      type: "line",
      source: "roads-highway",
      minzoom: 15.4,
      paint: {
        "line-color": "#ffffff",
        "line-width": zoomWidth(0.5, 1, 1.6),
        "line-dasharray": [4, 3],
        "line-opacity": 0.85,
      },
    },
  ];
  return { version: 8, name: "jev-showcase", sources, layers };
}

export function CityMap({ scaleIndex, frames, live, onHandle }: CityMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const zoomRef = useRef(16);
  const iconsRef = useRef<VehicleIconSet | null>(null);
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  }, [live]);

  const model: ShowcaseMapModel = useMemo(() => showcaseCity(scaleIndex), [scaleIndex]);
  const geo = useMemo(() => buildShowcaseGeoJson(model), [model]);
  const signalPlans = useMemo(() => buildSignalPlans(model), [model]);
  const modelRef = useRef(model);
  const geoRef = useRef(geo);
  const plansRef = useRef(signalPlans);
  useEffect(() => {
    modelRef.current = model;
    geoRef.current = geo;
    plansRef.current = signalPlans;
  }, [model, geo, signalPlans]);

  // Map lifecycle: created once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    configureMapLibreWorker();
    const map = new MapLibreMap({
      container,
      style: buildStyle(geoRef.current),
      center: toLngLat(1940, 1550),
      zoom: 18,
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
    map.addControl(new NavigationControl({ showCompass: false, showZoom: true }), "bottom-right");
    const overlay = new MapLibreOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay as unknown as IControl);
    mapRef.current = map;
    overlayRef.current = overlay;
    zoomRef.current = map.getZoom();
    iconsRef.current = createVehicleIcons();
    if (window.location.search.includes("debug")) {
      // Dev-only diagnostics (URL-gated).
      (window as unknown as { __jevMapInstance?: unknown }).__jevMapInstance = map;
      map.on("error", (event) => {
        const detail = (event as unknown as { error?: { message?: string } }).error;
        console.error("[maplibre-error]", detail?.message ?? String(event));
      });
    }

    const onZoom = () => {
      zoomRef.current = map.getZoom();
      updateLabelVisibility();
    };
    map.on("zoom", onZoom);

    // District / landmark labels: sparse DOM markers, zoom-dependent.
    let markers: Marker[] = [];
    function updateLabelVisibility() {
      const zoom = zoomRef.current;
      markers.forEach((marker, index) => {
        const label = geoRef.current.labels[index];
        const visible =
          label.kind === "district"
            ? label.rank <= 1 || zoom >= 13.6
            : zoom >= 15.2;
        marker.getElement().style.opacity = visible ? "1" : "0";
      });
    }
    function rebuildLabels() {
      markers.forEach((marker) => marker.remove());
      markers = geoRef.current.labels.map((label) => {
        const element = document.createElement("div");
        element.className =
          label.kind === "landmark" ? "jev-label jev-label-landmark" : "jev-label";
        element.textContent = label.name;
        element.style.opacity = "0";
        return new Marker({ element, anchor: "center" })
          .setLngLat(label.at as [number, number])
          .addTo(map);
      });
      updateLabelVisibility();
    }

    const handle: MapHandle = {
      flyToCentral: (options) => {
        map.fitBounds(boundsLngLat(modelRef.current.centralCamera), {
          padding: 40,
          duration: options?.immediate ? 0 : 2200,
          maxZoom: 18.6,
        });
      },
      fitCity: (options) => {
        map.fitBounds(boundsLngLat(modelRef.current.cityCamera), {
          padding: 60,
          duration: options?.immediate ? 0 : 1600,
          maxZoom: 18,
        });
      },
      getZoom: () => map.getZoom(),
    };

    map.on("load", () => {
      rebuildLabels();
      map.fitBounds(boundsLngLat(modelRef.current.centralCamera), {
        padding: 40,
        duration: 0,
        maxZoom: 18.6,
      });
      if (window.location.search.includes("debug")) {
        // Dev-only camera inspection hook (never rendered, URL-gated).
        (window as unknown as { __jevMap?: unknown }).__jevMap = {
          getZoom: () => map.getZoom(),
          getCenter: () => map.getCenter(),
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
        const vehicles = buffer.current
          ? interpolateVehicles(buffer.paths, buffer.previous, buffer.current, alpha)
          : [];
        const layers: Layer[] = [
          buildVehicleLayer(vehicles, iconsRef.current ?? createVehicleIcons() ?? EMPTY_ICONS, zoomRef.current),
          ...buildSignalLayers(buffer.current, plansRef.current, zoomRef.current),
          ...buildIncidentLayers(buffer.current, buffer.model, now),
        ];
        overlayRef.current?.setProps({ layers });
        if (window.location.search.includes("debug")) {
          const buckets = [0, 0, 0, 0, 0];
          for (const vehicle of vehicles) {
            buckets[waitHeatBucket(vehicle.blockedWaitMs)] += 1;
          }
          (window as unknown as { __jevLayers?: unknown }).__jevLayers = {
            vehicleCount: vehicles.length,
            snapshotVehicles: buffer.current?.vehicles.length ?? 0,
            layerIds: layers.map((layer) => layer.id),
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
      markers.forEach((marker) => marker.remove());
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, [frames, onHandle]);

  // Scale changes: swap the local GeoJSON sources; geography is nested.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) {
      return;
    }
    const apply = () => {
      const current = geoRef.current;
      const setData = (id: string, data: unknown) => {
        const source = map.getSource(id) as GeoJSONSource | undefined;
        source?.setData(data as never);
      };
      setData("land", current.land);
      setData("districts", current.districts);
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

  return <div ref={containerRef} className="absolute inset-0 h-full w-full" aria-label="Showcase city map" />;
}

const EMPTY_ICONS: VehicleIconSet = {
  atlas: "",
  mapping: {
    car: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: true },
    truck: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: true },
    bicycle: { x: 0, y: 0, width: 1, height: 1, anchorX: 0, anchorY: 0, mask: true },
  },
  lengths: { car: 11, truck: 17, bicycle: 7 },
};
