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
function levelFor(severity: PresentationRoadTraffic["severity"]): CongestionLevel | null {
  if (severity === "severe") {
    return "severe";
  }
  if (severity === "slower") {
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
    const level = levelFor(entry.severity);
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
