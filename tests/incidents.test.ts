import { describe, expect, it } from "vitest";
import { generateCity } from "@/sim/city-generator";
import { createRng } from "@/sim/rng";
import type { City, Intersection, Road } from "@/sim/types";
import { validateIncidentScript } from "@/sim/incidents";
import {
  amplifyTrafficBurst,
  bridgeCentralityScores,
  createIncidentRuntime,
  createRuntimeCity,
  EVENT_RELEASE_COUNTS,
  physicalSegments,
  planEventRelease,
  reachableIntersectionCount,
  selectBridgeSegment,
  selectCloseRoadSegment,
  selectCrashTarget,
} from "@/sim/incidents";
import { makeStreet } from "./traffic-support";

function latticeCity(): City {
  // 2x2 lattice, ids row-major: 0(0,0) 1(10,0) 2(0,10) 3(10,10).
  // Road pairs: {0,1}, {2,3}, {4,5}, {6,7} (0-1, 0-2, 1-3, 2-3 axes).
  const intersections: Intersection[] = [
    { id: 0, x: 0, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 1, x: 10, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 2, x: 0, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    { id: 3, x: 10, y: 10, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
  ];
  const road = (id: number, from: number, to: number): Road => ({
    id,
    from,
    to,
    length: 10,
    lanes: 1,
    speedLimit: 10,
    capacity: 4,
    kind: "local",
    closed: false,
  });
  const roads: Road[] = [
    road(0, 0, 1),
    road(1, 1, 0),
    road(2, 0, 2),
    road(3, 2, 0),
    road(4, 1, 3),
    road(5, 3, 1),
    road(6, 2, 3),
    road(7, 3, 2),
  ];
  for (const r of roads) {
    intersections[r.from].outgoing.push(r.id);
    intersections[r.to].incoming.push(r.id);
  }
  return {
    size: "small",
    seed: 0,
    gridWidth: 2,
    gridHeight: 2,
    intersections,
    roads,
    corridors: [],
  };
}

describe("incident script model", () => {
  it("sorts records by (atMs, original sequence) without relying on sort stability", () => {
    const city = latticeCity();
    const runtime = createIncidentRuntime(city, {
      seed: 7,
      script: [
        { atMs: 500, kind: "crash" },
        { atMs: 100, kind: "crash" },
        { atMs: 500, kind: "crash" },
        { atMs: 200, kind: "crash" },
      ],
    });
    expect(runtime.records.map((record) => [record.scheduledAtMs, record.id])).toEqual([
      [100, 1],
      [200, 3],
      [500, 0],
      [500, 2],
    ]);
    expect(runtime.records.every((record) => record.status === "pending")).toBe(true);
  });

  it("rejects malformed entries", () => {
    const city = latticeCity();
    expect(validateIncidentScript(city, [{ atMs: -1, kind: "crash" }])).not.toEqual([]);
    expect(validateIncidentScript(city, [{ atMs: Number.NaN, kind: "crash" }])).not.toEqual([]);
    expect(
      validateIncidentScript(city, [{ atMs: 0, kind: "crash", durationMs: 0 }]),
    ).not.toEqual([]);
    expect(
      validateIncidentScript(city, [{ atMs: 0, kind: "flood" as never }]),
    ).not.toEqual([]);
    expect(
      validateIncidentScript(city, [{ atMs: 0, kind: "crash", targetRoadId: 99 }]),
    ).not.toEqual([]);
    expect(
      validateIncidentScript(city, [{ atMs: 0, kind: "event-release", centerIntersectionId: 9 }]),
    ).not.toEqual([]);
    expect(
      validateIncidentScript(city, [{ atMs: 0, kind: "traffic-burst", targetRoadId: 0 }]),
    ).not.toEqual([]);
    expect(
      validateIncidentScript(city, [{ atMs: 0, kind: "traffic-burst", centerIntersectionId: 0 }]),
    ).not.toEqual([]);
    expect(
      validateIncidentScript(city, [{ atMs: 0, kind: "crash", allowDisconnect: true }]),
    ).not.toEqual([]);
    // Valid entries pass.
    expect(
      validateIncidentScript(city, [
        { atMs: 0, kind: "traffic-burst" },
        { atMs: 100, kind: "crash", targetRoadId: 3, durationMs: 1000 },
        { atMs: 200, kind: "close-road", targetRoadId: 0, allowDisconnect: true },
        { atMs: 300, kind: "event-release", centerIntersectionId: 2 },
      ]),
    ).toEqual([]);
  });
});

describe("physical segments and connectivity", () => {
  it("resolves reverse edges structurally, not by id arithmetic", () => {
    // Forward road id 7, reverse id 3 — no adjacency in the ids at all.
    const intersections: Intersection[] = [
      { id: 0, x: 0, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
      { id: 1, x: 10, y: 0, incoming: [], outgoing: [], control: "uncontrolled", regionId: 0 },
    ];
    const roads: Road[] = [
      { id: 7, from: 0, to: 1, length: 10, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false },
      { id: 3, from: 1, to: 0, length: 10, lanes: 1, speedLimit: 10, capacity: 4, kind: "local", closed: false },
    ];
    for (const r of roads) {
      intersections[r.from].outgoing.push(r.id);
      intersections[r.to].incoming.push(r.id);
    }
    const city: City = { size: "small", seed: 0, gridWidth: 2, gridHeight: 1, intersections, roads, corridors: [] };
    const segments = physicalSegments(city);
    expect(segments.length).toBe(1);
    expect(segments[0].roadIds).toEqual([3, 7]); // sorted pair
    // Representative endpoints are those of the lowest-id road (road 3).
    expect(segments[0].from).toBe(1);
    expect(segments[0].to).toBe(0);
  });

  it("detects disconnection and refuses unsafe default closures", () => {
    // Linear street: closing either road disconnects the far node.
    const { city } = makeStreet([{ length: 10 }, { length: 10 }]);
    expect(reachableIntersectionCount(city)).toBe(3);
    expect(reachableIntersectionCount(city, new Set([1]))).toBe(2); // node 2 unreachable
    const rng = createRng(1).fork("incidents");
    expect(selectCloseRoadSegment(city, rng)).toBeNull(); // no safe candidate
  });

  it("keeps the generated network connected for a default close", () => {
    const city = generateCity("small", 42);
    const rng = createRng(42).fork("incidents");
    const segment = selectCloseRoadSegment(city, rng);
    expect(segment).not.toBeNull();
    const after = reachableIntersectionCount(city, new Set(segment?.roadIds ?? []));
    expect(after).toBe(reachableIntersectionCount(city));
  });
});

describe("bridge centrality and selection", () => {
  it("scores bridges deterministically and selects a central one", () => {
    const city = generateCity("medium-large", 42);
    const scores = bridgeCentralityScores(city);
    expect(scores.length).toBeGreaterThan(0);
    expect(bridgeCentralityScores(city)).toEqual(scores); // pure + repeatable
    const selected = selectBridgeSegment(city, createRng(42).fork("incidents"), false);
    expect(selected).not.toBeNull();
    expect(selected?.kind).toBe("bridge");
    const score = scores.find((entry) => entry.segment.key === selected?.key)?.score ?? -1;
    const best = Math.max(...scores.map((entry) => entry.score));
    expect(score).toBe(best); // never "first bridge", always a top-centrality one
    // The closure keeps the river city connected.
    expect(reachableIntersectionCount(city, new Set(selected?.roadIds ?? []))).toBe(
      reachableIntersectionCount(city),
    );
  });

  it("reports not-applicable for cities without bridges", () => {
    const city = generateCity("medium", 42); // bridgeCount 0
    expect(selectBridgeSegment(city, createRng(1).fork("incidents"), false)).toBeNull();
    expect(bridgeCentralityScores(city)).toEqual([]);
  });

  it("targets an explicit road structurally (both directions of its pair)", () => {
    const city = generateCity("medium-large", 7);
    const bridgeRoad = city.roads.find((road) => road.kind === "bridge");
    expect(bridgeRoad).toBeDefined();
    const segments = physicalSegments(city);
    const segment = segments.find((candidate) => candidate.roadIds.includes(bridgeRoad?.id ?? -1));
    expect(segment?.kind).toBe("bridge");
  });
});

describe("crash target selection", () => {
  it("uses the explicit target or a deterministic open-road draw", () => {
    const city = { ...latticeCity(), roads: latticeCity().roads.map((r) => ({ ...r, closed: r.id === 0 })) };
    expect(selectCrashTarget(city, createRng(1).fork("incidents"), 3)).toBe(3);
    const a = selectCrashTarget(city, createRng(9).fork("incidents"));
    const b = selectCrashTarget(city, createRng(9).fork("incidents"));
    expect(a).toBe(b);
    expect(a).not.toBe(0); // never a closed road by default
  });
});

describe("event release planning", () => {
  it("concentrates origins near the center and disperses destinations", () => {
    const city = generateCity("medium", 42);
    const plan = planEventRelease(city, "medium", createRng(42).fork("incidents"), 5_000);
    expect(plan).not.toBeNull();
    const origins = new Set(plan?.spawns.map((spawn) => spawn.origin));
    for (const origin of origins) {
      expect(plan?.neighborhood).toContain(origin);
    }
    // Concentration: origins use only the small neighborhood of the city.
    expect(origins.size).toBeLessThanOrEqual((plan?.neighborhood.length ?? 0));
    expect((plan?.neighborhood.length ?? 0) / city.intersections.length).toBeLessThan(0.3);
    // Destinations disperse outside the neighborhood and never equal the origin.
    for (const spawn of plan?.spawns ?? []) {
      expect(spawn.destination).not.toBe(spawn.origin);
      expect(plan?.neighborhood).not.toContain(spawn.destination);
    }
    expect(plan?.spawns.length).toBe(EVENT_RELEASE_COUNTS.medium);
    // Deterministic timing: first at atMs, all inside the release window.
    expect(plan?.spawns[0].timeMs).toBe(5_000);
    for (const spawn of plan?.spawns ?? []) {
      expect(spawn.timeMs).toBeGreaterThanOrEqual(5_000);
      expect(spawn.timeMs).toBeLessThanOrEqual(5_000 + 15_000);
    }
  });

  it("is deterministic per stream and varies across streams", () => {
    const city = generateCity("medium", 42);
    const a = planEventRelease(city, "medium", createRng(42).fork("incidents"), 0);
    const b = planEventRelease(city, "medium", createRng(42).fork("incidents"), 0);
    expect(a).toEqual(b);
    const c = planEventRelease(city, "medium", createRng(43).fork("incidents"), 0);
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it("honours an explicit center", () => {
    const city = generateCity("small", 3);
    const plan = planEventRelease(city, "small", createRng(1).fork("incidents"), 0, 5);
    expect(plan?.centerIntersectionId).toBe(5);
    expect(plan?.neighborhood).toContain(5);
  });
});

describe("traffic burst amplification", () => {
  it("injects exactly four copies per base event inside the window", () => {
    const base = [0, 1_000, 2_000, 3_000, 4_000, 5_000].map((timeMs) => ({
      timeMs,
      type: "car" as const,
      origin: timeMs % 4,
      destination: (timeMs % 4 + 1) % 4,
    }));
    const copies = amplifyTrafficBurst(base, 1_000, 3_000); // window [1000, 4000)
    expect(copies.length).toBe(3 * 4); // events at 1000, 2000, 3000
    const byTime = new Map<number, number>();
    for (const copy of copies) {
      byTime.set(copy.timeMs, (byTime.get(copy.timeMs) ?? 0) + 1);
    }
    expect([...byTime.entries()].sort((a, b) => a[0] - b[0])).toEqual([
      [1_000, 4],
      [2_000, 4],
      [3_000, 4],
    ]);
    // Copies preserve type/origin/destination of their base event.
    const origin1000 = base.find((event) => event.timeMs === 1_000);
    for (const copy of copies.filter((c) => c.timeMs === 1_000)) {
      expect(copy.type).toBe(origin1000?.type);
      expect(copy.origin).toBe(origin1000?.origin);
      expect(copy.destination).toBe(origin1000?.destination);
    }
    // Operating on the base schedule only: no recursion, repeatable.
    expect(amplifyTrafficBurst(base, 1_000, 3_000)).toEqual(copies);
  });
});

describe("runtime city isolation", () => {
  it("copies the city so incident mutations cannot leak", () => {
    const base = latticeCity();
    const before = JSON.stringify(base);
    const runtime = createRuntimeCity(base);
    expect(runtime).not.toBe(base);
    runtime.roads[0].closed = true;
    runtime.roads[0].capacity = 1;
    runtime.intersections[0].incoming.push(999);
    expect(JSON.stringify(base)).toBe(before);
    expect(runtime.roads[0]).not.toBe(base.roads[0]);
  });
});
