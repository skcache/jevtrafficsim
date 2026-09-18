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
  buildVehicleLayers,
  toLngLat,
  type IncidentExtras,
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

/**
 * Camera bounds from the compiled geometry itself (intersections, district
 * polygons, label anchors) rather than authored numbers, so no district or
 * label is ever cropped at either end of the zoom range.
 */
function presentationBounds(model: ShowcaseMapModel) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const include = (x: number, y: number) => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const intersection of model.city.intersections) {
    include(intersection.x, intersection.y);
  }
  for (const district of model.districts) {
    for (const [x, y] of district.polygon) {
      include(x, y);
    }
  }
  for (const label of model.labels) {
    include(label.at[0], label.at[1]);
  }
  return { minX, minY, maxX, maxY };
}

function boundsLngLat(bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
  const [west, south] = toLngLat(bounds.minX, bounds.minY);
  const [east, north] = toLngLat(bounds.maxX, bounds.maxY);
  return [
    [west, south],
    [east, north],
  ] as [[number, number], [number, number]];
}

const zoomWidth = (zFar: number, zMid: number, zClose: number) =>
  ["interpolate", ["linear"], ["zoom"], 13, zFar, 16, zMid, 19.5, zClose] as unknown as number;

function buildStyle(geo: ShowcaseGeoJson): StyleSpecification {
  const sources: StyleSpecification["sources"] = {
    land: { type: "geojson", data: geo.land as never },
    districts: { type: "geojson", data: geo.districts as never },
    water: { type: "geojson", data: geo.water as never },
    parks: { type: "geojson", data: geo.parks as never },
    "park-canopy": { type: "geojson", data: geo.parkCanopy as never },
    buildings: { type: "geojson", data: geo.buildings as never },
    "roads-local": { type: "geojson", data: geo.roadsLocal as never },
    "roads-arterial": { type: "geojson", data: geo.roadsArterial as never },
    "roads-highway": { type: "geojson", data: geo.roadsHighway as never },
    bridges: { type: "geojson", data: geo.bridges as never },
    landmarks: { type: "geojson", data: geo.landmarks as never },
  };
  const layers: LayerSpecification[] = [
    { id: "land", type: "fill", source: "land", paint: { "fill-color": "#f5f2eb" } },
    {
      id: "district-tint",
      type: "fill",
      source: "districts",
      paint: {
        "fill-color": [
          "match",
          ["get", "kind"],
          "downtown",
          "#ece1cb",
          "civic",
          "#f0ebdb",
          "residential",
          "#e4ecda",
          "market",
          "#f4e4c6",
          "riverside",
          "#e0ecec",
          "industrial",
          "#e6e3d8",
          "arena",
          "#f2e3e1",
          "outer",
          "#f0ece2",
          "#f0ece2",
        ],
        "fill-opacity": 0.75,
      },
    },
    {
      id: "water",
      type: "fill",
      source: "water",
      paint: { "fill-color": "#b4d0de" },
    },
    {
      id: "water-shore",
      type: "line",
      source: "water",
      paint: { "line-color": "#e2eef4", "line-width": zoomWidth(2, 3.6, 6) },
    },
    {
      id: "water-bank",
      type: "line",
      source: "water",
      paint: { "line-color": "#93b7c9", "line-width": zoomWidth(0.5, 1, 1.6) },
    },
    { id: "parks", type: "fill", source: "parks", paint: { "fill-color": "#cfe0c0" } },
    {
      id: "parks-edge",
      type: "line",
      source: "parks",
      minzoom: 13,
      paint: { "line-color": "#b0c998", "line-width": zoomWidth(0.5, 1.1, 1.8) },
    },
    {
      id: "park-canopy",
      type: "circle",
      source: "park-canopy",
      minzoom: 13.4,
      paint: {
        "circle-color": "#b4cf9c",
        "circle-opacity": ["interpolate", ["linear"], ["zoom"], 13.4, 0, 14.4, 0.85],
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["zoom"],
          14,
          ["*", 0.55, ["get", "r"]],
          17.5,
          ["get", "r"],
        ],
      },
    },
    // Buildings: three tones by footprint area, plus a long shadow at street zoom.
    {
      id: "buildings",
      type: "fill",
      source: "buildings",
      minzoom: 13.2,
      paint: {
        // Tone steps are calibrated to the compiled footprints (median 5 100 m²,
        // warehouses 30 000 m²): small blocks stay pale, big masses read dark.
        "fill-color": [
          "case",
          ["get", "prominent"],
          "#cfc7b4",
          [
            "step",
            ["get", "area"],
            "#e8e3d8",
            3500,
            "#ddd6c7",
            9000,
            "#d2cab7",
          ],
        ],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 13.2, 0, 13.8, 0.9, 15.5, 1],
      },
    },
    {
      id: "buildings-shadow",
      type: "fill",
      source: "buildings",
      minzoom: 16.4,
      paint: {
        "fill-color": "#5c5242",
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], 16.4, 0, 17, 0.19],
        // Arrays inside an expression must be literal, or MapLibre reads
        // [0, 0] as an expression and rejects the whole style.
        "fill-translate": [
          "interpolate",
          ["linear"],
          ["zoom"],
          16.4,
          ["literal", [0, 0]],
          18,
          ["literal", [4, 5]],
          19.5,
          ["literal", [6, 7]],
        ] as unknown as [number, number],
      },
    },
    {
      id: "buildings-outline",
      type: "line",
      source: "buildings",
      minzoom: 15.4,
      paint: {
        "line-color": "#c3baa7",
        "line-width": zoomWidth(0.3, 0.6, 0.9),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 15.4, 0, 16, 1],
      },
    },
    {
      id: "landmarks",
      type: "fill",
      source: "landmarks",
      paint: { "fill-color": "#ddd5c5", "fill-opacity": 0.95 },
    },
    {
      id: "landmarks-outline",
      type: "line",
      source: "landmarks",
      paint: { "line-color": "#c0b6a1", "line-width": zoomWidth(0.7, 1.3, 2) },
    },
    // Roads: casing + fill, local < arterial < highway (the highway must read
    // at city zoom — it is the city's spine).
    {
      id: "roads-local-casing",
      type: "line",
      source: "roads-local",
      paint: {
        "line-color": "#dcd6c8",
        "line-width": zoomWidth(2, 5, 8),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 12.6, 0, 13.4, 1],
      },
    },
    {
      id: "roads-local",
      type: "line",
      source: "roads-local",
      paint: {
        "line-color": "#ffffff",
        "line-width": zoomWidth(1.2, 3.6, 6.4),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 12.6, 0, 13.4, 1],
      },
    },
    {
      id: "roads-arterial-casing",
      type: "line",
      source: "roads-arterial",
      paint: { "line-color": "#d3cbb8", "line-width": zoomWidth(4.5, 9.5, 15) },
    },
    {
      id: "roads-arterial",
      type: "line",
      source: "roads-arterial",
      paint: { "line-color": "#fffdf7", "line-width": zoomWidth(3.2, 7.4, 12) },
    },
    {
      id: "roads-highway-shadow",
      type: "line",
      source: "roads-highway",
      paint: {
        "line-color": "#5c5242",
        "line-opacity": 0.1,
        "line-width": zoomWidth(8, 17, 24),
        "line-translate": [1.5, 2],
      },
    },
    {
      id: "roads-highway-casing",
      type: "line",
      source: "roads-highway",
      paint: { "line-color": "#d9a85c", "line-width": zoomWidth(8, 17, 24) },
    },
    {
      id: "roads-highway",
      type: "line",
      source: "roads-highway",
      paint: { "line-color": "#f8ce8b", "line-width": zoomWidth(6.4, 14.4, 20.5) },
    },
    {
      id: "roads-highway-guardrail",
      type: "line",
      source: "roads-highway",
      minzoom: 15,
      paint: {
        "line-color": "#9a7e4a",
        "line-width": zoomWidth(0.4, 0.8, 1.2),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], 15, 0, 15.6, 0.7],
      },
    },
    // Bridges: their own material (decks over water), with a water shadow.
    {
      id: "bridges-shadow",
      type: "line",
      source: "bridges",
      minzoom: 14.6,
      paint: {
        "line-color": "#28404f",
        "line-opacity": 0.1,
        "line-width": zoomWidth(4.2, 9.4, 15),
        "line-translate": [2, 3],
      },
    },
    {
      id: "bridges-casing",
      type: "line",
      source: "bridges",
      paint: { "line-color": "#c6bca5", "line-width": zoomWidth(4.4, 9.8, 15.6) },
    },
    {
      id: "bridges",
      type: "line",
      source: "bridges",
      paint: { "line-color": "#fbf7ee", "line-width": zoomWidth(3.4, 7.8, 12.6) },
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

/** Label ladder: rank 1 districts early, rank 3 late, landmarks at street zoom. */
function labelVisible(kind: string, rank: number, zoom: number): boolean {
  if (kind === "landmark") {
    return zoom >= 16;
  }
  if (rank <= 1) {
    return zoom >= 13.2;
  }
  if (rank === 2) {
    return zoom >= 14.6;
  }
  return zoom >= 15.6;
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
    iconsRef.current = createVehicleIcons();
    if (window.location.search.includes("debug")) {
      // Dev-only diagnostics (URL-gated).
      (window as unknown as { __jevMapInstance?: unknown }).__jevMapInstance = map;
      map.on("error", (event) => {
        const detail = (event as unknown as { error?: { message?: string } }).error;
        console.error("[maplibre-error]", detail?.message ?? String(event));
      });
    }

    // District / landmark labels: sparse DOM markers on a rank ladder.
    let markers: Marker[] = [];
    function updateLabelVisibility() {
      const zoom = zoomRef.current;
      markers.forEach((marker, index) => {
        const label = geoRef.current.labels[index];
        const visible = labelVisible(label.kind, label.rank, zoom);
        marker.getElement().style.opacity = visible ? "1" : "0";
      });
    }
    function rebuildLabels() {
      markers.forEach((marker) => marker.remove());
      markers = geoRef.current.labels.map((label) => {
        const element = document.createElement("div");
        element.className =
          label.kind === "landmark" ? "jev-label jev-label-landmark" : "jev-label";
        if (label.kind === "landmark") {
          const dot = document.createElement("span");
          dot.textContent = "●";
          dot.style.fontSize = "5px";
          dot.style.verticalAlign = "middle";
          dot.style.marginRight = "4px";
          dot.style.opacity = "0.55";
          element.appendChild(dot);
        }
        element.appendChild(document.createTextNode(label.name));
        element.style.opacity = "0";
        return new Marker({ element, anchor: "center" })
          .setLngLat(label.at as [number, number])
          .addTo(map);
      });
      updateLabelVisibility();
    }

    // Incident plates: created and destroyed as incidents come and go.
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
          existing.setLngLat(toLngLat(entry.x, entry.y));
          continue;
        }
        const element = document.createElement("div");
        element.className = "jev-plate";
        const dot = document.createElement("span");
        dot.className = "jev-plate-dot";
        element.appendChild(dot);
        element.appendChild(document.createTextNode(entry.label));
        const marker = new Marker({ element, anchor: "bottom" })
          .setLngLat(toLngLat(entry.x, entry.y))
          .addTo(map);
        plates.set(entry.id, marker);
      }
    }

    const onZoom = () => {
      zoomRef.current = map.getZoom();
      updateLabelVisibility();
    };
    map.on("zoom", onZoom);

    const handle: MapHandle = {
      flyToCentral: (options) => {
        map.fitBounds(boundsLngLat(modelRef.current.centralCamera), {
          padding: 40,
          duration: options?.immediate ? 0 : 1500,
          maxZoom: 18.6,
          easing: (t) => 1 - Math.pow(1 - t, 3),
        });
      },
      fitCity: (options) => {
        map.fitBounds(boundsLngLat(presentationBounds(modelRef.current)), {
          padding: 72,
          duration: options?.immediate ? 0 : 1400,
          maxZoom: 18,
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
      rebuildLabels();
      // Landing shows the whole city; Enter City flies into Central.
      map.fitBounds(boundsLngLat(presentationBounds(modelRef.current)), {
        padding: 72,
        duration: 0,
        maxZoom: 18,
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
        const incidents = buildIncidentLayers(buffer.current, buffer.model, now);
        const layers: Layer[] = [
          ...buildVehicleLayers(
            vehicles,
            iconsRef.current ?? createVehicleIcons() ?? EMPTY_ICONS,
            zoomRef.current,
          ),
          ...buildSignalLayers(buffer.current, plansRef.current, zoomRef.current),
          ...incidents.layers,
        ];
        overlayRef.current?.setProps({ layers });
        syncPlates(incidents.extras.plates);
        if (window.location.search.includes("debug")) {
          const buckets = [0, 0, 0, 0, 0];
          for (const vehicle of vehicles) {
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
      plates.forEach((marker) => marker.remove());
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
      setData("park-canopy", current.parkCanopy);
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
    <div
      ref={containerRef}
      className="absolute inset-0 h-full w-full"
      aria-label="Showcase city map"
    />
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
