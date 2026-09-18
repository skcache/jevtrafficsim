import { describe, expect, it } from "vitest";
import type {
  CitySize,
  ControllerType,
  Intersection,
  Road,
  TrafficLevel,
  Vehicle,
} from "@/sim/types";

describe("core world-model types", () => {
  it("a minimal sample satisfies the PRD interfaces", () => {
    const intersection: Intersection = {
      id: 0,
      x: 100,
      y: 200,
      incoming: [],
      outgoing: [0],
      control: "signal",
      regionId: 0,
    };
    const road: Road = {
      id: 0,
      from: 0,
      to: 1,
      length: 120,
      lanes: 2,
      speedLimit: 13.9,
      capacity: 20,
      kind: "arterial",
      closed: false,
    };
    const vehicle: Vehicle = {
      id: 0,
      type: "car",
      origin: 0,
      destination: 1,
      route: [0],
      routeIndex: 0,
      roadId: 0,
      progress: 0,
      speed: 0,
      waitTimeMs: 0,
      tripTimeMs: 0,
      state: "queued",
    };

    expect(intersection.control).toBe("signal");
    expect(intersection.regionId).toBe(0);
    expect(road.kind).toBe("arterial");
    expect(road.closed).toBe(false);
    expect(vehicle.type).toBe("car");
    expect(vehicle.state).toBe("queued");
  });

  it("exposes the PRD run-configuration choices", () => {
    const sizes: CitySize[] = [
      "small",
      "small-medium",
      "medium",
      "medium-large",
      "large",
    ];
    const levels: TrafficLevel[] = ["light", "everyday", "rush-hour"];
    const controllers: ControllerType[] = ["fixed", "adaptive", "jev"];

    expect(sizes).toHaveLength(5);
    expect(levels).toHaveLength(3);
    expect(controllers).toHaveLength(3);
  });
});
