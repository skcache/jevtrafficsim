/**
 * Geographic and street labels as MapLibre symbol layers.
 *
 * These replaced DOM markers, so labels now participate in MapLibre's collision
 * engine: they never stack on each other or across traffic, and priority is a
 * data value (`symbol-sort-key`), not DOM order.
 *
 * Priority ladder: 1 major landmark, 2 major district, 3 highway ref,
 * 4 selected major arterial. Not every street is labelled, and nothing is
 * invented — every name comes from OSM metadata compiled into the map model.
 *
 * Glyphs are local (`/fonts/...`, committed Open Sans, Apache-2.0), so the map
 * works offline with no font CDN.
 */
import type { LayerSpecification } from "maplibre-gl";

export function buildLabelLayers(): LayerSpecification[] {
  return [
    // Geographic labels go through MapLibre's collision engine, so they never
    // stack on each other or across traffic the way DOM markers did.
    {
      id: "labels",
      type: "symbol",
      source: "labels",
      minzoom: 10.2,
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Semibold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 10.2, 10.5, 14, 12.5, 17, 14],
        "text-allow-overlap": false,
        "text-padding": 8,
        "text-variable-anchor": ["center", "top", "bottom", "left", "right"],
        "text-radial-offset": 0.6,
        "symbol-sort-key": ["get", "rank"],
        "symbol-z-order": "source",
      },
      paint: {
        "text-color": "#3a352c",
        "text-halo-color": "#faf7f0",
        "text-halo-width": 1.3,
        "text-halo-blur": 0.4,
      },
    },
    // Highway refs first (they are the city's spine), then major street names.
    {
      id: "street-refs",
      type: "symbol",
      source: "street-labels",
      minzoom: 11.6,
      filter: [
        "all",
        ["!=", ["get", "ref"], ""],
        ["in", ["get", "osmClass"], ["literal", ["motorway", "trunk"]]],
      ],
      layout: {
        "text-field": ["get", "ref"],
        "text-font": ["Open Sans Semibold"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 11.6, 10, 15, 12],
        "symbol-placement": "line",
        "text-allow-overlap": false,
        "text-padding": 12,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: {
        "text-color": "#6a5a3a",
        "text-halo-color": "#fdf8ee",
        "text-halo-width": 1.4,
      },
    },
    {
      id: "street-names",
      type: "symbol",
      source: "street-labels",
      minzoom: 14.4,
      filter: ["all", ["!=", ["get", "name"], ""], [">=", ["get", "rank"], 4]],
      layout: {
        "text-field": ["get", "name"],
        "text-font": ["Open Sans Regular"],
        "text-size": ["interpolate", ["linear"], ["zoom"], 14.4, 10, 17, 11.5],
        "symbol-placement": "line",
        "text-allow-overlap": false,
        "text-padding": 10,
        "symbol-sort-key": ["get", "rank"],
      },
      paint: {
        "text-color": "#5c5648",
        "text-halo-color": "#fffdf7",
        "text-halo-width": 1.2,
      },
    },
  ]
}
