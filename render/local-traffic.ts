/**
 * Local traffic context (issue #56).
 *
 * Rush Hour must visibly read as busy around the ego without becoming the old
 * citywide confetti. This derives a RESTRAINED set of background sprites from the
 * simulation's OWN per-road aggregates (`vehicleCount` per road, already in every
 * frame) - nothing is invented, nothing is rerouted, and no simulation count is
 * changed. A road with 3 vehicles shows 1 sprite; a road with 40 shows a handful.
 *
 * Every property the brief demands, by construction:
 *  - LOCAL: only roads whose midpoint is within `radiusM` of the ego.
 *  - RESTRAINED: `maxPerRoad` per road, `maxTotal` in the frame, and roads are
 *    taken nearest-first so the budget goes where the camera is looking.
 *  - DETERMINISTIC: a vehicle's position is a pure function of (roadId, slot) and
 *    the road's own length - no time, no RNG, so nothing flickers or teleports
 *    between frames and two runs of the same scenario draw the same traffic.
 *  - ROAD-LOCKED: every position is sampled from the road's path with the same
 *    lane-offset helper the ego uses, so cars cannot appear on water or parks.
 *  - SPACED: slots are quantised evenly along the road, so sprites cannot stack.
 *  - SECONDARY: same sprite classes as before, drawn by the fleet layers, which
 *    sit under the ego's own layer and use the smaller fleet pixel sizing.
 */
import type { MapModel } from "@/cities/map-model";
import type { DirectedPathIndexes } from "@/render/map-geometry";
import { applyLaneOffset } from "@/render/map-geometry";
import { samplePathIndex } from "@/cities/paths";
import { vehicleLaneOffsetMetres } from "@/render/road-presentation";
import type { RenderedVehicle } from "@/render/interpolate";
import type { PresentationRoadTraffic } from "@/worker/presentation-snapshot";
import type { RoadId, VehicleType } from "@/sim/types";

export const LOCAL_TRAFFIC = {
  /** Only roads near the camera's subject: the follow view is ~400 m across. */
  radiusM: 520,
  /** Vehicles the simulation must report on a road before it shows anything. */
  minVehiclesPerRoad: 2,
  /** One sprite per this many simulated vehicles, so density tracks demand. */
  vehiclesPerSprite: 3,
  maxPerRoad: 3,
  /** Hard ceiling on background sprites. Never "thousands". */
  maxTotal: 60,
  /** No background car within this distance of the ego on the ego's own road. */
  egoClearanceM: 26,
} as const;

/** Deterministic 0..1 hash of (roadId, slot). */
function slotNoise(roadId: number, slot: number): number {
  let hash = (roadId * 73856093) ^ ((slot + 1) * 19349663);
  hash = (hash ^ (hash >>> 13)) * 1274126177;
  return ((hash ^ (hash >>> 16)) >>> 0) / 4294967296;
}

export interface LocalTrafficInput {
  readonly model: MapModel;
  readonly indexes: DirectedPathIndexes;
  readonly laneOffsets: readonly number[];
  readonly roadTraffic: readonly PresentationRoadTraffic[];
  /** The rendered ego, so spacing and the local radius are measured from it. */
  readonly ego: { readonly x: number; readonly y: number; readonly roadId: RoadId | null } | null;
}

export function deriveLocalTraffic(input: LocalTrafficInput): RenderedVehicle[] {
  const { model, indexes, laneOffsets, roadTraffic, ego } = input;
  if (!ego) {
    return [];
  }
  const city = model.city;

  interface Candidate {
    readonly entry: PresentationRoadTraffic;
    readonly distanceM: number;
  }
  const candidates: Candidate[] = [];
  for (const entry of roadTraffic) {
    if (entry.vehicleCount < LOCAL_TRAFFIC.minVehiclesPerRoad) {
      continue;
    }
    const road = city.roads[entry.roadId];
    const index = indexes[entry.roadId];
    if (!road || !index || index.total < 1) {
      continue;
    }
    const midpoint = samplePathIndex(index, index.total / 2);
    const distanceM = Math.hypot(midpoint.x - ego.x, midpoint.y - ego.y);
    if (distanceM > LOCAL_TRAFFIC.radiusM) {
      continue;
    }
    candidates.push({ entry, distanceM });
  }
  // Nearest first, road id as the tie-break: deterministic ordering, so the
  // ceil doesn't swap which roads survive between frames.
  candidates.sort((a, b) => a.distanceM - b.distanceM || a.entry.roadId - b.entry.roadId);

  const out: RenderedVehicle[] = [];
  for (const candidate of candidates) {
    if (out.length >= LOCAL_TRAFFIC.maxTotal) {
      break;
    }
    const roadId = candidate.entry.roadId;
    const road = city.roads[roadId];
    const index = indexes[roadId];
    if (!road || !index) {
      continue;
    }
    const wanted = Math.min(
      LOCAL_TRAFFIC.maxPerRoad,
      Math.floor(candidate.entry.vehicleCount / LOCAL_TRAFFIC.vehiclesPerSprite),
    );
    if (wanted <= 0) {
      continue;
    }
    const laneOffset = vehicleLaneOffsetMetres(city, laneOffsets, -roadId - 1, roadId);
    for (let slot = 0; slot < wanted; slot += 1) {
      if (out.length >= LOCAL_TRAFFIC.maxTotal) {
        break;
      }
      // Evenly spaced, jittered deterministically: no stacking, no flicker.
      const base = (slot + 0.7) / (wanted + 0.4);
      const jitter = (slotNoise(roadId, slot) - 0.5) * 0.6 / (wanted + 1);
      const progress = Math.min(1, Math.max(0, base + jitter)) * road.length;
      // Keep the hero's own stretch clear.
      if (ego.roadId === roadId) {
        const sample = samplePathIndex(index, progress);
        if (Math.hypot(sample.x - ego.x, sample.y - ego.y) < LOCAL_TRAFFIC.egoClearanceM) {
          continue;
        }
      }
      const placed = applyLaneOffset(samplePathIndex(index, progress), laneOffset);
      const roll = slotNoise(roadId, slot + 977);
      const type: VehicleType = roll > 0.82 ? "truck" : roll < 0.06 ? "bicycle" : "car";
      out.push({
        id: -1 - (roadId * 7 + slot),
        roadId,
        type,
        state: "moving",
        x: placed.x,
        y: placed.y,
        headingRadians: placed.heading,
        blockedWaitMs: 0,
        fade: 1,
        queueRank: -1,
      });
    }
  }
  return out;
}
