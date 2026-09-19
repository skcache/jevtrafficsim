/**
 * The cartographic style system for the Chicago showcase.
 *
 * Every static map value lives here — palette, road widths, zoom bands,
 * per-layer visibility, the label ladder — so the map cannot drift into a
 * patchwork of local decisions in CityMap.
 *
 * Direction (Phase 3.1): a coherent, minimal, high-quality map. The basemap is
 * a quiet substrate and the only saturated colours in the product are the ones
 * that carry state: traffic, incidents, selection. Apple's Maps guidance names
 * exactly this case — its "muted" emphasis style is the one to pick when there
 * is information-rich content that has to stand out against the map.
 *
 * Three rules do most of the work:
 *
 *   1. SUBTRACTION. At city zoom the map shows land, water, major parks,
 *      highway and arterial structure and a handful of labels. Buildings,
 *      street names, tiny water and small green fragments are not "hidden by
 *      opacity" — they do not exist until the camera has earned them.
 *   2. HIERARCHY BY FORM. Highways read through width, casing and their own
 *      carriageway geometry, not through colour. No orange basemap.
 *   3. PROGRESSIVE DETAIL. Each zoom band adds exactly one class of thing, so
 *      the map gets denser as the camera comes down instead of being dense
 *      everywhere.
 *
 * Area gates are written as zoom-interpolated opacity with data expressions in
 * the stops, because MapLibre only accepts a `zoom` expression as the input of
 * a top-level `interpolate`/`step` — it cannot appear inside a `filter` or a
 * nested `case`.
 */
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";
import type { ShowcaseGeoJson } from "./map-geojson";
import { CLOSE_TIER_MINZOOM, MID_TIER_MINZOOM } from "./zoom-grammar";

/* ------------------------------------------------------------------ */
/* Palette                                                             */
/* ------------------------------------------------------------------ */

/**
 * A restrained light palette. Warm off-white land, near-white roads, muted
 * blue water, desaturated green parks, charcoal labels — nothing in the
 * basemap competes with a red incident or an amber congested road.
 */
export const CHICAGO_PALETTE = {
  land: "#f7f5f0",
  water: "#bfd4df",
  waterShore: "#eaf1f4",
  waterBank: "#8fb3c8",
  park: "#d8e3d2",
  parkEdge: "#bccbae",
  /** Two building tones only, close enough to read as one mass. */
  buildingSmall: "#eae5da",
  buildingLarge: "#e1dbcc",
  buildingLine: "#d6cebd",
  landmark: "#e2dccd",
  landmarkLine: "#c8bfa9",
  /**
   * Urban blocks: the city fabric between meaningful streets. One calm warm
   * neutral surface per block replaces thousands of individual footprints, so
   * the map reads as roads carving a coherent city instead of unrelated shapes.
   */
  block: "#ece9e1",
  blockEdge: "#ddd6c6",
  localSurface: "#fffefa",
  localCasing: "#e1ddd4",
  arterialSurface: "#fffdf8",
  arterialCasing: "#d0cabd",
  /** Highways: near-white surface, a warm grey casing, and WIDTH does the rest. */
  highwaySurface: "#ead7ad",
  highwayCasing: "#c5ad7f",
  highwayRail: "#9d8d70",
  highwayShadow: "#5c5242",
  bridgeSurface: "#fffdf7",
  bridgeCasing: "#cec5b5",
  bridgeShadow: "#28404f",
  marking: "#f6efe2",
  label: "#46423a",
  labelHalo: "#f8f5ee",
  ref: "#5f5a4e",
  refHalo: "#faf7f0",
} as const;

/* ------------------------------------------------------------------ */
/* Zoom bands and per-layer gates                                      */
/* ------------------------------------------------------------------ */

/**
 * When each class of detail appears. Values are minzooms; nothing here is a
 * "fade in early and hope" — a layer either exists at a zoom or it does not.
 */
export const MAP_ZOOM = {
  /** Tiny basins, ponds and fountains. The river and lake never need this. */
  waterDetail: 15,
  waterShore: 12,
  waterBank: 13.6,
  /** City blocks are the urban mass; they arrive before any footprint does. */
  blocks: 11.6,
  blocksEdge: 17.2,
  /**
   * Buildings: at neighborhood zoom only the prominent masses read as aggregate
   * city weight; every footprint waits for street zoom.
   */
  buildings: 16.6,
  buildingsAll: 17.4,
  buildingsOutline: 17.9,
  /** Short unnamed stubs earn ink only when the camera is close. */
  roadsDetail: 18,
  /** Park edges, like building outlines, are a close-zoom instrument. */
  parksEdge: 17,
  landmarks: 16.4,
  /** Local streets arrive with the neighborhood, not with the city. */
  localRoads: 12.8,
  highwayRail: 15,
  markings: 17.2,
  /** Highway refs are the spine and may appear early; street names may not. */
  streetRefs: 12.2,
  streetNames: 16.2,
  /** District and landmark labels, with collision doing the decluttering. */
  labels: 11.4,
} as const;

/**
 * Minimum polygon area, in m², before a feature is drawn at a given band. The
 * river, the lake and Grant Park are always there; a 30 m² fountain or a 150 m²
 * grass sliver waits until the camera is close enough to mean it.
 */
export const AREA_MIN = {
  waterFar: 5000,
  waterMid: 5000,
  /**
   * Even at close zoom, water has to be a real body: compactness catches thin
   * wedges, but a small triangle is compact and still reads as a scrap beside
   * calm blocks.
   */
  waterClose: 5000,
  parkFar: 40000,
  parkMid: 20000,
  /** The same floor for green: below this it is a garden scrap, not a park. */
  parkClose: 12000,
} as const;

/** Zoom at which the mid-band area thresholds take over. */
const AREA_MID_ZOOM = 13.5;

/* ------------------------------------------------------------------ */
/* Road widths                                                         */
/* ------------------------------------------------------------------ */

const METRES_PER_PIXEL_AT_Z0 = 156543.03392 * Math.cos((41.881 * Math.PI) / 180);
const FLOOR_PX: Record<number, number> = { 9: 0.7, 11: 1.0, 13: 1.3, 15: 1.6, 17: 1.8 };

/**
 * Data-driven road width: a feature's physical width in metres converted to
 * pixels at the current zoom. metresPerPixel is `K / 2^zoom`, so pixels are
 * `widthM * 2^zoom / K` — one expression, exact at every zoom, no per-zoom
 * constants. A legibility floor keeps minor streets visible when zoomed out.
 *
 * MapLibre only allows a `zoom` expression as the input of a top-level
 * `interpolate`/`step`, so the conversion is an exponential interpolation with
 * base 2 — which is exactly how metres-per-pixel behaves — and each stop
 * carries the per-feature data expression.
 */
export function roadWidthPx(extraPx = 0, floorScale = 1): number {
  const at = (zoom: number) => {
    const pixels: unknown[] = ["/", ["*", ["get", "widthM"], 2 ** zoom], METRES_PER_PIXEL_AT_Z0];
    const withExtra = extraPx > 0 ? ["+", pixels, extraPx] : pixels;
    // Far zoom exaggerates for legibility, and the exaggeration has to be
    // class-aware: with a shared floor every road collapses to ~1 px and the
    // hierarchy disappears exactly where it matters most.
    return ["max", FLOOR_PX[zoom] * floorScale, withExtra];
  };
  return [
    "interpolate",
    ["exponential", 2],
    ["zoom"],
    9,
    at(9),
    11,
    at(11),
    13,
    at(13),
    15,
    at(15),
    17,
    at(17),
  ] as unknown as number;
}

const zoomWidth = (zFar: number, zMid: number, zClose: number) =>
  ["interpolate", ["linear"], ["zoom"], 13, zFar, 16, zMid, 19.5, zClose] as unknown as number;

/**
 * Opacity that keeps a polygon hidden until its area passes the band's
 * threshold: 0 at far zoom, threshold relaxed at mid, and at close zoom either
 * everything (areaClose 0) or everything above a final floor — because a
 * 40 m² grass scrap beside calm blocks is debris at any zoom.
 */
function areaGate(areaFar: number, areaMid: number, closeZoom: number, areaClose = 0): number {
  return [
    "interpolate",
    ["linear"],
    ["zoom"],
    9,
    ["case", [">=", ["get", "areaM2"], areaFar], 1, 0],
    AREA_MID_ZOOM,
    ["case", [">=", ["get", "areaM2"], areaMid], 1, 0],
    closeZoom,
    areaClose > 0 ? ["case", [">=", ["get", "areaM2"], areaClose], 1, 0] : 1,
  ] as unknown as number;
}

/* ------------------------------------------------------------------ */
/* The style                                                           */
/* ------------------------------------------------------------------ */

export function buildChicagoStyle(geo: ShowcaseGeoJson): StyleSpecification {
  const palette = CHICAGO_PALETTE;
  const sources: StyleSpecification["sources"] = {
    land: { type: "geojson", data: geo.land as never },
    blocks: { type: "geojson", data: geo.blocks as never },
    water: { type: "geojson", data: geo.water as never },
    parks: { type: "geojson", data: geo.parks as never },
    buildings: { type: "geojson", data: geo.buildings as never },
    landmarks: { type: "geojson", data: geo.landmarks as never },
    labels: { type: "geojson", data: geo.labels as never },
    "street-labels": { type: "geojson", data: geo.streetLabels as never },
    "roads-local": { type: "geojson", data: geo.roadsLocal as never },
    "roads-detail": { type: "geojson", data: geo.roadsDetail as never },
    "roads-arterial": { type: "geojson", data: geo.roadsArterial as never },
    "roads-highway": { type: "geojson", data: geo.roadsHighway as never },
    bridges: { type: "geojson", data: geo.bridges as never },
  };

  const layers: LayerSpecification[] = [
    { id: "land", type: "fill", source: "land", paint: { "fill-color": palette.land } },
    // Urban blocks: the city fabric between meaningful streets. One calm warm
    // surface per block is the mid-zoom urban mass, so the map never depends on
    // thousands of individual footprints to look like a city.
    {
      id: "blocks",
      type: "fill",
      source: "blocks",
      minzoom: MAP_ZOOM.blocks,
      paint: {
        "fill-color": palette.block,
        "fill-opacity": [
          "interpolate",
          ["linear"],
          ["zoom"],
          MAP_ZOOM.blocks,
          0.42,
          13.5,
          0.62,
          16.5,
          0.72,
        ],
      },
    },
    {
      id: "water",
      type: "fill",
      source: "water",
      paint: {
        "fill-color": palette.water,
        // Chicago River and Lake Michigan dominate; a fountain waits.
        "fill-opacity": areaGate(AREA_MIN.waterFar, AREA_MIN.waterMid, MAP_ZOOM.waterDetail, AREA_MIN.waterClose),
      },
    },
    {
      id: "water-shore",
      type: "line",
      source: "water",
      minzoom: MAP_ZOOM.waterShore,
      paint: { "line-color": palette.waterShore, "line-width": zoomWidth(1.4, 2.4, 4) },
    },
    {
      id: "parks",
      type: "fill",
      source: "parks",
      paint: {
        "fill-color": palette.park,
        // A 150 m² grass fragment is not geography at city zoom.
        "fill-opacity": areaGate(AREA_MIN.parkFar, AREA_MIN.parkMid, 15.5, AREA_MIN.parkClose),
      },
    },
    {
      id: "landmarks",
      type: "fill",
      source: "landmarks",
      minzoom: MAP_ZOOM.landmarks,
      paint: { "fill-color": palette.landmark, "fill-opacity": 0.9 },
    },
    // Buildings: at neighborhood zoom only the prominent masses read as
    // aggregate city weight; every ordinary footprint waits for street zoom, so
    // blocks stay the main urban mass and nothing screams at equal importance.
    // Roads: casing + fill. Local < arterial < highway, and the highway earns
    // its rank from width and structure rather than from a louder colour.
    {
      id: "roads-local-casing",
      type: "line",
      source: "roads-local",
      minzoom: MAP_ZOOM.localRoads,
      paint: {
        "line-color": palette.localCasing,
        "line-width": roadWidthPx(1.6),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], MAP_ZOOM.localRoads, 0, 13.6, 1],
      },
    },
    {
      id: "roads-local",
      type: "line",
      source: "roads-local",
      minzoom: MAP_ZOOM.localRoads,
      paint: {
        "line-color": palette.localSurface,
        "line-width": roadWidthPx(),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], MAP_ZOOM.localRoads, 0, 13.6, 1],
      },
    },
    // Short unnamed stubs: real roads that keep routing, but they only earn ink
    // once the camera is close. Drawing them at neighborhood zoom is what made
    // ordinary street pieces read as fake ramps.
    {
      id: "roads-detail",
      type: "line",
      source: "roads-detail",
      minzoom: MAP_ZOOM.roadsDetail,
      paint: {
        "line-color": palette.localSurface,
        "line-width": roadWidthPx(0.4),
        "line-opacity": 0.9,
      },
    },
    {
      id: "roads-arterial-casing",
      type: "line",
      source: "roads-arterial",
      paint: { "line-color": palette.arterialCasing, "line-width": roadWidthPx(2, 1.35) },
    },
    {
      id: "roads-arterial",
      type: "line",
      source: "roads-arterial",
      paint: { "line-color": palette.arterialSurface, "line-width": roadWidthPx(0, 1.45) },
    },
    {
      id: "roads-highway-casing",
      type: "line",
      source: "roads-highway",
      paint: { "line-color": palette.highwayCasing, "line-width": roadWidthPx(2.8, 3.6) },
    },
    {
      id: "roads-highway",
      type: "line",
      source: "roads-highway",
      paint: { "line-color": palette.highwaySurface, "line-width": roadWidthPx(0, 3.35) },
    },
    {
      id: "roads-highway-guardrail",
      type: "line",
      source: "roads-highway",
      minzoom: MAP_ZOOM.highwayRail,
      paint: {
        "line-color": palette.highwayRail,
        "line-width": zoomWidth(0.4, 0.8, 1.1),
        "line-opacity": ["interpolate", ["linear"], ["zoom"], MAP_ZOOM.highwayRail, 0, 15.6, 0.65],
      },
    },
    // Bridges: their own material over water, no shadow at map zooms.
    {
      id: "bridges-casing",
      type: "line",
      source: "bridges",
      paint: { "line-color": palette.bridgeCasing, "line-width": zoomWidth(4.4, 9.8, 15.6) },
    },
    {
      id: "bridges",
      type: "line",
      source: "bridges",
      paint: { "line-color": palette.bridgeSurface, "line-width": zoomWidth(3.4, 7.8, 12.6) },
    },
    {
      id: "road-markings-highway",
      type: "line",
      source: "roads-highway",
      minzoom: 16.8,
      paint: {
        "line-color": palette.marking,
        "line-width": zoomWidth(0.5, 1, 1.6),
        "line-dasharray": [4, 3],
        "line-opacity": 0.85,
      },
    },
    {
      id: "road-markings",
      type: "line",
      source: "roads-arterial",
      minzoom: MAP_ZOOM.markings,
      paint: {
        "line-color": palette.marking,
        "line-width": zoomWidth(0.4, 0.8, 1.2),
        "line-dasharray": [3, 3],
        "line-opacity": 0.8,
      },
    },
  ];

  return {
    version: 8,
    name: "jev-chicago",
    // Local glyphs: no external font CDN, works offline like the rest of the map.
    glyphs: "/fonts/{fontstack}/{range}.pbf",
    sources,
    layers: [...layers, ...buildLabelLayers()],
  };
}

/* ------------------------------------------------------------------ */
/* Labels                                                              */
/* ------------------------------------------------------------------ */

/**
 * The label ladder. Priority is a data value (`symbol-sort-key`) so MapLibre's
 * collision engine resolves overlaps deterministically:
 *
 *   1 major landmark · 2 major district · 3 highway ref · 4 major arterial
 *
 * Nothing is labelled merely because the source carries a name. Street names
 * are deduplicated to one label per street upstream (the longest piece wins), so
 * a long avenue no longer repeats its name through every block.
 */
export function buildLabelLayers(): LayerSpecification[] {
  const palette = CHICAGO_PALETTE;
  return [
    {
      id: "labels",
      type: "symbol",
      source: "labels",
      minzoom: MAP_ZOOM.labels,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Semibold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11.4, 10.5, 14, 12, 17, 13.5],
        "text-allow-overlap": false,
        "text-padding": 10,
        "text-variable-anchor": ["center", "top", "bottom", "left", "right"],
        "text-radial-offset": 0.6,
        "symbol-sort-key": ["get", "rank"],
        "symbol-z-order": "source",
      },
      paint: {
        "text-color": palette.label,
        "text-halo-color": palette.labelHalo,
        "text-halo-width": 1.3,
        "text-halo-blur": 0.4,
      },
    },
    // Highway refs only, and only on the spine.
    {
      id: "street-refs",
      type: "symbol",
      source: "street-labels",
      minzoom: MAP_ZOOM.streetRefs,
      filter: [
        "all",
        ["!=", ["get", "ref"], ""],
        ["in", ["get", "osmClass"], ["literal", ["motorway", "trunk"]]],
      ],
      layout: {
        "text-field": ["get", "ref"],
        "text-font": ["Open Sans Semibold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 12.2, 10, 15, 11.5],
        "symbol-placement": "line",
        "text-allow-overlap": false,
        "text-padding": 14,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: {
        "text-color": palette.ref,
        "text-halo-color": palette.refHalo,
        "text-halo-width": 1.4,
      },
    },
    // Street names: close zoom only, major streets only.
    {
      id: "street-names",
      type: "symbol",
      source: "street-labels",
      minzoom: MAP_ZOOM.streetNames,
      filter: ["all", ["!=", ["get", "name"], ""], [">=", ["get", "rank"], 4]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 15.2, 10, 17, 11.5],
        "symbol-placement": "line",
        "text-allow-overlap": false,
        "text-padding": 12,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: {
        "text-color": palette.label,
        "text-halo-color": palette.labelHalo,
        "text-halo-width": 1.2,
      },
    },
  ];
}

/** Exported for tests: the tier boundaries the style is built around. */
export const STYLE_BANDS = { mid: MID_TIER_MINZOOM, close: CLOSE_TIER_MINZOOM } as const;
