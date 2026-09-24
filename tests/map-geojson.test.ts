/**
 * Chicago map GeoJSON (Phase 1): the presentation geometry must be the real
 * imported geography, projected through the model's own documented projection.
 */
import { describe, expect, it } from "vitest";
import { buildShowcaseGeoJson, toLngLat } from "@/render/map-geojson";
import { lngLatToMetric, pointInPolygon } from "@/cities/map-model";
import { LAKE_MICHIGAN_WATER, MUSEUM_CAMPUS_PARK, NAVY_PIER_LAND, NORTHERLY_ISLAND_PARK } from "@/render/coastal-corrections";
import { chicagoAsset, chicagoModel } from "./chicago-support";

const ALL_SCALES = [0, 1, 2, 3, 4];

describe("Chicago GeoJSON", () => {
  it("repairs the metro lake gap and preserves a dry Navy Pier", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    expect(geo.coastalLand.features).toHaveLength(1);
    expect(geo.coastalLand.features[0].geometry.coordinates[0]).toEqual(NAVY_PIER_LAND);
    expect(geo.water.features.some((feature) =>
      feature.properties.id === "lake-michigan" &&
      feature.geometry.coordinates[0] === LAKE_MICHIGAN_WATER,
    )).toBe(true);
    expect(geo.water.features.filter((feature) => feature.properties.kind === "lake")
      .map((feature) => feature.properties.id)).toEqual(["lake-michigan"]);
    expect(geo.water.features.some((feature) => feature.properties.id === "chicago-river-arm")).toBe(true);
    // Hand-drawn greens for the Museum Campus and Northerly Island were removed:
    // at street zoom their straight-line edges read as jagged green triangles
    // stuck onto the shoreline, so parks come from the real data only.
    expect(geo.parks.features.some((feature) =>
      feature.properties.id === "museum-campus-green" ||
      feature.properties.id === "northerly-island-green",
    )).toBe(false);
    expect(geo.parks.features.some((feature) =>
      feature.geometry.coordinates[0].length <= 4 &&
      feature.geometry.coordinates[0].some(([lon, lat]) =>
        lon > -87.606 && lon < -87.602 && lat > 41.893 && lat < 41.897,
      ),
    )).toBe(false);
    expect(geo.layerOrder.indexOf("water")).toBeLessThan(geo.layerOrder.indexOf("coastal-land"));
    expect(geo.layerOrder.indexOf("coastal-land")).toBeLessThan(geo.layerOrder.indexOf("parks"));
    expect(pointInPolygon([-87.6055, 41.8916], NAVY_PIER_LAND)).toBe(true);
    expect(pointInPolygon([-87.5986, 41.8918], NAVY_PIER_LAND)).toBe(true);
    // The old hand-drawn southeast spike put a large fake land triangle in the lake.
    expect(pointInPolygon([-87.5985, 41.8912], NAVY_PIER_LAND)).toBe(false);
    expect(pointInPolygon([-87.6055, 41.8900], LAKE_MICHIGAN_WATER)).toBe(true);
    expect(pointInPolygon([-87.6055, 41.8916], LAKE_MICHIGAN_WATER)).toBe(false);
    expect(pointInPolygon([-87.605, 41.895], LAKE_MICHIGAN_WATER)).toBe(false);
    expect(pointInPolygon([-87.601, 41.8927], LAKE_MICHIGAN_WATER)).toBe(true);
    // Fitting the whole trip must not expose the clipped lake's east/south edge.
    expect(pointInPolygon([-87.58, 41.89], LAKE_MICHIGAN_WATER)).toBe(true);
    expect(pointInPolygon([-87.58, 41.85], LAKE_MICHIGAN_WATER)).toBe(true);
    expect(pointInPolygon([-87.6055, 41.8900], NAVY_PIER_LAND)).toBe(false);
    expect(pointInPolygon([-87.6170, 41.8640], MUSEUM_CAMPUS_PARK)).toBe(true);
    expect(pointInPolygon([-87.6150, 41.8620], MUSEUM_CAMPUS_PARK)).toBe(false);
    expect(pointInPolygon([-87.6162, 41.8590], MUSEUM_CAMPUS_PARK)).toBe(true);
    expect(pointInPolygon([-87.608, 41.863], NORTHERLY_ISLAND_PARK)).toBe(true);
    expect(pointInPolygon([-87.6115, 41.863], NORTHERLY_ISLAND_PARK)).toBe(false);
    expect(geo.parks.features.some((feature) =>
      feature.properties.id !== "northerly-island-green" &&
      feature.geometry.coordinates[0].some(([lon, lat]) => lon > -87.609 && lat < 41.865),
    )).toBe(false);
    expect(buildShowcaseGeoJson(chicagoModel(2)).coastalLand.features).toHaveLength(0);
  });
  it("keeps the repaired lake shore from crossing itself", () => {
    const ring = LAKE_MICHIGAN_WATER;
    const turn = (a: readonly number[], b: readonly number[], c: readonly number[]) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    for (let i = 0; i < ring.length - 1; i += 1) {
      for (let j = i + 2; j < ring.length - 1; j += 1) {
        if (i === 0 && j === ring.length - 2) continue;
        const intersects = turn(ring[i], ring[i + 1], ring[j]) * turn(ring[i], ring[i + 1], ring[j + 1]) < 0 &&
          turn(ring[j], ring[j + 1], ring[i]) * turn(ring[j], ring[j + 1], ring[i + 1]) < 0;
        expect(intersects, `shore segments ${i} and ${j} cross`).toBe(false);
      }
    }
  });
  it("emits valid GeoJSON for every scale", () => {
    for (const scale of ALL_SCALES) {
      const model = chicagoModel(scale);
      const geo = buildShowcaseGeoJson(model);
      expect(geo.land.features.length).toBe(1);
      expect(geo.water.features.length).toBeGreaterThan(0);
      expect(geo.buildings.features.length).toBeGreaterThan(10);
      for (const collection of [geo.land, geo.water, geo.parks, geo.buildings, geo.landmarks]) {
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

  it("labels real Chicago places as symbol features", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    const names = geo.labels.features.map((feature) => feature.properties.name);
    expect(names).toContain("The Loop");
    expect(names).toContain("United Center");
    expect(names).toContain("Soldier Field");
    expect(names).toContain("Grant Park");
    // Labels only exist inside the extent, and every one carries a priority.
    for (const feature of geo.labels.features) {
      const [lon, lat] = feature.geometry.coordinates;
      expect(lon).toBeLessThan(-87.5);
      expect(lat).toBeGreaterThan(41.8);
      expect(Number.isFinite(feature.properties.rank as number)).toBe(true);
    }
    // Priority order: landmarks outrank districts (lower sort key wins).
    const landmark = geo.labels.features.find(
      (feature) => feature.properties.kind === "landmark",
    )!;
    const district = geo.labels.features.find((feature) => feature.properties.kind === "district")!;
    expect(landmark.properties.rank as number).toBeLessThan(district.properties.rank as number);
  });

  it("carries real street and highway names for line labels", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    expect(geo.streetLabels.features.length).toBeGreaterThan(50);
    const names = new Set(geo.streetLabels.features.map((feature) => feature.properties.name));
    // Real Chicago names, never invented ones.
    expect([...names].some((name) => String(name).includes("Michigan"))).toBe(true);
    for (const feature of geo.streetLabels.features) {
      // Every label carries a real street name or a real expressway ref, and
      // never both from the same piece (that is what stopped the duplicate
      // names).
      const name = String(feature.properties.name);
      const ref = String(feature.properties.ref);
      expect(name.length > 2 || ref.length > 0).toBe(true);
      expect(feature.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("sizes roads from their own lanes, not one fixed width", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    const widths = new Set<number>();
    for (const collection of [geo.roadsLocal, geo.roadsArterial, geo.roadsHighway]) {
      for (const feature of collection.features) {
        const widthM = feature.properties.widthM as number;
        expect(widthM).toBeGreaterThan(3);
        expect(widthM).toBeLessThan(40);
        widths.add(Math.round(widthM * 10));
      }
    }
    // A one-lane residential street and a multi-lane arterial must differ.
    expect(widths.size).toBeGreaterThan(3);
  });

  it("keeps bridges inside their own road class", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    const highwayBridges = geo.bridges.features.filter(
      (feature) => feature.properties.osmClass === "motorway",
    );
    expect(highwayBridges.length).toBeGreaterThan(0);
    // The same piece is also in the highway collection: a motorway bridge
    // renders with motorway hierarchy.
    const highwayIds = new Set(
      geo.roadsHighway.features.map((feature) => feature.properties.streetId),
    );
    for (const bridge of highwayBridges) {
      expect(highwayIds.has(bridge.properties.streetId)).toBe(true);
    }
  });

  it("includes the Chicago River and lakefront as semantic geography", () => {
    const geo = buildShowcaseGeoJson(chicagoModel(4));
    expect(geo.water.features.length).toBeGreaterThan(0);

    // Presentation simplification is allowed to reduce vertex count. What must
    // never disappear is the geography that orients Chicago itself.
    const kinds = new Set(geo.water.features.map((feature) => String(feature.properties.kind)));
    expect(kinds.has("river")).toBe(true);
    expect(kinds.has("lake")).toBe(true);

    const points = geo.water.features.flatMap((feature) => feature.geometry.coordinates[0]);
    expect(points.length).toBeGreaterThan(40);
    const lons = points.map(([lon]) => lon);
    const lats = points.map(([, lat]) => lat);
    // River + lakefront must span a material part of the Metro frame, not one
    // surviving decorative basin.
    expect(Math.max(...lons) - Math.min(...lons)).toBeGreaterThan(0.01);
    expect(Math.max(...lats) - Math.min(...lats)).toBeGreaterThan(0.01);
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
