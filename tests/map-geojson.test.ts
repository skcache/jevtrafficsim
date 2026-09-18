/**
 * Chicago map GeoJSON (Phase 1): the presentation geometry must be the real
 * imported geography, projected through the model's own documented projection.
 */
import { describe, expect, it } from "vitest";
import { buildShowcaseGeoJson, toLngLat } from "@/render/map-geojson";
import { lngLatToMetric } from "@/cities/map-model";
import { chicagoAsset, chicagoModel } from "./chicago-support";

const ALL_SCALES = [0, 1, 2, 3, 4];

describe("Chicago GeoJSON", () => {
  it("emits valid GeoJSON for every scale", () => {
    for (const scale of ALL_SCALES) {
      const model = chicagoModel(scale);
      const geo = buildShowcaseGeoJson(model);
      expect(geo.land.features.length).toBe(1);
      expect(geo.water.features.length).toBeGreaterThan(0);
      expect(geo.buildings.features.length).toBeGreaterThan(10);
      for (const collection of [geo.land, geo.districts, geo.water, geo.parks, geo.buildings]) {
        expect(collection.type).toBe("FeatureCollection");
        for (const feature of collection.features) {
          expect(feature.type).toBe("Feature");
          const ring = feature.geometry.coordinates[0];
          expect(ring.length).toBeGreaterThanOrEqual(4);
          // Closed ring, finite coordinates.
          expect(ring[0]).toEqual(ring[ring.length - 1]);
          for (const [lon, lat] of ring) {
            expect(Number.isFinite(lon)).toBe(true);
            expect(Number.isFinite(lat)).toBe(true);
          }
        }
      }
    }
  });

  it("places every coordinate inside the real Chicago extent", () => {
    for (const scale of ALL_SCALES) {
      const model = chicagoModel(scale);
      const asset = chicagoAsset(scale);
      const [west, south, east, north] = asset.bbox;
      const geo = buildShowcaseGeoJson(model);
      const roads = [
        ...geo.roadsLocal.features,
        ...geo.roadsArterial.features,
        ...geo.roadsHighway.features,
        ...geo.bridges.features,
      ];
      expect(roads.length).toBeGreaterThan(10);
      for (const feature of roads) {
        for (const [lon, lat] of feature.geometry.coordinates) {
          // The bbox clips NODES; a curved edge can bulge ~100 m past it.
          expect(lon, `lon inside extent (${scale})`).toBeGreaterThanOrEqual(west - 0.002);
          expect(lon).toBeLessThanOrEqual(east + 0.002);
          expect(lat).toBeGreaterThanOrEqual(south - 0.002);
          expect(lat).toBeLessThanOrEqual(north + 0.002);
        }
      }
      // Sanity: this is Chicago, not the equator.
      expect(north).toBeGreaterThan(41.8);
      expect(north).toBeLessThan(42.0);
      expect(west).toBeLessThan(-87.5);
    }
  });

  it("round-trips metric <-> lng/lat through the documented projection", () => {
    const model = chicagoModel(2);
    const projection = model.projection;
    for (const [x, y] of [
      [0, 0],
      [1000, -500],
      [-2500.25, 3200.5],
    ]) {
      const [lon, lat] = toLngLat(projection, [x, y]);
      const [backX, backY] = lngLatToMetric(projection, lon, lat);
      // Quantization to 1e-7 degrees is ~1 cm.
      expect(Math.abs(backX - x)).toBeLessThan(0.02);
      expect(Math.abs(backY - y)).toBeLessThan(0.02);
    }
  });

  it("keeps curved OSM geometry instead of straight A->B lines", () => {
    const model = chicagoModel(2);
    const curved = model.streets.filter((piece) => piece.points.length > 2);
    expect(curved.length).toBeGreaterThan(model.streets.length * 0.3);
  });

  it("labels real Chicago places", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    const names = geo.labels.map((label) => label.name);
    expect(names).toContain("The Loop");
    expect(names).toContain("United Center");
    expect(names).toContain("Soldier Field");
    expect(names).toContain("Grant Park");
    // Labels only exist inside the extent.
    for (const label of geo.labels) {
      expect(label.at[0]).toBeLessThan(-87.5);
      expect(label.at[1]).toBeGreaterThan(41.8);
    }
  });

  it("includes the river and the lakefront water", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    expect(geo.water.features.length).toBeGreaterThan(0);
    // Water polygons must be a meaningful share of the frame.
    const points = geo.water.features.flatMap((feature) => feature.geometry.coordinates[0]);
    expect(points.length).toBeGreaterThan(100);
  });

  it("is deterministic", () => {
    const a = buildShowcaseGeoJson(chicagoModel(2));
    const b = buildShowcaseGeoJson(chicagoModel(2));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("declares an ordered layer list with the required static grammar", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(3));
    expect(geo.layerOrder[0]).toBe("land");
    expect(geo.layerOrder).toContain("water");
    expect(geo.layerOrder).toContain("buildings");
    expect(geo.layerOrder).toContain("roads-highway");
    expect(geo.layerOrder.indexOf("water")).toBeLessThan(geo.layerOrder.indexOf("buildings"));
    expect(geo.layerOrder.indexOf("buildings")).toBeLessThan(geo.layerOrder.indexOf("roads-local"));
    expect(geo.layerOrder.indexOf("roads-local")).toBeLessThan(geo.layerOrder.indexOf("roads-arterial"));
    expect(geo.layerOrder.indexOf("roads-arterial")).toBeLessThan(geo.layerOrder.indexOf("roads-highway"));
  });
});
