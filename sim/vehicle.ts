/**
 * Vehicle-class parameters and single-vehicle helpers (PRD §6.4, §8).
 *
 * A vehicle's footprint is its capacity consumption in normalized units
 * (car = 1, truck = 2, bicycle = 0.3), and its effective speed is the
 * current road's speed limit scaled by the class multiplier. No
 * acceleration, braking, or lane behaviour is modelled in V1.
 */
import { VEHICLE_TYPE_SPECS } from "./config";
import type { City, IntersectionId, Road, RoadId, VehicleType } from "./types";

/** Capacity units consumed by one vehicle of this class. */
export function vehicleFootprint(type: VehicleType): number {
  return VEHICLE_TYPE_SPECS[type].footprint;
}

/** Speed multiplier relative to the road's speed limit. */
export function vehicleSpeedMultiplier(type: VehicleType): number {
  return VEHICLE_TYPE_SPECS[type].speedMultiplier;
}

/** Effective free-flow speed of this class on the given road. */
export function effectiveSpeed(road: Road, type: VehicleType): number {
  return road.speedLimit * vehicleSpeedMultiplier(type);
}

/**
 * Validates a spawn route once at creation time (never per tick): all road
 * ids exist, the directed roads form a continuous path from origin to
 * destination, and an empty route is allowed only when origin equals
 * destination (an already-arrived vehicle).
 */
export function validateVehicleRoute(
  city: City,
  route: readonly RoadId[],
  origin: IntersectionId,
  destination: IntersectionId,
): void {
  if (
    !Number.isInteger(origin) ||
    origin < 0 ||
    origin >= city.intersections.length
  ) {
    throw new RangeError(`invalid origin intersection ${origin}`);
  }
  if (
    !Number.isInteger(destination) ||
    destination < 0 ||
    destination >= city.intersections.length
  ) {
    throw new RangeError(`invalid destination intersection ${destination}`);
  }
  if (route.length === 0) {
    if (origin !== destination) {
      throw new RangeError("an empty route requires origin === destination");
    }
    return;
  }
  let expectedFrom = origin;
  for (let index = 0; index < route.length; index += 1) {
    const road = city.roads[route[index]];
    if (!road) {
      throw new RangeError(`route contains unknown road id ${route[index]}`);
    }
    if (road.from !== expectedFrom) {
      throw new RangeError(
        `route is not continuous at index ${index}: road ${road.id} starts at ${road.from}, expected ${expectedFrom}`,
      );
    }
    expectedFrom = road.to;
  }
  if (expectedFrom !== destination) {
    throw new RangeError(
      `route ends at ${expectedFrom}, expected destination ${destination}`,
    );
  }
}
