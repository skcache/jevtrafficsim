import { describe, expect, it } from "vitest";
import {
  FIXED_GREEN_MS,
  createFixedController,
  intersectionClass,
} from "@/controllers/fixed";
import { SIMULATION_TIMESTEP_MS as DT } from "@/sim/config";
import { generateCity } from "@/sim/city-generator";
import {
  createTrafficState,
  spawnVehicle,
  stepTraffic,
} from "@/sim/traffic";
import type { TrafficState } from "@/sim/traffic";
import type { City } from "@/sim/types";
import { makeCrossroads } from "./traffic-support";

function crossroads(kind?: "local" | "arterial" | "highway") {
  return makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 2, kind },
      { angleDeg: 90, length: 2, kind },
      { angleDeg: 180, length: 2, kind },
      { angleDeg: 270, length: 2, kind },
    ],
  });
}

function driveWithController(
  city: City,
  state: TrafficState,
  ticks: number,
): Array<{ tick: number; stage: string; phaseIndex: number }> {
  const controller = createFixedController();
  const transitions: Array<{ tick: number; stage: string; phaseIndex: number }> = [];
  let last: string | null = null;
  for (let tick = 1; tick <= ticks; tick += 1) {
    const directives = controller.directives(city, state);
    stepTraffic(city, state, DT, { signalDirectives: directives });
    const signal = [...state.signals.values()][0];
    const marker = `${signal.stage}|${signal.phaseIndex}`;
    if (last !== null && marker !== last) {
      transitions.push({ tick, stage: signal.stage, phaseIndex: signal.phaseIndex });
    }
    last = marker;
  }
  return transitions;
}

describe("fixed controller", () => {
  it("classifies intersections by their most significant road kind", () => {
    const local = crossroads();
    expect(intersectionClass(local.city, local.centerId)).toBe("local");
    const arterial = crossroads("arterial");
    expect(intersectionClass(arterial.city, arterial.centerId)).toBe("arterial");
    const highway = crossroads("highway");
    expect(intersectionClass(highway.city, highway.centerId)).toBe("highway");
    // Highway wins over arterial when both touch the intersection.
    const mixed = makeCrossroads({
      control: "signal",
      arms: [
        { angleDeg: 0, length: 2, kind: "arterial" },
        { angleDeg: 90, length: 2, kind: "highway" },
        { angleDeg: 180, length: 2, kind: "local" },
      ],
    });
    expect(intersectionClass(mixed.city, mixed.centerId)).toBe("highway");
  });

  it("switches a local intersection at its fixed green duration", () => {
    const { city } = crossroads();
    const state = createTrafficState();
    const transitions = driveWithController(city, state, 400);
    // Local fixed green: 12000ms -> first switch on tick 121; the transition
    // tick itself is charged to the outgoing stage, so the following stages
    // are offset by one tick. Yellow 3000ms, all-red 1000ms, then the ring.
    expect(transitions).toEqual([
      { tick: 121, stage: "yellow", phaseIndex: 0 },
      { tick: 151, stage: "all-red", phaseIndex: 0 },
      { tick: 161, stage: "green", phaseIndex: 1 },
      { tick: 282, stage: "yellow", phaseIndex: 1 },
      { tick: 312, stage: "all-red", phaseIndex: 1 },
      { tick: 322, stage: "green", phaseIndex: 0 },
    ]);
  });

  it("switches a highway intersection later than a local one", () => {
    const { city } = crossroads("highway");
    const state = createTrafficState();
    const transitions = driveWithController(city, state, 300);
    expect(transitions[0]).toEqual({ tick: 241, stage: "yellow", phaseIndex: 0 });
    expect(FIXED_GREEN_MS.highway).toBeGreaterThan(FIXED_GREEN_MS.local);
  });

  it("is queue-blind: directives ignore traffic content", () => {
    const { city, approachRoadIds, exitRoadIds } = crossroads();
    const empty = createTrafficState();
    const loaded = createTrafficState();
    // A car on the 90deg arm (group 1) queues at red for most of the run.
    spawnVehicle(city, loaded, {
      id: 0,
      type: "car",
      origin: 3,
      destination: 4,
      route: [approachRoadIds[1], exitRoadIds[1]],
    });
    const controller = createFixedController();
    let nonEmpty = 0;
    for (let tick = 0; tick < 400; tick += 1) {
      const emptyDirectives = controller.directives(city, empty);
      const loadedDirectives = controller.directives(city, loaded);
      expect([...loadedDirectives.entries()]).toEqual([...emptyDirectives.entries()]);
      if (emptyDirectives.size > 0) {
        nonEmpty += 1;
      }
      stepTraffic(city, empty, DT, { signalDirectives: emptyDirectives });
      stepTraffic(city, loaded, DT, { signalDirectives: loadedDirectives });
    }
    expect(nonEmpty).toBeGreaterThan(0); // directive maps really were compared
    expect(loaded.vehicles[0].state).toBe("arrived"); // the queue existed and got served
    expect(loaded.vehicles[0].waitTimeMs).toBeGreaterThan(0);
  });

  it("emits advance directives only for multi-group signals, deterministically", () => {
    const city = generateCity("medium", 42);
    const state = createTrafficState();
    const controller = createFixedController();
    expect(controller.directives(city, state).size).toBe(0); // no signals initialised yet
    for (let tick = 0; tick < 400; tick += 1) {
      stepTraffic(city, state, DT, { signalDirectives: controller.directives(city, state) });
    }
    const directives = controller.directives(city, state);
    for (const [intersectionId, directive] of directives) {
      expect(directive).toBe("advance");
      const signal = state.signals.get(intersectionId);
      expect(signal).toBeDefined();
      expect(signal?.groups.length).toBeGreaterThanOrEqual(2);
    }
    const again = controller.directives(city, state);
    expect([...again.entries()]).toEqual([...directives.entries()]);
  });

  it("has a stable id for run metadata", () => {
    expect(createFixedController().id).toBe("fixed");
  });
});
