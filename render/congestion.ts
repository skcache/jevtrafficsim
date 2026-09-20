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
}

/** Queued-count and wait thresholds per level, worst first. */
const LEVELS: readonly { level: CongestionLevel; minQueued: number; minWaitMs: number }[] = [
  { level: "severe", minQueued: 4, minWaitMs: 25_000 },
  { level: "bad", minQueued: 2, minWaitMs: 12_000 },
  { level: "warm", minQueued: 1, minWaitMs: 5_000 },
];

/** Restrained overlay colours: amber -> orange -> red, never neon. */
export const CONGESTION_COLORS: Record<CongestionLevel, readonly [number, number, number, number]> = {
  warm: [217, 168, 92, 120],
  bad: [214, 124, 58, 150],
  severe: [178, 58, 44, 170],
};

function levelFor(queued: number, maxBlockedWaitMs: number): CongestionLevel | null {
  for (const rule of LEVELS) {
    if (queued >= rule.minQueued || maxBlockedWaitMs >= rule.minWaitMs) {
      return rule.level;
    }
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
  const stats = new Map<number, { active: number; queued: number; maxWait: number }>();
  for (const road of snapshot.roadTraffic) {
    stats.set(road.roadId, {
      active: road.vehicleCount,
      queued: road.queuedCount,
      maxWait: road.maxBlockedWaitMs,
    });
  }

  const pressure: RoadPressure[] = [];
  for (const [roadId, entry] of [...stats.entries()].sort((a, b) => a[0] - b[0])) {
    const level = levelFor(entry.queued, entry.maxWait);
    if (level === null) {
      continue;
    }
    pressure.push({
      roadId,
      level,
      active: entry.active,
      queued: entry.queued,
      maxBlockedWaitMs: entry.maxWait,
    });
  }
  return pressure;
}
