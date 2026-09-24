/**
 * Road-level congestion, for the zooms where individual vehicles stop telling
 * the story.
 *
 * At city zoom a driver cannot see queues, so pressure has to be aggregated per
 * road: this walks the current snapshot once (O(V + affected roads)), classifies
 * each road into neutral / warm / bad / severe, and returns only the roads that
 * are actually hurting. Most streets stay untouched — a map that recolours
 * everything communicates nothing.
 *
 * The classification is a pure function of the snapshot so it is deterministic
 * and testable; the caller turns it into a deck.gl layer.
 */
import type {
  PresentationRoadTraffic,
  PresentationSnapshot,
} from "@/worker/presentation-snapshot";

export type CongestionLevel = "warm" | "bad" | "severe";

export interface RoadPressure {
  readonly roadId: number;
  readonly level: CongestionLevel;
  /** Vehicles currently on the road. */
  readonly active: number;
  /** Vehicles blocked at its end. */
  readonly queued: number;
  /** Longest blocked wait on the road (ms). */
  readonly maxBlockedWaitMs: number;
  /** Current occupancy divided by effective capacity. */
  readonly occupancyRatio: number;
}


/**
 * City traffic-mode colours: amber means traffic, red means heavy/blocked.
 * There is deliberately NO colour for a free-flowing road — a neutral road
 * stays neutral, so "nothing painted" is the free baseline.
 */
export const CONGESTION_COLORS: Record<
  CongestionLevel,
  readonly [number, number, number, number]
> = {
  warm: [222, 164, 72, 140],
  bad: [214, 108, 46, 168],
  severe: [178, 52, 40, 190],
};

/**
 * Level for a road, from the SIMULATION'S flow state. This used to be a second
 * threshold table over occupancy/queue/wait; it now reads the same severity the
 * physics uses, so the overlay cannot paint a road amber that cars cross at
 * free-flow speed. Free roads stay NEUTRAL (never painted).
 */
/**
 * THE congestion rule, in one place, so the city overlay and the route band can
 * never disagree.
 *
 * Severity alone is too coarse to be the only input: the simulation reports
 * "free" for a road at 75% occupancy (it is still flowing, by its reckoning), so
 * a busy road - including the one the user is watching - showed no pressure at
 * all. Occupancy ratio, queue length and blocked wait are all in the frame
 * already; they were simply not being read.
 */
export function congestionLevelFor(entry: {
  severity: PresentationRoadTraffic["severity"];
  occupancyRatio: number;
  queuedCount: number;
  maxBlockedWaitMs: number;
}): CongestionLevel | null {
  // The simulation's own severity keeps its tiers: severe reads severe, slower
  // reads warm. What changed is what happens BELOW that: a road the sim calls
  // free can still be 75% full, and painting nothing there is why the route -
  // and every busy street - looked empty through rush hour.
  if (entry.severity === "severe") {
    return "severe";
  }
  if (entry.severity === "slower") {
    return "warm";
  }
  if (entry.occupancyRatio >= 0.85) {
    return "bad";
  }
  if (entry.occupancyRatio >= 0.6 || entry.queuedCount >= 2) {
    return "warm";
  }
  return null;
}

/**
 * Aggregate current pressure per directed road. Deterministic: roads are
 * returned sorted by id, and ties in the level are irrelevant because each road
 * appears once.
 */
export function roadPressure(snapshot: PresentationSnapshot | null): RoadPressure[] {
  if (!snapshot) {
    return [];
  }
  // Reads the SPARSE per-road aggregates: congestion is a property of roads,
  // and the frame no longer carries background vehicle objects at all.
  const stats = new Map<
    number,
    {
      active: number;
      queued: number;
      maxWait: number;
      occupancyRatio: number;
      severity: PresentationRoadTraffic["severity"];
    }
  >();
  for (const road of snapshot.roadTraffic) {
    stats.set(road.roadId, {
      active: road.vehicleCount,
      queued: road.queuedCount,
      maxWait: road.maxBlockedWaitMs,
      occupancyRatio: road.capacity > 0 ? road.occupancy / road.capacity : 0,
      severity: road.severity,
    });
  }

  const pressure: RoadPressure[] = [];
  for (const [roadId, entry] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
    const level = congestionLevelFor({
      severity: entry.severity,
      occupancyRatio: entry.occupancyRatio,
      queuedCount: entry.queued,
      maxBlockedWaitMs: entry.maxWait,
    });
    if (level === null) {
      continue;
    }
    pressure.push({
      roadId,
      level,
      active: entry.active,
      queued: entry.queued,
      maxBlockedWaitMs: entry.maxWait,
      occupancyRatio: entry.occupancyRatio,
    });
  }
  return pressure;
}
