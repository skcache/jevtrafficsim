/**
 * Local traffic context (issue #56): the properties the brief demands, asserted.
 *
 * The sprites exist only to make Rush Hour read as busy, and every one of those
 * properties is structural rather than stylistic, so each is a test:
 *   deterministic, road-locked, spaced, bounded, and silent when there is no
 *   traffic or no ego. The simulation's own per-road counts are the only input,
 *   so a level that reports fewer vehicles shows fewer of them.
 */
import { describe, expect, it } from "vitest";
import { chicagoModel } from "./chicago-support";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { laneCentreOffsetMetres, carriagewayPairs } from "@/render/road-presentation";
import { deriveLocalTraffic, LOCAL_TRAFFIC } from "@/render/local-traffic";
import type { PresentationRoadTraffic } from "@/worker/presentation-snapshot";

const model = chicagoModel(4);
const indexes = buildDirectedPathIndexes(model);
const laneOffsets = model.city.roads.map((road) =>
  laneCentreOffsetMetres(model, road.id, carriagewayPairs(model)),
);

function traffic(roadId: number, vehicleCount: number): PresentationRoadTraffic {
  return {
    roadId,
    occupancy: vehicleCount,
    capacity: 20,
    vehicleCount,
    queuedCount: 0,
    maxBlockedWaitMs: 0,
    speedFactor: 1,
    severity: "free",
  } as unknown as PresentationRoadTraffic;
}

/** A road the ego is standing on, and its neighbours. */
const egoRoad = model.city.roads.find((road) => road.length > 40);
const egoPath = egoRoad ? model.directedPaths[egoRoad.id] : undefined;
if (!egoRoad || !egoPath || egoPath.length === 0) throw new Error("fixture road missing");
const ego = { x: egoPath[0][0], y: egoPath[0][1], roadId: egoRoad.id };

describe("local traffic context", () => {
  const entries = model.city.roads
    .filter((road) => road.length > 20)
    .slice(0, 40)
    .map((road) => traffic(road.id, road.id % 3 === 0 ? 24 : 9));

  it("is deterministic: the same frame draws the same cars", () => {
    const a = deriveLocalTraffic({ model, indexes, laneOffsets, roadTraffic: entries, ego });
    const b = deriveLocalTraffic({ model, indexes, laneOffsets, roadTraffic: entries, ego });
    expect(a).toEqual(b);
  });

  it("is road-locked: every sprite sits on its own road's path", () => {
    const sprites = deriveLocalTraffic({ model, indexes, laneOffsets, roadTraffic: entries, ego });
    expect(sprites.length).toBeGreaterThan(0);
    for (const sprite of sprites) {
      const path = model.directedPaths[sprite.roadId!];
      if (!path) continue;
      let nearest = Infinity;
      for (let i = 0; i + 1 < path.length; i += 1) {
        const [ax, ay] = path[i];
        const [bx, by] = path[i + 1];
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((sprite.x - ax) * dx + (sprite.y - ay) * dy) / len2));
        nearest = Math.min(nearest, Math.hypot(sprite.x - (ax + dx * t), sprite.y - (ay + dy * t)));
      }
      // On the carriageway: never further than a wide road's own half-width.
      expect(nearest, `road ${sprite.roadId}`).toBeLessThan(12);
    }
  });

  it("stays within the sprite budget, per road and in total", () => {
    const sprites = deriveLocalTraffic({ model, indexes, laneOffsets, roadTraffic: entries, ego });
    expect(sprites.length).toBeLessThanOrEqual(LOCAL_TRAFFIC.maxTotal);
    const perRoad = new Map<number, number>();
    for (const sprite of sprites) {
      perRoad.set(sprite.roadId!, (perRoad.get(sprite.roadId!) ?? 0) + 1);
    }
    for (const count of perRoad.values()) {
      expect(count).toBeLessThanOrEqual(LOCAL_TRAFFIC.maxPerRoad);
    }
  });

  it("shows nothing when the simulation reports no traffic", () => {
    const quiet = entries.map((entry) => ({ ...entry, vehicleCount: 0 }));
    expect(deriveLocalTraffic({ model, indexes, laneOffsets, roadTraffic: quiet, ego })).toEqual([]);
    expect(deriveLocalTraffic({ model, indexes, laneOffsets, roadTraffic: entries, ego: null })).toEqual([]);
  });

  it("scales with the simulation's own counts, not with a constant", () => {
    const light = deriveLocalTraffic({
      model,
      indexes,
      laneOffsets,
      roadTraffic: entries.map((entry) => ({ ...entry, vehicleCount: 3 })),
      ego,
    });
    const rush = deriveLocalTraffic({
      model,
      indexes,
      laneOffsets,
      roadTraffic: entries.map((entry) => ({ ...entry, vehicleCount: 30 })),
      ego,
    });
    expect(rush.length).toBeGreaterThan(light.length);
  });
});
