/**
 * Core world-model types shared by the simulation, controllers, worker,
 * renderer, and headless benchmark.
 *
 * Framework-independent by contract: nothing under `sim/` may import React,
 * Canvas, or any browser API (PRD §3, §7).
 *
 * Shapes mirror the PRD world model (§7.1) and vehicle model (§8) exactly.
 * Only contracts the current core requires live here; incident, metric, and
 * Jev policy types are introduced by the tasks that implement them (PRD §26:
 * no empty abstractions).
 */

export type IntersectionId = number;
export type RoadId = number;
export type VehicleId = number;

/** Road classification (PRD §7.1). */
export type RoadKind = "local" | "arterial" | "highway" | "bridge";

/** How an intersection is controlled (PRD §7.1, §11). */
export type IntersectionControl = "signal" | "stop" | "uncontrolled";

/** Vehicle classes with distinct footprint/speed behaviour (PRD §6.4). */
export type VehicleType = "car" | "truck" | "bicycle";

/** Vehicle lifecycle state (PRD §8; `pending` covers capacity-blocked spawns). */
export type VehicleState =
  | "pending"
  | "moving"
  | "queued"
  | "rerouting"
  | "arrived";

/** The three selectable controllers (PRD §4.1, §12). */
export type ControllerType = "fixed" | "adaptive" | "jev";

/** Selectable city sizes (PRD §4.1, §5). */
export type CitySize =
  | "small"
  | "small-medium"
  | "medium"
  | "medium-large"
  | "large";

/** Selectable traffic levels (PRD §4.1). */
export type TrafficLevel = "light" | "everyday" | "rush-hour";

/** Node = intersection (PRD §7.1). */
export interface Intersection {
  id: IntersectionId;
  x: number;
  y: number;
  incoming: RoadId[];
  outgoing: RoadId[];
  control: IntersectionControl;
  regionId: number;
}

/** Directed edge = traversable road segment (PRD §7.1). */
export interface Road {
  id: RoadId;
  from: IntersectionId;
  to: IntersectionId;
  length: number;
  lanes: number;
  speedLimit: number;
  capacity: number;
  kind: RoadKind;
  closed: boolean;
}

/** A vehicle moving along graph edges (PRD §8). */
export interface Vehicle {
  id: VehicleId;
  type: VehicleType;
  origin: IntersectionId;
  destination: IntersectionId;
  route: RoadId[];
  routeIndex: number;
  /** Current directed road; null while pending. Kept after arrival for diagnostics. */
  roadId: RoadId | null;
  /** Distance (world units) traveled along the current road. */
  progress: number;
  /** Effective free-flow speed for the current road and vehicle type. */
  speed: number;
  waitTimeMs: number;
  tripTimeMs: number;
  state: VehicleState;
  /** Simulation time at which the vehicle was created. */
  spawnTimeMs: number;
  /** Simulation time when the vehicle began waiting at a road end; null otherwise. */
  queuedSinceMs: number | null;
  /** Successful route changes for this vehicle (invalidity or driver switch). */
  rerouteCount: number;
}

/** Corridor classification for structural policy metadata (PRD §12.5). */
export type CorridorKind = "arterial" | "highway" | "diagonal";

/** A named continuous corridor: the unit controllers may later favor (PRD §12.5). */
export interface Corridor {
  id: number;
  kind: CorridorKind;
  roadIds: RoadId[];
}

/**
 * A generated city. `intersections` and `roads` are dense arrays where the
 * index equals the id. `corridors` are stable structural groups feeding
 * hierarchical control (PRD §7.2 step 10, §12.4).
 */
export interface City {
  size: CitySize;
  seed: number;
  gridWidth: number;
  gridHeight: number;
  intersections: Intersection[];
  roads: Road[];
  corridors: Corridor[];
}
