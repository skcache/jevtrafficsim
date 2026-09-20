/**
 * The curated challenge trip, turned into an actual simulated vehicle.
 *
 * Issue #23 defined the trips; Issue #24 makes the selected one the run's
 * protagonist. This module is the single seam between the two: it resolves the
 * trip's anchors to graph intersections through the #23 contract and produces
 * the ONE ego spawn the engine will accept.
 *
 * The ego spawn is an ordinary car. It gets no priority, no capacity
 * exemption, no different route cost — only a `role` tag so the engine can
 * record its vehicle id and presentation can find it.
 */
import type { MapModel } from "@/cities/map-model";
import {
  materializeCuratedTrip,
  type CuratedTripId,
  type MaterializedCuratedTrip,
} from "@/cities/chicago-trips";
import type { ScheduledSpawn } from "@/sim/engine";

export interface ChallengeTrip {
  readonly trip: MaterializedCuratedTrip;
  readonly spawn: ScheduledSpawn;
}

/**
 * Materialize `tripId` against `model` and build its ego spawn at time zero.
 * Throws whatever the #23 materializer throws (unknown trip, unreachable).
 */
export function materializeChallengeTrip(
  model: MapModel,
  tripId: CuratedTripId,
  seed: number,
): ChallengeTrip {
  const trip = materializeCuratedTrip(model, { tripId, seed });
  return {
    trip,
    spawn: {
      timeMs: 0,
      type: "car",
      origin: trip.originIntersectionId,
      destination: trip.destinationIntersectionId,
      role: "ego",
    },
  };
}
