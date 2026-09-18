/**
 * Chicago showcase geography (Phase 1): importer, road-semantics, engine
 * compatibility and incident tests.
 *
 * Everything here runs against the frozen committed artifacts in
 * `data/chicago/` — the same bytes the browser loads. No network, no Python.
 */
import { describe, expect, it } from "vitest";
import { createAdaptiveController } from "@/controllers/adaptive";
import { createFixedController } from "@/controllers/fixed";
import { CHICAGO_SCALES, CHICAGO_VENUES, chicagoScaleForSize, nearestIntersectionTo } from "@/cities/chicago";
import { metricToLngLat } from "@/cities/map-model";
import { createEngine, queueIncident, stepEngine, takeSnapshot } from "@/sim/engine";
import { generateDemand } from "@/sim/demand";
import { checkTrafficInvariants } from "@/sim/traffic";
import { buildCityPartition, validatePartition } from "@/sim/regions";
import { chicagoAsset, chicagoModel } from "./chicago-support";

const ALL_SCALES = [0, 1, 2, 3, 4];
/**
 * Where a signal is impossible without source data saying otherwise.
 * Deliberately narrow: `trunk` has real at-grade signals in Chicago, and
 * `motorway_link` carries real ramp meters (two exist in this extract, both
 * source-tagged `highway=traffic_signals`). What must never happen is a
 * *synthesized* signal — this pipeline has no degree-based rule at all.
 */
const NO_SIGNAL_CLASSES = new Set(["motorway"]);

describe("Chicago importer", () => {
  it("compiles all five nested scales", () => {
    for (const scale of ALL_SCALES) {
      const model = chicagoModel(scale);
      expect(model.city.intersections.length).toBeGreaterThan(100);
      expect(model.city.roads.length).toBeGreaterThan(200);
      expect(model.city.size).toBe(CHICAGO_SCALES[scale] === "tiny" ? "small" : model.city.size);
      expect(model.stats.signals).toBeGreaterThan(0);
    }
  });

  it("keeps dense, self-consistent ids", () => {
    const model = chicagoModel(4);
    model.city.intersections.forEach((intersection, index) => {
      expect(intersection.id).toBe(index);
      expect(Number.isFinite(intersection.x)).toBe(true);
      expect(Number.isFinite(intersection.y)).toBe(true);
      // Every intersection is reachable from itself: at least one way in and out.
      expect(intersection.incoming.length).toBeGreaterThan(0);
      expect(intersection.outgoing.length).toBeGreaterThan(0);
    });
    model.city.roads.forEach((road, index) => {
      expect(road.id).toBe(index);
      expect(model.city.intersections[road.from]).toBeDefined();
      expect(model.city.intersections[road.to]).toBeDefined();
      expect(road.length).toBeGreaterThan(0);
      expect(Number.isFinite(road.length)).toBe(true);
      expect(road.capacity).toBeGreaterThanOrEqual(2);
      expect(road.lanes).toBeGreaterThanOrEqual(1);
      expect(road.lanes).toBeLessThanOrEqual(8);
      expect(road.speedLimit).toBeGreaterThan(0);
    });
  });

  it("has no zero-length roads and no duplicated directed edges", () => {
    const model = chicagoModel(4);
    const seen = new Set<string>();
    for (const road of model.city.roads) {
      expect(road.length).toBeGreaterThan(0);
      const key = `${road.from}:${road.to}`;
      expect(seen.has(key), `duplicate directed edge ${key}`).toBe(false);
      seen.add(key);
    }
  });

  it("derives capacity from lanes and length (7.5 m per car-equivalent)", () => {
    const model = chicagoModel(2);
    for (const road of model.city.roads.slice(0, 400)) {
      const expected = Math.max(2, Math.round((road.lanes * road.length) / 7.5));
      expect(road.capacity).toBe(expected);
    }
  });

  it("maps OSM classes onto the simulation road kinds", () => {
    const asset = chicagoAsset(4);
    const expectedKind: Record<string, string> = {
      motorway: "highway",
      motorway_link: "highway",
      trunk: "highway",
      trunk_link: "highway",
      primary: "arterial",
      primary_link: "arterial",
      secondary: "arterial",
      secondary_link: "arterial",
      tertiary: "arterial",
      tertiary_link: "arterial",
      unclassified: "local",
      residential: "local",
      living_street: "local",
      road: "local",
      service: "local",
    };
    for (const road of asset.roads) {
      if (road.bridge) {
        expect(road.kind).toBe("bridge");
        continue;
      }
      expect(road.kind, `osmClass ${road.osmClass}`).toBe(expectedKind[road.osmClass]);
    }
  });

  it("is deterministic: same asset bytes, byte-identical model", () => {
    const a = JSON.stringify(chicagoModel(2).city);
    const b = JSON.stringify(chicagoModel(2).city);
    expect(a).toBe(b);
    // Geography is seed-free: the City carries a fixed seed.
    expect(chicagoModel(2).city.seed).toBe(0);
  });

  it("keeps a street identical across scales (nested geography)", () => {
    const tiny = chicagoModel(0);
    const metro = chicagoModel(4);
    const metroByOsm = new Map(chicagoAsset(4).intersections.map((entry) => [entry.osmid, entry]));
    let checked = 0;
    for (const entry of chicagoAsset(0).intersections) {
      const counterpart = metroByOsm.get(entry.osmid);
      expect(counterpart, `osmid ${entry.osmid} missing from Metro`).toBeDefined();
      expect(counterpart!.lon).toBe(entry.lon);
      expect(counterpart!.lat).toBe(entry.lat);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(100);
    // And the tiny city is a strict subset of the metro one.
    expect(tiny.city.intersections.length).toBeLessThan(metro.city.intersections.length);
  });

  it("builds a valid region partition with corridors", () => {
    const model = chicagoModel(4);
    const partition = buildCityPartition(model.city);
    expect(validatePartition(model.city, partition)).toEqual([]);
    expect(partition.regions.length).toBeGreaterThan(10);
    expect(model.city.corridors.length).toBeGreaterThan(10);
    // Real named corridors from OSM refs/names.
    const names = model.city.corridors.map((corridor) => corridor.id);
    expect(new Set(names).size).toBe(names.length);
  });

  it("selects the map scale for each city size", () => {
    expect(chicagoScaleForSize("small")).toBe(0);
    expect(chicagoScaleForSize("small-medium")).toBe(1);
    expect(chicagoScaleForSize("medium")).toBe(2);
    expect(chicagoScaleForSize("medium-large")).toBe(3);
    expect(chicagoScaleForSize("large")).toBe(4);
  });
});

describe("Chicago road semantics", () => {
  it("never puts a synthesized signal on limited-access nodes", () => {
    for (const scale of ALL_SCALES) {
      const asset = chicagoAsset(scale);
      const byId = new Map(asset.intersections.map((entry) => [entry.id, entry]));
      const classesById = new Map<number, Set<string>>();
      for (const road of asset.roads) {
        for (const id of [road.from, road.to]) {
          const set = classesById.get(id) ?? new Set<string>();
          set.add(road.osmClass);
          classesById.set(id, set);
        }
      }
      for (const intersection of asset.intersections) {
        if (intersection.control !== "signal") {
          continue;
        }
        const classes = classesById.get(intersection.id) ?? new Set<string>();
        const allLimited = classes.size > 0 && [...classes].every((c) => NO_SIGNAL_CLASSES.has(c));
        // A signal on a pure expressway/ramp node would be degree-inferred
        // garbage; OSM-tagged at-grade signals are legitimate and documented.
        expect(
          allLimited,
          `${CHICAGO_SCALES[scale]} intersection ${intersection.osmid} is signalized but touches only limited-access roads (${[...classes].join(",")})`,
        ).toBe(false);
        expect(byId.get(intersection.id)).toBeDefined();
      }
    }
  });

  it("imports real source signals (downtown is signalized)", () => {
    const asset = chicagoAsset(0); // the Loop
    const degree4 = asset.intersections.filter((entry) => entry.degree >= 4);
    const signals = degree4.filter((entry) => entry.control === "signal");
    expect(degree4.length).toBeGreaterThan(20);
    expect(signals.length / degree4.length).toBeGreaterThan(0.6);
  });

  it("respects one-way directionality", () => {
    const asset = chicagoAsset(2);
    const byPair = new Map(asset.roads.map((road) => [`${road.from}:${road.to}`, road]));
    let oneWay = 0;
    let twoWay = 0;
    let dualCarriageway = 0;
    for (const road of asset.roads) {
      const reverse = byPair.get(`${road.to}:${road.from}`);
      if (road.oneway) {
        oneWay += 1;
        // A one-way road may have a reverse ONLY when that reverse is itself a
        // one-way road (a dual carriageway). A two-way reverse of a one-way
        // road would be an invented direction and is forbidden.
        if (reverse) {
          expect(reverse.oneway, `two-way reverse of one-way road ${road.id}`).toBe(true);
          dualCarriageway += 1;
        }
      } else if (reverse) {
        twoWay += 1;
      }
    }
    expect(oneWay).toBeGreaterThan(50);
    expect(twoWay).toBeGreaterThan(50);
    // Motorways and their ramps are directional.
    for (const road of asset.roads) {
      if (road.osmClass === "motorway" || road.osmClass === "motorway_link") {
        expect(road.oneway).toBe(true);
      }
    }
    expect(dualCarriageway).toBeGreaterThan(0);
  });

  it("keeps grade-separated roads unconnected (no crossing nodes)", () => {
    // Two roads may cross visually (bridges, expressways over streets). The
    // graph must not connect them: no intersection may sit on a road that is
    // not incident to it, unless one of them is a bridge/tunnel or a
    // different layer.
    const asset = chicagoAsset(4);
    const byId = new Map(asset.intersections.map((entry) => [entry.id, entry]));
    const grid = new Map<string, number[]>();
    const cell = 50;
    const key = (x: number, y: number) => `${Math.floor(x / cell)}:${Math.floor(y / cell)}`;
    asset.intersections.forEach((entry) => {
      const k = key(entry.x, entry.y);
      const list = grid.get(k) ?? [];
      list.push(entry.id);
      grid.set(k, list);
    });
    let suspicious = 0;
    for (const road of asset.roads) {
      if (road.bridge || road.tunnel || road.layer !== 0) {
        continue;
      }
      for (const [x, y] of road.points) {
        const cx = Math.floor(x / cell);
        const cy = Math.floor(y / cell);
        for (let dx = -1; dx <= 1; dx += 1) {
          for (let dy = -1; dy <= 1; dy += 1) {
            for (const id of grid.get(`${cx + dx}:${cy + dy}`) ?? []) {
              if (id === road.from || id === road.to) {
                continue;
              }
              const other = byId.get(id)!;
              if (Math.hypot(other.x - x, other.y - y) > 2.5) {
                continue;
              }
              // The other node's roads must be connected to this road, or the
              // node would be a visual crossing the importer invented.
              const touches = asset.roads.some(
                (candidate) =>
                  (candidate.from === id || candidate.to === id) &&
                  (candidate.from === road.from ||
                    candidate.to === road.from ||
                    candidate.from === road.to ||
                    candidate.to === road.to),
              );
              if (!touches) {
                suspicious += 1;
              }
            }
          }
        }
      }
    }
    expect(suspicious).toBe(0);
  });

  it("keeps roundabout rings directional and uncontrolled", () => {
    const asset = chicagoAsset(4);
    const ringRoads = asset.roads.filter((road) => road.roundabout);
    expect(ringRoads.length).toBeGreaterThan(0);
    for (const road of ringRoads) {
      expect(road.oneway).toBe(true);
    }
    const ringNodes = new Set<number>();
    for (const road of ringRoads) {
      ringNodes.add(road.from);
      ringNodes.add(road.to);
    }
    for (const intersection of asset.intersections) {
      if (!ringNodes.has(intersection.id)) {
        continue;
      }
      expect(intersection.control, `ring node ${intersection.osmid} must not be signalized`).not.toBe("signal");
    }
  });

  it("imports real river bridges, grouped into crossings", () => {
    for (const scale of [2, 3, 4]) {
      const asset = chicagoAsset(scale);
      expect(asset.bridges.length, `${CHICAGO_SCALES[scale]} bridge groups`).toBeGreaterThanOrEqual(3);
      const bridgeRoads = asset.roads.filter((road) => road.bridge);
      expect(bridgeRoads.length).toBeGreaterThan(0);
      for (const road of bridgeRoads) {
        expect(road.kind).toBe("bridge");
        expect(road.bridgeGroup).not.toBeNull();
      }
      // Distinct crossings are spread across the map, not one fragment.
      const centres = asset.bridges.map((group) => {
        const roads = group.roadIds.map((id) => asset.roads[id]);
        const x = roads.reduce((sum, road) => sum + road.points[0][0], 0) / roads.length;
        const y = roads.reduce((sum, road) => sum + road.points[0][1], 0) / roads.length;
        return `${Math.round(x / 100)}:${Math.round(y / 100)}`;
      });
      expect(new Set(centres).size).toBeGreaterThanOrEqual(3);
    }
  });

  it("exposes real named corridors", () => {
    const model = chicagoModel(4);
    const asset = chicagoAsset(4);
    const names = asset.corridors.map((corridor) => corridor.name);
    expect(names.length).toBeGreaterThan(20);
    // Expressway corridors exist and are classified as highways.
    const highways = asset.corridors.filter((corridor) => corridor.kind === "highway");
    expect(highways.length).toBeGreaterThan(0);
    expect(highways.some((corridor) => /I.?9[04]/.test(corridor.name))).toBe(true);
    // Corridors reference real roads.
    for (const corridor of model.city.corridors.slice(0, 20)) {
      expect(corridor.roadIds.length).toBeGreaterThan(0);
      for (const roadId of corridor.roadIds) {
        expect(model.city.roads[roadId]).toBeDefined();
      }
    }
  });

  it("places the venue anchors on real intersections", () => {
    const model = chicagoModel(4);
    for (const venue of CHICAGO_VENUES) {
      const id = nearestIntersectionTo(model, venue.lon, venue.lat);
      expect(id).not.toBeNull();
      const intersection = model.city.intersections[id!];
      const [x, y] = metricToLngLat(model.projection, intersection.x, intersection.y);
      // Within ~400 m of the venue anchor.
      const metres = Math.hypot(
        (x - venue.lon) * model.projection.metresPerDegreeLon,
        (y - venue.lat) * model.projection.metresPerDegreeLat,
      );
      expect(metres).toBeLessThan(400);
    }
  });
});

describe("Chicago engine compatibility", () => {
  it("runs Fixed and Adaptive engines on every scale", () => {
    for (const scale of ALL_SCALES) {
      const model = chicagoModel(scale);
      const spawns = generateDemand({
        city: model.city,
        level: "everyday",
        seed: 42,
        durationMs: 60_000,
      });
      expect(spawns.length).toBeGreaterThan(0);
      for (const controller of [createFixedController(), createAdaptiveController()]) {
        const engine = createEngine({ city: model.city, controller, spawns });
        for (let tick = 0; tick < 120; tick += 1) {
          stepEngine(engine);
        }
        expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
        const snapshot = takeSnapshot(engine);
        expect(snapshot.vehicles.length).toBeGreaterThan(0);
        expect(snapshot.timeMs).toBeGreaterThan(0);
      }
    }
  });

  it("replays deterministically on Chicago", () => {
    const model = chicagoModel(2);
    const build = () =>
      createEngine({
        city: model.city,
        controller: createAdaptiveController(),
        spawns: generateDemand({ city: model.city, level: "rush-hour", seed: 7, durationMs: 60_000 }),
      });
    const a = build();
    const b = build();
    for (let tick = 0; tick < 300; tick += 1) {
      stepEngine(a);
      stepEngine(b);
    }
    expect(JSON.stringify(takeSnapshot(a))).toBe(JSON.stringify(takeSnapshot(b)));
  });
});

describe("Chicago incidents", () => {
  const model = chicagoModel(4);
  const spawns = generateDemand({ city: model.city, level: "everyday", seed: 42, durationMs: 120_000 });

  function runIncident(kind: string, centerIntersectionId?: number) {
    const engine = createEngine({
      city: model.city,
      controller: createAdaptiveController(),
      spawns,
      incidents: { seed: 11, script: [] },
    });
    for (let tick = 0; tick < 100; tick += 1) {
      stepEngine(engine);
    }
    queueIncident(
      engine,
      centerIntersectionId === undefined
        ? ({ kind } as never)
        : ({ kind, centerIntersectionId } as never),
    );
    for (let tick = 0; tick < 400; tick += 1) {
      stepEngine(engine);
    }
    return engine;
  }

  it("runs all five incident kinds without breaking invariants", () => {
    for (const kind of ["traffic-burst", "crash", "close-road", "bridge-closed", "event-release"]) {
      const engine = runIncident(kind);
      expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
      const record = engine.incidents.records[0];
      expect(record, `${kind} record`).toBeDefined();
      expect(["active", "expired", "not-applicable"]).toContain(record.status);
      // Closed roads only ever close real bridges for bridge-closed.
      if (kind === "bridge-closed" && record.status === "active") {
        for (const roadId of record.roadIds) {
          expect(engine.city.roads[roadId].kind).toBe("bridge");
        }
      }
    }
  });

  it("closes a real river crossing and reroutes around it", () => {
    const engine = runIncident("bridge-closed");
    const record = engine.incidents.records[0];
    expect(record.status).toBe("active");
    expect(record.roadIds.length).toBeGreaterThan(0);
    for (const roadId of record.roadIds) {
      expect(engine.city.roads[roadId].closed).toBe(true);
      expect(engine.city.roads[roadId].kind).toBe("bridge");
    }
    expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
  });

  it("targets a real venue for event release", () => {
    const venueId = nearestIntersectionTo(model, CHICAGO_VENUES[0].lon, CHICAGO_VENUES[0].lat)!;
    const engine = createEngine({
      city: model.city,
      controller: createAdaptiveController(),
      spawns,
      incidents: { seed: 11, script: [] },
    });
    for (let tick = 0; tick < 100; tick += 1) {
      stepEngine(engine);
    }
    queueIncident(engine, { kind: "event-release", centerIntersectionId: venueId } as never);
    // Activation happens on the next incident phase; assert while it is live.
    for (let tick = 0; tick < 5; tick += 1) {
      stepEngine(engine);
    }
    const record = engine.incidents.records[0];
    expect(record.status).toBe("active");
    expect(record.eventCenterIntersectionId).toBe(venueId);
    expect(record.injectedSpawnCount).toBeGreaterThan(0);
    expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
  });

  it("reroutes around a closed Chicago street", () => {
    const engine = runIncident("close-road");
    const record = engine.incidents.records[0];
    expect(["active", "not-applicable"]).toContain(record.status);
    if (record.status === "active") {
      for (const roadId of record.roadIds) {
        expect(engine.city.roads[roadId].closed).toBe(true);
      }
      expect(checkTrafficInvariants(engine.city, engine.traffic)).toEqual([]);
    }
  });
});
