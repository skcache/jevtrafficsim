/**
 * Global simulation constants.
 *
 * Only values already fixed by the PRD and required by implemented behavior
 * live here. Tunables arrive with the tasks that use them — no speculative
 * configuration surface.
 */
import type { CitySize, RoadKind, TrafficLevel, VehicleType } from "./types";

/** Fixed world-update timestep in milliseconds (PRD §10: 10 Hz). */
export const SIMULATION_TIMESTEP_MS = 100;

/** Logical update rate derived from the timestep (PRD §10: 10 Hz). */
export const SIMULATION_TICKS_PER_SECOND = 1000 / SIMULATION_TIMESTEP_MS;

/** Structural generation parameters per city size (PRD §5 scale table, §7.2 pipeline). */
export interface CitySizeSpec {
  /** Intersection-count range the generator must land in (PRD §5). */
  minIntersections: number;
  maxIntersections: number;
  /** Full-length north-south arterial lines to promote. */
  arterialCols: number;
  /**
   * Full-length east-west arterial lines to promote. River cities use their
   * bridge rows as the east-west arterials, so this is 0 for them.
   */
  arterialRows: number;
  /** Highway line: PRD §7.2 — Medium and above. */
  hasHighway: boolean;
  /** River/barrier with bridge bottlenecks: PRD §7.2 — Medium-Large and above. */
  hasRiver: boolean;
  /**
   * Bridge crossings over the river. Kept at >= 2 so a single closure can
   * never strand one half of the city (PRD §7.2 connectivity requirement).
   */
  bridgeCount: number;
  /** Diagonal cross-city corridors: PRD §7.2 — Medium and above. */
  diagonalCount: number;
  /** Region grid for hierarchical control metadata (PRD §12.4). */
  regionCols: number;
  regionRows: number;
}

export const CITY_SIZE_SPECS: Record<CitySize, CitySizeSpec> = {
  small: {
    minIntersections: 10,
    maxIntersections: 14,
    arterialCols: 1,
    arterialRows: 1,
    hasHighway: false,
    hasRiver: false,
    bridgeCount: 0,
    diagonalCount: 0,
    regionCols: 2,
    regionRows: 1,
  },
  "small-medium": {
    minIntersections: 22,
    maxIntersections: 32,
    arterialCols: 2,
    arterialRows: 1,
    hasHighway: false,
    hasRiver: false,
    bridgeCount: 0,
    diagonalCount: 0,
    regionCols: 2,
    regionRows: 1,
  },
  medium: {
    minIntersections: 50,
    maxIntersections: 70,
    arterialCols: 1,
    arterialRows: 2,
    hasHighway: true,
    hasRiver: false,
    bridgeCount: 0,
    diagonalCount: 1,
    regionCols: 2,
    regionRows: 2,
  },
  "medium-large": {
    minIntersections: 100,
    maxIntersections: 140,
    arterialCols: 2,
    arterialRows: 0,
    hasHighway: true,
    hasRiver: true,
    bridgeCount: 2,
    diagonalCount: 2,
    regionCols: 2,
    regionRows: 3,
  },
  large: {
    minIntersections: 200,
    maxIntersections: 300,
    arterialCols: 2,
    arterialRows: 0,
    hasHighway: true,
    hasRiver: true,
    bridgeCount: 3,
    diagonalCount: 3,
    regionCols: 3,
    regionRows: 2,
  },
};

/** Per-kind road property defaults: simple, deterministic, tunable later. */
export interface RoadKindDefaults {
  lanes: number;
  speedLimit: number;
  capacity: number;
}

export const ROAD_KIND_DEFAULTS: Record<RoadKind, RoadKindDefaults> = {
  local: { lanes: 1, speedLimit: 8, capacity: 8 },
  arterial: { lanes: 2, speedLimit: 14, capacity: 16 },
  highway: { lanes: 3, speedLimit: 25, capacity: 30 },
  bridge: { lanes: 2, speedLimit: 11, capacity: 12 },
};

/** Occupancy ratios saturate here when costing roads (PRD §11.3). */
export const MAX_OCCUPANCY_RATIO = 1;

/**
 * Floor for a road's traffic speed factor. Also the router's clamp, so a road
 * can never be priced as slower than it can physically become.
 */
export const MIN_TRAFFIC_SPEED_FACTOR = 0.12;

/** Default congestion multiplier for route costing (PRD §9 bounded penalty). */
export const DEFAULT_CONGESTION_WEIGHT = 1;

/** Hard ceiling for congestion weights so edge costs stay bounded. */
export const MAX_CONGESTION_WEIGHT = 10;

/** Vehicle-class parameters (PRD §6.4): footprint in capacity units, speed multiplier. */
export interface VehicleTypeSpec {
  footprint: number;
  speedMultiplier: number;
}

export const VEHICLE_TYPE_SPECS: Record<VehicleType, VehicleTypeSpec> = {
  car: { footprint: 1, speedMultiplier: 1 },
  truck: { footprint: 2, speedMultiplier: 0.7 },
  bicycle: { footprint: 0.3, speedMultiplier: 0.8 },
};

/** Shared tolerance for floating-point comparisons in the traffic layer. */
export const SIMULATION_EPSILON = 1e-9;

/** Signal timing configuration for one intersection (Task 06 legal mechanics). */
export interface SignalTiming {
  minGreenMs: number;
  maxGreenMs: number;
  yellowMs: number;
  allRedMs: number;
}

/** Default legal signal timings — simplified for gameplay (PRD §11.1). */
export const DEFAULT_SIGNAL_TIMING: SignalTiming = {
  minGreenMs: 5000,
  maxGreenMs: 30000,
  yellowMs: 3000,
  allRedMs: 1000,
};

/** Minimum time a vehicle must remain stopped at a stop sign (PRD §11.2). */
export const STOP_SIGN_MIN_STOP_MS = 1500;

/**
 * Spillback admission ratio (PRD §11.3). Admission is decided on PROJECTED
 * occupancy (`current + footprint`): once a road's occupancy has reached this
 * fraction of its capacity it stops admitting NEW vehicles, and no admitted
 * vehicle may push it past the threshold — upstream flow is restricted before
 * the road is absolutely full, keeping the final stretch of every road clear
 * for the vehicles already on it. Absolute capacity remains documented as the
 * hard ceiling, but with a ratio below 1 the spillback limit binds first.
 */
export const SPILLBACK_ADMISSION_RATIO = 0.9;

/** Target active-vehicle range per city size and traffic level (PRD §5). */
export interface ActiveVehicleTargets {
  readonly min: number;
  readonly max: number;
}

export const TRAFFIC_LEVEL_TARGETS: Record<
  CitySize,
  Record<TrafficLevel, ActiveVehicleTargets>
> = {
  small: {
    light: { min: 20, max: 40 },
    everyday: { min: 40, max: 70 },
    "rush-hour": { min: 70, max: 110 },
  },
  "small-medium": {
    light: { min: 50, max: 90 },
    everyday: { min: 90, max: 150 },
    "rush-hour": { min: 150, max: 230 },
  },
  medium: {
    light: { min: 120, max: 180 },
    everyday: { min: 200, max: 320 },
    "rush-hour": { min: 320, max: 500 },
  },
  "medium-large": {
    light: { min: 250, max: 400 },
    everyday: { min: 450, max: 650 },
    "rush-hour": { min: 650, max: 950 },
  },
  large: {
    light: { min: 500, max: 800 },
    everyday: { min: 850, max: 1200 },
    "rush-hour": { min: 1200, max: 2000 },
  },
};

/**
 * Vehicle class mix per traffic level (game-tuned). Commercial traffic (trucks)
 * is relatively inelastic, so its share rises slightly with demand while
 * discretionary car traffic dominates at every level.
 */
export interface VehicleTypeMix {
  readonly car: number;
  readonly truck: number;
  readonly bicycle: number;
}

export const TRAFFIC_LEVEL_TYPE_MIX: Record<TrafficLevel, VehicleTypeMix> = {
  light: { car: 0.85, truck: 0.1, bicycle: 0.05 },
  everyday: { car: 0.82, truck: 0.12, bicycle: 0.06 },
  "rush-hour": { car: 0.8, truck: 0.14, bicycle: 0.06 },
};
