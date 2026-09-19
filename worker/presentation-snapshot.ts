/**
 * Bounded presentation snapshots (Task 11): the live-render frame sent to the
 * main thread. NEVER `takeSnapshot(engine)` — that intentionally carries every
 * vehicle for the whole run and grows forever. This frame contains only what
 * the renderer and HUD need RIGHT NOW:
 *
 * - active vehicles only (no arrived, no routes, no destinations);
 * - current blocked wait per vehicle (continuous queue wait for queued,
 *   pending wait for pending, zero while moving) for the wait-heat pass;
 * - compact signal state, road conditions and active/recent incident markers;
 * - no city geometry (sent once in READY), no partitions, no maps.
 *
 * Deterministic for identical engine state: vehicles in engine order,
 * everything else sorted by id.
 */
import { currentQueueWaitMs } from "@/sim/approach-stats";
import type { EngineState } from "@/sim/engine";
import { computeMetrics, type SimulationMetrics } from "@/sim/metrics";
import type { SignalStage } from "@/sim/signals";
import type {
  IncidentKind,
  IncidentRecord,
} from "@/sim/incidents";
import type { IntersectionId, RoadId, VehicleId, VehicleState, VehicleType } from "@/sim/types";

export interface PresentationVehicle {
  readonly id: VehicleId;
  readonly type: VehicleType;
  readonly state: VehicleState;
  readonly roadId: RoadId | null;
  readonly progress: number;
  /**
   * Position in this road's queue, 0 = front (nearest the stop line), or null
   * when the vehicle is not queued. Computed here with the SAME ordering rule
   * the simulation uses — queuedSinceMs ascending, then id — so presentation can
   * never disagree with the simulation about who is in front.
   */
  readonly queueRank: number | null;
  /** Continuous blocked wait (ms); 0 while moving. */
  readonly blockedWaitMs: number;
}

export interface PresentationSignal {
  readonly intersectionId: IntersectionId;
  readonly phaseIndex: number;
  readonly stage: SignalStage;
}

export interface PresentationRoadCondition {
  readonly roadId: RoadId;
  readonly closed: boolean;
  readonly capacity: number;
}

export interface PresentationIncidentMarker {
  readonly id: number;
  readonly kind: IncidentKind;
  readonly status: IncidentRecord["status"];
  readonly roadIds: readonly RoadId[];
  readonly eventCenterIntersectionId: IntersectionId | null;
  readonly expiresAtMs: number | null;
}

export interface PresentationSnapshot {
  /** Monotonic frame counter from the worker. */
  readonly sequence: number;
  readonly timeMs: number;
  readonly controller: string;
  readonly vehicles: readonly PresentationVehicle[];
  readonly signals: readonly PresentationSignal[];
  readonly roadConditions: readonly PresentationRoadCondition[];
  readonly incidents: readonly PresentationIncidentMarker[];
}

export type PresentationMetrics = SimulationMetrics & {
  readonly activeVehicles: number;
};

/**
 * Queue rank per vehicle: 0 is the front of its directed road's queue.
 *
 * The rule is copied from `sim/traffic.ts` deliberately — queuedSinceMs
 * ascending, then id — because presentation must never disagree with the
 * simulation about who is in front. Exported so the exact semantics are
 * testable without standing up an engine.
 */
export function assignQueueRanks(
  vehicles: readonly {
    readonly id: VehicleId;
    readonly state: string;
    readonly roadId: RoadId | null;
    readonly queuedSinceMs: number | null;
  }[],
): Map<VehicleId, number> {
  const ranks = new Map<VehicleId, number>();
  const queues = new Map<RoadId, { id: VehicleId; since: number }[]>();
  for (const vehicle of vehicles) {
    if (vehicle.state !== "queued" || vehicle.roadId === null) {
      continue;
    }
    const list = queues.get(vehicle.roadId) ?? [];
    list.push({ id: vehicle.id, since: vehicle.queuedSinceMs ?? 0 });
    queues.set(vehicle.roadId, list);
  }
  for (const queue of queues.values()) {
    queue.sort((a, b) => a.since - b.since || a.id - b.id);
    queue.forEach((entry, rank) => ranks.set(entry.id, rank));
  }
  return ranks;
}

export function buildPresentationSnapshot(
  engine: EngineState,
  sequence: number,
): PresentationSnapshot {
  // Queue ranks first, in one pass: per directed road, ordered exactly as
  // sim/traffic.ts orders its own queue (queuedSinceMs ascending, then id). The
  // renderer reads this instead of trying to reconstruct the order from
  // progress, which is what let presentation disagree with the simulation.
  const queueRanks = assignQueueRanks(engine.traffic.vehicles);

  const vehicles: PresentationVehicle[] = [];
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state === "arrived") {
      continue; // bounded: completed trips never enter the live frame
    }
    vehicles.push({
      id: vehicle.id,
      type: vehicle.type,
      state: vehicle.state,
      roadId: vehicle.roadId,
      progress: vehicle.progress,
      queueRank: queueRanks.get(vehicle.id) ?? null,
      blockedWaitMs:
        vehicle.state === "queued"
          ? currentQueueWaitMs(engine.traffic.timeMs, vehicle.queuedSinceMs)
          : vehicle.state === "pending"
            ? vehicle.waitTimeMs
            : 0,
    });
  }

  const signals: PresentationSignal[] = [...engine.traffic.signals.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([intersectionId, signal]) => ({
      intersectionId,
      phaseIndex: signal.phaseIndex,
      stage: signal.stage,
    }));

  const roadConditions: PresentationRoadCondition[] = [];
  for (const road of engine.city.roads) {
    const base = engine.baseCity.roads[road.id];
    if (road.closed !== base.closed || road.capacity !== base.capacity) {
      roadConditions.push({ roadId: road.id, closed: road.closed, capacity: road.capacity });
    }
  }
  roadConditions.sort((a, b) => a.roadId - b.roadId);

  const incidents: PresentationIncidentMarker[] = [...engine.incidents.records]
    .sort((a, b) => a.id - b.id)
    .map((record) => ({
      id: record.id,
      kind: record.kind,
      status: record.status,
      roadIds: [...record.roadIds],
      eventCenterIntersectionId: record.eventCenterIntersectionId,
      expiresAtMs: record.expiresAtMs,
    }));

  return {
    sequence,
    timeMs: engine.traffic.timeMs,
    controller: engine.controller.id,
    vehicles,
    signals,
    roadConditions,
    incidents,
  };
}

export function buildPresentationMetrics(engine: EngineState): PresentationMetrics {
  let activeVehicles = 0;
  for (const vehicle of engine.traffic.vehicles) {
    if (vehicle.state !== "arrived") {
      activeVehicles += 1;
    }
  }
  return {
    ...computeMetrics(engine.metrics, engine.traffic),
    activeVehicles,
  };
}
