/**
 * Global simulation constants.
 *
 * Only values already fixed by the PRD and required by implemented behavior
 * live here. Tunables arrive with the tasks that use them — no speculative
 * configuration surface.
 */
import type { CitySize, RoadKind, VehicleType } from "./types";

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
