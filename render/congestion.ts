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
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";

export type CongestionLevel = "flowing" | "warm" | "bad" | "severe";

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
 * Whole-city traffic layer thresholds. Occupancy matters as much as a queue:
 * otherwise moving but dense traffic disappears and the map falsely looks
 * empty until cars physically stop.
 */
const LEVELS: readonly {
  level: CongestionLevel;
  minQueued: number;
  minWaitMs: number;
  minOccupancyRatio: number;
}[] = [
  { level: "severe", minQueued: 4, minWaitMs: 25_000, minOccupancyRatio: 0.92 },
  { level: "bad", minQueued: 2, minWaitMs: 12_000, minOccupancyRatio: 0.72 },
  { level: "warm", minQueued: 1, minWaitMs: 5_000, minOccupancyRatio: 0.46 },
];

/**
 * City traffic-mode colours. Flowing roads get a quiet green proof-of-life;
 * pressure graduates through amber/orange/red. The ego route is filtered out
 * by CityMap and keeps its own blue/amber/red language.
 */
export const CONGESTION_COLORS: Record<
  CongestionLevel,
  readonly [number, number, number, number]
> = {
  flowing: [79, 143, 104, 72],
  warm: [217, 168, 92, 120],
  bad: [214, 124, 58, 150],
  severe: [178, 58, 44, 170],
};

function levelFor(
  active: number,
  queued: number,
  maxBlockedWaitMs: number,
  occupancyRatio: number,
): CongestionLevel | null {
  for (const rule of LEVELS) {
    if (
      queued >= rule.minQueued ||
      maxBlockedWaitMs >= rule.minWaitMs ||
      occupancyRatio >= rule.minOccupancyRatio
    ) {
      return rule.level;
    }
  }
  // A road carrying moving background vehicles is still part of the traffic
  // system. Draw it quietly instead of making the city look empty until a jam.
  return active > 0 ? "flowing" : null;
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
    { active: number; queued: number; maxWait: number; occupancyRatio: number }
  >();
  for (const road of snapshot.roadTraffic) {
    stats.set(road.roadId, {
      active: road.vehicleCount,
      queued: road.queuedCount,
      maxWait: road.maxBlockedWaitMs,
      occupancyRatio: road.capacity > 0 ? road.occupancy / road.capacity : 0,
    });
  }

  const pressure: RoadPressure[] = [];
  for (const [roadId, entry] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
    const level = levelFor(entry.active, entry.queued, entry.maxWait, entry.occupancyRatio);
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
