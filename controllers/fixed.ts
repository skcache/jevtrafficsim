/**
 * Fixed controller — the naive but legal baseline (PRD §12.1).
 *
 * Policy: fixed green durations by intersection class. No queue awareness and
 * no network awareness — the directive for a signal depends only on how long
 * its current group has been green. Yellow and all-red transitions are owned
 * by the signal mechanics and are always fully respected; min green defers an
 * early advance, and max green still force-switches if the class duration
 * were ever configured beyond it.
 *
 * The fixed green durations assume the default timing bounds
 * (DEFAULT_SIGNAL_TIMING: min 5s / max 30s). Under tighter custom timings the
 * mechanics simply force the switch sooner — legality never depends on policy.
 */
import type { TrafficController } from "./contract";
import type { SignalDirective } from "@/sim/signals";
import type { TrafficState } from "@/sim/traffic";
import type { City, IntersectionId, RoadKind } from "@/sim/types";

export type IntersectionClass = "highway" | "arterial" | "local";

/** Fixed green durations by intersection class, in milliseconds. */
export const FIXED_GREEN_MS: Record<IntersectionClass, number> = {
  highway: 24_000,
  arterial: 18_000,
  local: 12_000,
};

/** Intersection class = the most significant road kind touching the node. */
export function intersectionClass(
  city: City,
  intersectionId: IntersectionId,
): IntersectionClass {
  const intersection = city.intersections[intersectionId];
  if (!intersection) {
    throw new RangeError(`unknown intersection id ${intersectionId}`);
  }
  const kinds = new Set<RoadKind>();
  for (const roadId of intersection.incoming) {
    kinds.add(city.roads[roadId].kind);
  }
  for (const roadId of intersection.outgoing) {
    kinds.add(city.roads[roadId].kind);
  }
  if (kinds.has("highway")) {
    return "highway";
  }
  if (kinds.has("arterial") || kinds.has("bridge")) {
    return "arterial";
  }
  return "local";
}

export function createFixedController(): TrafficController {
  return {
    id: "fixed",
    directives(
      city: City,
      traffic: TrafficState,
    ): ReadonlyMap<IntersectionId, SignalDirective> {
      const directives = new Map<IntersectionId, SignalDirective>();
      for (const [intersectionId, signal] of traffic.signals) {
        if (signal.groups.length < 2) {
          continue; // single-axis: there is no competing movement to serve
        }
        if (signal.stage !== "green") {
          continue; // clearance stages are mechanics-owned
        }
        const greenMs = FIXED_GREEN_MS[intersectionClass(city, intersectionId)];
        if (signal.stageElapsedMs >= greenMs) {
          directives.set(intersectionId, "advance");
        }
      }
      return directives;
    },
  };
}
