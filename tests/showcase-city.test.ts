import { describe, expect, it } from "vitest";
import {
  compileShowcaseCity,
  SHOWCASE_SIZES,
  showcaseCity,
  showcaseScaleForSize,
} from "@/cities/showcase-city";
import { pathLength } from "@/cities/paths";
import { physicalSegments } from "@/sim/incidents";

const SCALES = [0, 1, 2, 3, 4] as const;

describe("showcase city compilation", () => {
  it("compiles every scale into a valid dense city", () => {
    for (const scale of SCALES) {
      const model = compileShowcaseCity(scale);
      const { city } = model;
      expect(city.intersections.length, `scale ${scale} intersections`).toBeGreaterThan(20);
      expect(city.roads.length, `scale ${scale} roads`).toBeGreaterThan(40);
      // Dense ids: index === id everywhere.
      city.intersections.forEach((intersection, index) => {
        expect(intersection.id).toBe(index);
      });
      city.roads.forEach((road, index) => {
        expect(road.id).toBe(index);
        expect(road.from).toBeGreaterThanOrEqual(0);
        expect(road.to).toBeLessThan(city.intersections.length);
        expect(road.length).toBeGreaterThan(0);
        expect(city.intersections[road.from].outgoing).toContain(road.id);
        expect(city.intersections[road.to].incoming).toContain(road.id);
      });
      // No duplicate directed pairs (multi-edges would break routing assumptions).
      const pairs = new Set<string>();
      for (const road of city.roads) {
        const key = `${road.from}>${road.to}`;
        expect(pairs.has(key), `duplicate pair at scale ${scale}: ${key}`).toBe(false);
        pairs.add(key);
      }
      // No sliver segments: every piece is a real block-scale road.
      for (const piece of model.streets) {
        expect(piece.length, `sliver piece on ${piece.streetId} at scale ${scale}`).toBeGreaterThan(3);
      }
      // Every directed road maps to a presentation path of matching length.
      model.streets.forEach((piece) => {
        for (const roadId of piece.roadIds) {
          const path = model.directedPaths[roadId];
          expect(path).not.toBeNull();
          expect(pathLength(path!)).toBeCloseTo(city.roads[roadId].length, 6);
        }
      });
    }
  });

  it("keeps every scale fully connected", () => {
    for (const scale of SCALES) {
      const { city } = compileShowcaseCity(scale);
      const adjacency = new Map<number, Set<number>>();
      for (const road of city.roads) {
        if (!adjacency.has(road.from)) adjacency.set(road.from, new Set());
        adjacency.get(road.from)!.add(road.to);
      }
      const seen = new Set<number>([0]);
      const queue = [0];
      while (queue.length > 0) {
        const node = queue.pop()!;
        for (const next of adjacency.get(node) ?? []) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.size, `scale ${scale} connected nodes`).toBe(city.intersections.length);
    }
  });

  it("grows monotonically: each scale contains the previous one's districts", () => {
    for (let scale = 0; scale < 4; scale += 1) {
      const smaller = compileShowcaseCity(scale);
      const larger = compileShowcaseCity(scale + 1);
      const smallerDistricts = new Set(smaller.districts.map((district) => district.id));
      for (const id of smallerDistricts) {
        expect(larger.districts.some((district) => district.id === id)).toBe(true);
      }
      // Nested geography: every intersection of the smaller scale exists at the
      // same coordinates in the larger one.
      const largerCoordinates = new Set(
        larger.city.intersections.map((intersection) => `${intersection.x}|${intersection.y}`),
      );
      for (const intersection of smaller.city.intersections) {
        expect(
          largerCoordinates.has(`${intersection.x}|${intersection.y}`),
          `scale ${scale} node (${intersection.x},${intersection.y}) missing at ${scale + 1}`,
        ).toBe(true);
      }
    }
  });

  it("keeps overlapping street geometry stable between scales", () => {
    // A street present at two scales keeps the same overall geometry: same
    // extent (first/last point) and same total length. Splitting into pieces
    // may differ because larger scales add junctions along it.
    const byStreet = (model: ReturnType<typeof compileShowcaseCity>) => {
      const map = new Map<string, { first: readonly number[]; last: readonly number[]; total: number }>();
      for (const piece of model.streets) {
        const entry = map.get(piece.streetId);
        if (!entry) {
          map.set(piece.streetId, {
            first: piece.points[0],
            last: piece.points[piece.points.length - 1],
            total: piece.length,
          });
        } else {
          // Track the street's overall extent: the last piece's far end.
          entry.last = piece.points[piece.points.length - 1];
          entry.total += piece.length;
        }
      }
      return map;
    };
    const medium = byStreet(compileShowcaseCity(2));
    const metro = byStreet(compileShowcaseCity(4));
    for (const [streetId, entry] of medium) {
      const larger = metro.get(streetId);
      expect(larger, `${streetId} missing in metro`).toBeDefined();
      expect(larger!.first).toEqual(entry.first);
      expect(larger!.last).toEqual(entry.last);
      expect(larger!.total).toBeCloseTo(entry.total, 6);
    }
  });

  it("introduces river, bridges, highway and stadium at the expected scales", () => {
    const tiny = compileShowcaseCity(0);
    expect(tiny.water.length).toBeGreaterThan(0); // river polygon is authored data
    expect(tiny.city.roads.some((road) => road.kind === "bridge")).toBe(false);
    expect(tiny.landmarks.some((landmark) => landmark.kind === "stadium")).toBe(false);

    const small = compileShowcaseCity(1);
    expect(small.city.roads.some((road) => road.kind === "bridge")).toBe(false);
    expect(small.districts.map((district) => district.id)).toContain("civic-circle");
    expect(small.districts.map((district) => district.id)).toContain("market");

    const medium = compileShowcaseCity(2);
    const mediumBridgeNames = new Set(
      medium.streets.filter((piece) => piece.bridge).map((piece) => piece.bridge!.name),
    );
    expect(mediumBridgeNames).toEqual(new Set(["Harbor Bridge", "Mill Bridge"]));
    // Each bridge is split at the waterfront road: 4 physical segments × 2 directions.
    const mediumBridgeRoads = medium.city.roads.filter((road) => road.kind === "bridge");
    expect(mediumBridgeRoads.length).toBe(8);
    expect(medium.districts.map((district) => district.id)).toContain("riverside");
    expect(medium.districts.map((district) => district.id)).toContain("northworks");

    const large = compileShowcaseCity(3);
    expect(large.city.roads.some((road) => road.kind === "highway")).toBe(true);
    expect(large.landmarks.some((landmark) => landmark.kind === "stadium")).toBe(true);
    expect(large.districts.map((district) => district.id)).toContain("arena");

    const metro = compileShowcaseCity(4);
    expect(metro.districts.map((district) => district.id)).toContain("highland");
    expect(metro.districts.map((district) => district.id)).toContain("southgate");
    expect(metro.city.roads.length).toBeGreaterThan(large.city.roads.length);
  });

  it("keeps exactly one critical bridge and a secondary crossing", () => {
    const metro = compileShowcaseCity(4);
    const bridgeNames = new Set(
      metro.streets.filter((piece) => piece.bridge).map((piece) => piece.bridge!.name),
    );
    expect(bridgeNames).toEqual(new Set(["Harbor Bridge", "Mill Bridge", "Meridian Bridge"]));
    // Bridge-closed selection needs segments: physical bridge segments exist
    // (Harbor and Mill are each split at the waterfront; the Meridian crossing
    // is one segment).
    const segments = physicalSegments(metro.city).filter((segment) => segment.kind === "bridge");
    expect(segments.length).toBe(5);
  });

  it("derives controls, regions and corridors", () => {
    const metro = compileShowcaseCity(4);
    const { city } = metro;
    expect(metro.stats.signals).toBeGreaterThan(20);
    expect(metro.stats.stops).toBeGreaterThan(5);
    expect(city.intersections.every((intersection) => intersection.regionId >= 0)).toBe(true);
    expect(Math.max(...city.intersections.map((intersection) => intersection.regionId))).toBeLessThan(
      metro.districts.length,
    );
    expect(city.corridors.length).toBeGreaterThanOrEqual(5);
    for (const corridor of city.corridors) {
      expect(corridor.roadIds.length).toBeGreaterThan(0);
      for (const roadId of corridor.roadIds) {
        expect(city.roads[roadId]).toBeDefined();
      }
    }
    // The civic centre is the roundabout: uncontrolled with many approaches.
    const civic = city.intersections.find(
      (intersection) => Math.hypot(intersection.x - 1150, intersection.y - 800) < 60,
    );
    expect(civic?.control).toBe("uncontrolled");
    expect((civic?.incoming.length ?? 0) + (civic?.outgoing.length ?? 0)).toBeGreaterThanOrEqual(16);
  });

  it("is deterministic and independent of any traffic seed", () => {
    const a = compileShowcaseCity(3);
    const b = compileShowcaseCity(3);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // The cached accessor returns the identical object (no rebuild per call).
    expect(showcaseCity(3)).toBe(showcaseCity(3));
    // Compilation takes no seed: geometry cannot move with traffic seeds.
    expect(a.city.seed).toBe(0);
  });

  it("produces buildings only on land, at the right scales", () => {
    const tiny = compileShowcaseCity(0);
    expect(tiny.buildings.length).toBeGreaterThan(10);
    const metro = compileShowcaseCity(4);
    expect(metro.buildings.length).toBeGreaterThan(tiny.buildings.length * 2);
    // Deterministic footprints.
    expect(JSON.stringify(compileShowcaseCity(4).buildings)).toBe(JSON.stringify(metro.buildings));
    // No building sits inside the river.
    const river = metro.water[0];
    const insideRiver = metro.buildings.filter((building) => {
      const center: [number, number] = [
        building.polygon.reduce((sum, point) => sum + point[0], 0) / building.polygon.length,
        building.polygon.reduce((sum, point) => sum + point[1], 0) / building.polygon.length,
      ];
      let inside = false;
      for (let i = 0, j = river.length - 1; i < river.length; j = i, i += 1) {
        const [xi, yi] = river[i];
        const [xj, yj] = river[j];
        if (yi > center[1] !== yj > center[1] && center[0] < ((xj - xi) * (center[1] - yi)) / (yj - yi) + xi) {
          inside = !inside;
        }
      }
      return inside;
    });
    expect(insideRiver.length).toBe(0);
  });

  it("maps CitySize to scale indices and exposes camera targets", () => {
    expect(showcaseScaleForSize("small")).toBe(0);
    expect(showcaseScaleForSize("small-medium")).toBe(1);
    expect(showcaseScaleForSize("medium")).toBe(2);
    expect(showcaseScaleForSize("medium-large")).toBe(3);
    expect(showcaseScaleForSize("large")).toBe(4);
    expect(SHOWCASE_SIZES.length).toBe(5);
    for (const scale of SCALES) {
      const model = compileShowcaseCity(scale);
      // The central camera is a small downtown box: a few blocks, not the city.
      const width = model.centralCamera.maxX - model.centralCamera.minX;
      const height = model.centralCamera.maxY - model.centralCamera.minY;
      expect(width).toBeGreaterThan(300);
      expect(width).toBeLessThan(900);
      expect(height).toBeGreaterThan(200);
      expect(height).toBeLessThan(700);
      expect(model.cityCamera.maxX - model.cityCamera.minX).toBeGreaterThan(width * 2);
    }
  });
});
