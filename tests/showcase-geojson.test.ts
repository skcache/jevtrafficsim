import { describe, expect, it } from "vitest";
import { compileShowcaseCity } from "@/cities/showcase-city";
import { buildShowcaseGeoJson, toLngLat } from "@/render/showcase-geojson";
import { METRES_PER_DEGREE } from "@/render/showcase-geojson";

describe("park canopy", () => {
  it("is deterministic and keeps every blob inside its park", () => {
    const model = compileShowcaseCity(4);
    const first = buildShowcaseGeoJson(model).parkCanopy;
    const second = buildShowcaseGeoJson(model).parkCanopy;
    expect(first.features.length).toBeGreaterThan(10);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    for (const feature of first.features) {
      const [lng, lat] = feature.geometry.coordinates;
      const inside = model.parks.some((polygon) => {
        let hit = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
          const [xi, yi] = polygon[i];
          const [xj, yj] = polygon[j];
          const [px, py] = toLngLat([xi, yi]);
          const [qx, qy] = toLngLat([xj, yj]);
          if (py > lat !== qy > lat) {
            const crossX = ((qx - px) * (lat - py)) / (qy - py) + px;
            if (lng < crossX) {
              hit = !hit;
            }
          }
        }
        return hit;
      });
      expect(inside, `canopy blob at ${lng},${lat} outside every park`).toBe(true);
    }
  });
});

describe("showcase GeoJSON", () => {
  it("emits valid GeoJSON for every scale", () => {
    for (const scale of [0, 1, 2, 3, 4]) {
      const model = compileShowcaseCity(scale);
      const geo = buildShowcaseGeoJson(model);
      expect(geo.land.features.length).toBe(1);
      expect(geo.districts.features.length).toBe(model.districts.length);
      expect(geo.water.features.length).toBeGreaterThan(0);
      expect(geo.buildings.features.length).toBeGreaterThan(10);
      expect(geo.parkCanopy.features.length).toBeGreaterThan(0);
      for (const feature of geo.parkCanopy.features) {
        expect(feature.geometry.type).toBe("Point");
      }
      for (const collection of [
        geo.land,
        geo.districts,
        geo.water,
        geo.parks,
        geo.buildings,
        geo.landmarks,
      ]) {
        expect(collection.type).toBe("FeatureCollection");
        for (const feature of collection.features) {
          expect(feature.type).toBe("Feature");
          expect(feature.geometry.type).toBe("Polygon");
          const ring = feature.geometry.coordinates[0];
          expect(ring.length).toBeGreaterThanOrEqual(4);
          // Closed ring, finite coordinates.
          expect(ring[0]).toEqual(ring[ring.length - 1]);
          for (const [lng, lat] of ring) {
            expect(Number.isFinite(lng)).toBe(true);
            expect(Number.isFinite(lat)).toBe(true);
            expect(Math.abs(lng)).toBeLessThan(1);
            expect(Math.abs(lat)).toBeLessThan(1);
          }
        }
      }
      for (const collection of [geo.roadsLocal, geo.roadsArterial, geo.roadsHighway, geo.bridges]) {
        for (const feature of collection.features) {
          expect(feature.geometry.type).toBe("LineString");
          expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
        }
      }
    }
  });

  it("draws each physical street piece exactly once (no doubled directions)", () => {
    const model = compileShowcaseCity(3);
    const geo = buildShowcaseGeoJson(model);
    const total =
      geo.roadsLocal.features.length +
      geo.roadsArterial.features.length +
      geo.roadsHighway.features.length +
      geo.bridges.features.length;
    expect(total).toBe(model.streets.length);
    const streetIds = new Set<string>();
    for (const feature of [
      ...geo.roadsLocal.features,
      ...geo.roadsArterial.features,
      ...geo.roadsHighway.features,
      ...geo.bridges.features,
    ]) {
      const id = `${feature.properties.streetId}`;
      const key = `${id}|${JSON.stringify(feature.geometry.coordinates[0])}`;
      expect(streetIds.has(key)).toBe(false);
      streetIds.add(key);
    }
  });

  it("places roads, bridges, water and landmarks in the same coordinate space", () => {
    const model = compileShowcaseCity(4);
    const geo = buildShowcaseGeoJson(model);
    const land = geo.land.features[0].geometry.coordinates[0];
    const insideLand = (lng: number, lat: number) =>
      lng >= land[0][0] && lng <= land[2][0] && lat >= land[0][1] && lat <= land[2][1];
    for (const feature of geo.bridges.features) {
      for (const [lng, lat] of feature.geometry.coordinates) {
        expect(insideLand(lng, lat)).toBe(true);
      }
    }
    // Bridges carry their names (used by labels/incident messaging later).
    const names = new Set(geo.bridges.features.map((feature) => feature.properties.name));
    expect(names.has("Harbor Bridge")).toBe(true);
    expect(names.has("Meridian Bridge")).toBe(true);
    // Required districts and landmarks exist at Metro.
    const districtIds = new Set(geo.districts.features.map((feature) => feature.properties.id));
    for (const id of [
      "central",
      "civic-circle",
      "west-park",
      "market",
      "riverside",
      "northworks",
      "arena",
      "highland",
      "southgate",
    ]) {
      expect(districtIds.has(id), `district ${id}`).toBe(true);
    }
    expect(geo.landmarks.features.some((feature) => feature.properties.kind === "stadium")).toBe(true);
    expect(geo.labels.some((label) => label.name === "Arena Quarter")).toBe(true);
    expect(geo.labels.some((label) => label.name === "Central")).toBe(true);
  });

  it("is deterministic and uses a compact metric projection", () => {
    const a = buildShowcaseGeoJson(compileShowcaseCity(2));
    const b = buildShowcaseGeoJson(compileShowcaseCity(2));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(toLngLat([METRES_PER_DEGREE, 0])).toEqual([1, 0]);
    expect(toLngLat([0, METRES_PER_DEGREE])).toEqual([0, 1]);
    // 7-decimal precision keeps payloads compact without visible drift.
    const [, lat] = toLngLat([1234.56789, 2345.6789]);
    expect(String(lat).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(7);
  });

  it("declares an ordered layer list with the required static grammar", () => {
    const geo = buildShowcaseGeoJson(compileShowcaseCity(3));
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
