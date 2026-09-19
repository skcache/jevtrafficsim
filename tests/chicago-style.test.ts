/**
 * Cartographic guards for the Chicago style.
 *
 * These encode the Phase-3.1 acceptance rules as measurements rather than
 * opinions, so the map cannot quietly drift back into "raw OSM geometry": a
 * saturated highway, a canopy dot field, a district tint, buildings at city
 * zoom, or a street name on every block all fail here.
 */
import { describe, expect, it } from "vitest";
import { buildShowcaseGeoJson } from "@/render/map-geojson";
import {
  AREA_MIN,
  buildChicagoStyle,
  buildLabelLayers,
  CHICAGO_PALETTE,
  MAP_ZOOM,
  roadWidthPx,
} from "@/render/chicago-style";
import { VEHICLE_MINZOOM } from "@/render/zoom-grammar";
import { chicagoModel } from "./chicago-support";

/* ---------------------------- colour helpers ---------------------------- */

/** Chroma in 0-255: meaningful at every lightness, unlike HSL saturation. */
function chroma(hex: string): number {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16);
  const g = parseInt(value.slice(2, 4), 16);
  const b = parseInt(value.slice(4, 6), 16);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

function toHsl(hex: string): { h: number; s: number; l: number } {
  const value = hex.replace("#", "");
  const r = parseInt(value.slice(0, 2), 16) / 255;
  const g = parseInt(value.slice(2, 4), 16) / 255;
  const b = parseInt(value.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) {
    return { h: 0, s: 0, l };
  }
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) {
    h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  } else if (max === g) {
    h = ((b - r) / d + 2) / 6;
  } else {
    h = ((r - g) / d + 4) / 6;
  }
  return { h: h * 360, s, l };
}

const style = buildChicagoStyle(buildShowcaseGeoJson(chicagoModel(4)));
const layers = style.layers as unknown as Record<string, unknown>[];
const byId = new Map(layers.map((layer) => [layer.id as string, layer]));
const paint = (id: string) => byId.get(id)?.paint as Record<string, unknown>;
const minzoom = (id: string) => byId.get(id)?.minzoom as number | undefined;

/* ------------------------------- palette -------------------------------- */

describe("restrained basemap palette", () => {
  it("keeps context roads neutral while giving highways one restrained identity cue", () => {
    for (const key of [
      "localSurface",
      "localCasing",
      "arterialSurface",
      "arterialCasing",
      "bridgeSurface",
      "bridgeCasing",
    ] as const) {
      expect(chroma(CHICAGO_PALETTE[key]), `${key} chroma`).toBeLessThan(40);
    }
    // The highway is allowed one muted warm family so users can identify the
    // road class instantly; it still stays far below incident/congestion color.
    expect(chroma(CHICAGO_PALETTE.highwaySurface)).toBeGreaterThan(40);
    expect(chroma(CHICAGO_PALETTE.highwaySurface)).toBeLessThan(90);
  });

  it("keeps land, water and parks light and quiet", () => {
    for (const key of ["land", "water", "park"] as const) {
      const { l, s } = toHsl(CHICAGO_PALETTE[key]);
      expect(l, `${key} lightness`).toBeGreaterThan(0.7);
      expect(s, `${key} saturation`).toBeLessThan(0.4);
    }
  });

  it("makes highways recognizable without competing with traffic state", () => {
    const highway = toHsl(CHICAGO_PALETTE.highwaySurface);
    const arterial = toHsl(CHICAGO_PALETTE.arterialSurface);
    expect(Math.abs(highway.l - arterial.l)).toBeLessThan(0.16);
    expect(chroma(CHICAGO_PALETTE.highwaySurface)).toBeLessThan(90);
  });
});

/* ------------------------------ subtraction ------------------------------ */

describe("subtraction at city zoom", () => {
  it("has no canopy, no district tint and no building shadow", () => {
    expect(byId.has("park-canopy")).toBe(false);
    expect(byId.has("district-tint")).toBe(false);
    expect(byId.has("buildings-shadow")).toBe(false);
  });

  it("keeps the layer list deliberately small for a simulation, not a basemap clone", () => {
    expect(layers.length).toBeLessThan(25);
    expect(layers.length).toBeGreaterThanOrEqual(16);
    const ids = layers.map((layer) => layer.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("does not draw raw building footprints at all", () => {
    expect(byId.has("buildings-prominent")).toBe(false);
    expect(byId.has("buildings")).toBe(false);
    expect(byId.has("buildings-outline")).toBe(false);
    expect(byId.has("blocks")).toBe(true);
  });

  it("hides small water and small green until the camera earns them", () => {
    for (const id of ["water", "parks"] as const) {
      const opacity = paint(id)["fill-opacity"] as unknown[];
      expect(Array.isArray(opacity), `${id} is area-gated`).toBe(true);
      expect(JSON.stringify(opacity)).toContain("areaM2");
    }
    expect(AREA_MIN.waterFar).toBeGreaterThan(AREA_MIN.waterMid);
    expect(AREA_MIN.parkFar).toBeGreaterThan(AREA_MIN.parkMid);
    expect(AREA_MIN.parkMid).toBeGreaterThan(AREA_MIN.parkClose);
  });

  it("brings local streets in with the neighborhood, not the city", () => {
    expect(minzoom("roads-local")).toBeGreaterThanOrEqual(12.5);
    expect(minzoom("roads-local")).toBe(minzoom("roads-local-casing"));
  });

  it("hides individual vehicles at city zoom", () => {
    expect(VEHICLE_MINZOOM).toBeGreaterThan(13);
  });
});

/* ------------------------------- hierarchy ------------------------------- */

describe("road hierarchy by form", () => {
  it("orders highway over arterial over local by width, at every zoom", () => {
    // Read the numbers back out of the expressions: the highway must be wider
    // than the arterial, and the arterial wider than the local, both in the
    // casing allowance and in the far-zoom legibility floor.
    const numbers = (id: string) => {
      const width = paint(id)["line-width"] as unknown[];
      const found: number[] = [];
      const walk = (node: unknown) => {
        if (typeof node === "number") {
          found.push(node);
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(walk);
        }
      };
      walk(width);
      return found;
    };
    const floors = (id: string) => {
      const width = paint(id)["line-width"] as unknown[];
      // The floor terms are the second element of each ["max", floor, data] stop.
      const values: number[] = [];
      const walk = (node: unknown) => {
        if (Array.isArray(node) && node[0] === "max") {
          values.push(Number(node[1]));
          return;
        }
        if (Array.isArray(node)) {
          node.forEach(walk);
        }
      };
      walk(width);
      return values;
    };
    const highwayFloor = Math.max(...floors("roads-highway"));
    const arterialFloor = Math.max(...floors("roads-arterial"));
    const localFloor = Math.max(...floors("roads-local"));
    expect(highwayFloor).toBeGreaterThan(arterialFloor);
    expect(arterialFloor).toBeGreaterThan(localFloor);
    // And the casing allowance follows the same order.
    // Casing allowances are the small terms; the large ones are zoom stops.
    const extra = (id: string) => Math.max(...numbers(id).filter((value) => value < 5));
    expect(extra("roads-highway-casing")).toBeGreaterThan(extra("roads-arterial-casing"));
    expect(extra("roads-arterial-casing")).toBeGreaterThan(extra("roads-local-casing"));
  });

  it("sizes roads from their own physical width", () => {
    expect(JSON.stringify(roadWidthPx())).toContain("widthM");
    expect(JSON.stringify(roadWidthPx(3))).toContain("widthM");
  });

  it("keeps guardrails a close-zoom detail", () => {
    expect(minzoom("roads-highway-guardrail")).toBeGreaterThanOrEqual(14.5);
  });
});

/* -------------------------------- labels --------------------------------- */

describe("label ladder", () => {
  const labelLayers = buildLabelLayers();
  const labelById = new Map(labelLayers.map((layer) => [layer.id, layer]));

  it("reserves street names for close zoom", () => {
    expect(MAP_ZOOM.streetNames).toBeGreaterThanOrEqual(15);
    expect(MAP_ZOOM.labels).toBeLessThan(MAP_ZOOM.streetRefs);
    expect(MAP_ZOOM.streetRefs).toBeLessThan(MAP_ZOOM.streetNames);
  });

  it("keeps collision handling and a priority key on every label layer", () => {
    for (const layer of labelLayers) {
      const layout = layer.layout as Record<string, unknown>;
      expect(layout["text-allow-overlap"]).toBe(false);
      expect(layout["symbol-sort-key"]).toBeTruthy();
      expect(layout["text-padding"]).toBeGreaterThan(0);
    }
  });

  it("shows highway refs only on the spine", () => {
    const refs = labelById.get("street-refs") as unknown as { filter: unknown };
    expect(JSON.stringify(refs.filter)).toContain("motorway");
    expect(JSON.stringify(refs.filter)).not.toContain("secondary");
  });
});

/* -------------------------------- data ---------------------------------- */

describe("label and debris reduction in the GeoJSON", () => {
  it("labels each street once, not once per piece", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    // Was 1 644 pieces carrying labels; one per street name is the point.
    expect(geo.streetLabels.features.length).toBeLessThan(250);
    const names = geo.streetLabels.features.map((feature) =>
      String((feature.properties as { name?: string }).name ?? ""),
    );
    const duplicates = names.filter((name, index) => name !== "" && names.indexOf(name) !== index);
    expect(duplicates.length, `duplicate street labels: ${duplicates.slice(0, 5).join(", ")}`).toBe(
      0,
    );
  });

  it("keeps raw footprints as data but only orientation-scale green space in presentation", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    expect(geo.buildings.features.length).toBeGreaterThan(5000);
    expect(geo.parks.features.length).toBeGreaterThan(0);
    expect(geo.parks.features.length).toBeLessThan(500);
  });
});
