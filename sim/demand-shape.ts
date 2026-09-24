/**
 * Demand SHAPE (Issue: genuine stress for the public Chicago run).
 *
 * Volume alone does not make a city stressful — uniform OD pairs spread thin
 * over 2 300 intersections mostly add background noise. Shape is what creates
 * the bottlenecks a citywide controller can actually do something about:
 * a downtown morning peak, an evening exodus, arterial-heavy loading, crossings
 * under pressure, a venue emptying into the network.
 *
 * Every shape is a PURE deterministic weight over (origin, destination). The
 * sampler draws a small fixed tournament of candidates from the existing `od`
 * stream and takes the heaviest, so shape costs a constant number of draws per
 * spawn, never a rejection loop, and the same seed always produces the same
 * demand. `uniform` keeps the original single-draw path byte for byte, so the
 * default world (and every pinned receipt) is untouched.
 *
 * Controller identity is absent on purpose: the world must be identical for
 * Fixed, Adaptive and Jev or the comparison means nothing.
 */
import type { City, IntersectionId, RoadId } from "./types";

export const DEMAND_SHAPES = [
  "uniform",
  "downtown-bound",
  "outbound",
  "corridor-heavy",
  "bridge-pressure",
  "event-surge",
] as const;

export type DemandShapeName = (typeof DEMAND_SHAPES)[number];

/** Candidates drawn per spawn when a shape is in force (weighted tournament). */
export const SHAPE_TOURNAMENT = 4;

export interface DemandShapeContext {
  /** Busiest intersections by degree — the "downtown" proxy. */
  readonly core: ReadonlySet<IntersectionId>;
  /** Longest-budget corridors' endpoints — the arterial proxy. */
  readonly arterial: ReadonlySet<IntersectionId>;
  /**
   * Endpoints of expressway-kind roads: the commute spine (IDOT AADT: the
   * expressways carry the largest volumes, so a Chicago morning peak should be
   * loading THESE, not arbitrary local blocks).
   */
  readonly highways: ReadonlySet<IntersectionId>;
  /** Endpoints of arterial-kind roads — IDOT functional classification. */
  readonly arterialRoads: ReadonlySet<IntersectionId>;
  /** Endpoints of bridge roads — where crossings land. */
  readonly bridges: ReadonlySet<IntersectionId>;
  /** The single busiest intersection: where an event lets out. */
  readonly venue: IntersectionId;
}

export interface DemandShape {
  readonly name: DemandShapeName;
  /** Relative preference for a pair. Relative only: the tournament compares. */
  weight(origin: IntersectionId, destination: IntersectionId, context: DemandShapeContext): number;
}

/**
 * Structural landmarks of a city, computed once per run in O(roads).
 *
 * Deterministic: degree and length are exact, and ties break by id, so the same
 * city always yields the same landmarks.
 */
export function shapeContext(city: City): DemandShapeContext {
  const degree = new Map<IntersectionId, number>();
  const bridgeEnds: IntersectionId[] = [];
  const arterialScore = new Map<IntersectionId, number>();
  const highwayEnds = new Set<IntersectionId>();
  const arterialEnds = new Set<IntersectionId>();

  for (const road of city.roads) {
    const from = road.from;
    const to = road.to;
    degree.set(from, (degree.get(from) ?? 0) + 1);
    degree.set(to, (degree.get(to) ?? 0) + 1);
    if (road.kind === "bridge") {
      bridgeEnds.push(from, to);
    }
    if (road.kind === "highway") {
      highwayEnds.add(from);
      highwayEnds.add(to);
    }
    if (road.kind === "arterial") {
      arterialEnds.add(from);
      arterialEnds.add(to);
    }
    // An arterial is a road that carries you a long way quickly: length over
    // free-flow travel time is exactly its speed limit, so rank by length and
    // break ties by id — the same ordering a viewer would produce.
    const score = road.length;
    arterialScore.set(from, Math.max(arterialScore.get(from) ?? 0, score));
    arterialScore.set(to, Math.max(arterialScore.get(to) ?? 0, score));
  }

  const byValueThenId = <T extends number>(
    entries: Iterable<[number, T]>,
    descending: boolean,
  ): number[] =>
    [...entries]
      .sort((a, b) => (descending ? b[1] - a[1] || a[0] - b[0] : a[1] - b[1] || a[0] - b[0]))
      .map(([id]) => id);

  const CORE_SIZE = 12;
  const core = new Set(byValueThenId(degree.entries(), true).slice(0, CORE_SIZE));
  const arterial = new Set(byValueThenId(arterialScore.entries(), true).slice(0, CORE_SIZE));
  const bridges = new Set(bridgeEnds);
  const venue = byValueThenId(degree.entries(), true)[0] ?? 0;

  return { core, arterial, bridges, venue, highways: highwayEnds, arterialRoads: arterialEnds };
}

export const SHAPES: Record<DemandShapeName, DemandShape> = {
  uniform: {
    name: "uniform",
    weight: () => 1,
  },
  /** Morning peak: anywhere → downtown. */
  "downtown-bound": {
    name: "downtown-bound",
    /**
     * Morning peak, weighted by the real road hierarchy rather than by length:
     * a commute runs from an expressway-adjacent street, along the expressway,
     * and exits at an expressway junction into the core. Pair weights are
     * relative (the tournament compares them), so this redistributes WHERE the
     * same volume goes - a highway pair scores 9 against a random local pair's
     * 1, while local pairs keep their base weight and still carry traffic.
     */
    weight: (origin, destination, context) => {
      let weight = 1;
      if (context.core.has(destination)) weight += 6;
      if (context.highways.has(origin)) weight += 5;
      if (context.highways.has(destination)) weight += 3;
      if (context.arterialRoads.has(origin)) weight += 2;
      if (context.arterial.has(origin)) weight += 1;
      return weight;
    },
  },
  /** Evening exodus: downtown → anywhere. */
  outbound: {
    name: "outbound",
    weight: (origin, destination, context) => {
      let weight = 1;
      if (context.core.has(origin)) weight += 6;
      if (context.arterial.has(destination)) weight += 1;
      return weight;
    },
  },
  /** Long fast roads carry most of the load, both ends. */
  "corridor-heavy": {
    name: "corridor-heavy",
    weight: (origin, destination, context) => {
      const onArterial = (id: IntersectionId): boolean => context.arterial.has(id);
      const both = onArterial(origin) && onArterial(destination);
      if (both) return 8;
      if (onArterial(origin) || onArterial(destination)) return 2;
      return 1;
    },
  },
  /** Traffic that has to cross the river: both ends near a bridge landing. */
  "bridge-pressure": {
    name: "bridge-pressure",
    weight: (origin, destination, context) => {
      if (context.bridges.size === 0) return 1;
      let weight = 1;
      if (context.bridges.has(origin)) weight += 3;
      if (context.bridges.has(destination)) weight += 3;
      return weight;
    },
  },
  /** A venue empties into the network: concentrated origins, wide destinations. */
  "event-surge": {
    name: "event-surge",
    weight: (origin, destination, context) => {
      let weight = 1;
      if (origin === context.venue) weight += 10;
      if (context.core.has(destination)) weight += 1;
      return weight;
    },
  },
};

export function demandShape(name: DemandShapeName): DemandShape {
  const shape = SHAPES[name];
  if (shape === undefined) {
    throw new RangeError(`unknown demand shape "${String(name)}"`);
  }
  return shape;
}

/** Bridge-endpoint count, for reports and tests: 0 means the shape is a no-op. */
export function bridgeEndpointCount(city: City): number {
  const ends = new Set<IntersectionId>();
  for (const road of city.roads) {
    if (road.kind === "bridge") {
      ends.add(road.from);
      ends.add(road.to);
    }
  }
  return ends.size;
}

export type { RoadId };
