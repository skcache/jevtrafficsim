import type { City, Intersection, Road } from "@/sim/types";
import type { TrafficState } from "@/sim/traffic";

export interface StreetSpec {
  length: number;
  speedLimit?: number;
  capacity?: number;
  closed?: boolean;
}

/**
 * One-way linear fixture: intersection i connects to i+1 via road i
 * (road ids match indices). Directed-only is fine for traffic tests.
 */
export function makeStreet(specs: StreetSpec[]): {
  city: City;
  roadIds: number[];
} {
  const intersections: Intersection[] = [];
  for (let i = 0; i <= specs.length; i += 1) {
    intersections.push({
      id: i,
      x: i * 10,
      y: 0,
      incoming: [],
      outgoing: [],
      control: "uncontrolled",
      regionId: 0,
    });
  }
  const roads: Road[] = specs.map((spec, i) => ({
    id: i,
    from: i,
    to: i + 1,
    length: spec.length,
    lanes: 1,
    speedLimit: spec.speedLimit ?? 10,
    capacity: spec.capacity ?? 4,
    kind: "local",
    closed: spec.closed ?? false,
  }));
  for (const road of roads) {
    intersections[road.from].outgoing.push(road.id);
    intersections[road.to].incoming.push(road.id);
  }
  const city: City = {
    size: "small",
    seed: 0,
    gridWidth: specs.length + 1,
    gridHeight: 1,
    intersections,
    roads,
    corridors: [],
  };
  return { city, roadIds: roads.map((road) => road.id) };
}

/** Returns a copy of the city with the given roads closed. */
export function withClosedRoads(city: City, roadIds: number[]): City {
  return {
    ...city,
    roads: city.roads.map((road) =>
      roadIds.includes(road.id) ? { ...road, closed: true } : road,
    ),
  };
}

/** Stable serialization for determinism comparisons. */
export function snapshotTraffic(state: TrafficState): string {
  const occupancy = [...state.occupancy.entries()].sort(
    (a, b) => a[0] - b[0],
  );
  const signals = [...state.signals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, signal]) => [
      id,
      signal.phaseIndex,
      signal.stage,
      signal.stageElapsedMs,
    ]);
  return JSON.stringify({
    timeMs: state.timeMs,
    vehicles: state.vehicles,
    occupancy,
    signals,
  });
}

export interface CrossArm {
  angleDeg: number;
  length: number;
  speedLimit?: number;
  capacity?: number;
}

/**
 * Crossroads fixture: one center intersection (id 0) with straight arms.
 * Arm i contributes approach road 2i (source -> center, bearing angleDeg)
 * and exit road 2i+1 (center -> exit node, continuing outward).
 */
export function makeCrossroads(options: {
  control: "signal" | "stop" | "uncontrolled";
  arms: CrossArm[];
}): {
  city: City;
  centerId: number;
  approachRoadIds: number[];
  exitRoadIds: number[];
} {
  const centerX = 100;
  const centerY = 100;
  const intersections: Intersection[] = [
    {
      id: 0,
      x: centerX,
      y: centerY,
      incoming: [],
      outgoing: [],
      control: options.control,
      regionId: 0,
    },
  ];
  const roads: Road[] = [];
  const approachRoadIds: number[] = [];
  const exitRoadIds: number[] = [];
  options.arms.forEach((arm, index) => {
    const radians = (arm.angleDeg * Math.PI) / 180;
    const dx = Math.cos(radians);
    const dy = Math.sin(radians);
    const sourceId = 1 + index * 2;
    const exitId = 2 + index * 2;
    intersections.push({
      id: sourceId,
      x: centerX - dx * arm.length,
      y: centerY - dy * arm.length,
      incoming: [],
      outgoing: [],
      control: "uncontrolled",
      regionId: 0,
    });
    intersections.push({
      id: exitId,
      x: centerX + dx * arm.length,
      y: centerY + dy * arm.length,
      incoming: [],
      outgoing: [],
      control: "uncontrolled",
      regionId: 0,
    });
    const approachId = roads.length;
    roads.push({
      id: approachId,
      from: sourceId,
      to: 0,
      length: arm.length,
      lanes: 1,
      speedLimit: arm.speedLimit ?? 10,
      capacity: arm.capacity ?? 4,
      kind: "local",
      closed: false,
    });
    const exitRoadId = roads.length;
    roads.push({
      id: exitRoadId,
      from: 0,
      to: exitId,
      length: arm.length,
      lanes: 1,
      speedLimit: arm.speedLimit ?? 10,
      capacity: arm.capacity ?? 4,
      kind: "local",
      closed: false,
    });
    intersections[sourceId].outgoing.push(approachId);
    intersections[0].incoming.push(approachId);
    intersections[0].outgoing.push(exitRoadId);
    intersections[exitId].incoming.push(exitRoadId);
    approachRoadIds.push(approachId);
    exitRoadIds.push(exitRoadId);
  });
  const city: City = {
    size: "small",
    seed: 0,
    gridWidth: 2,
    gridHeight: 2,
    intersections,
    roads,
    corridors: [],
  };
  return { city, centerId: 0, approachRoadIds, exitRoadIds };
}
