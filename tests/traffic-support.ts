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
  return JSON.stringify({
    timeMs: state.timeMs,
    vehicles: state.vehicles,
    occupancy,
  });
}
