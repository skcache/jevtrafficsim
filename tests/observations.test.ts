import { describe, expect, it } from "vitest";
import { createFixedController } from "@/controllers/fixed";
import {
  approachArrivalRatePerSecond,
  buildObservationFrame,
  createApproachArrivalTracker,
  expireApproachArrivals,
  recordApproachArrival,
} from "@/sim/observations";
import { createEngine, runEngine, stepEngine, type EngineState } from "@/sim/engine";
import type { City, Intersection, Road } from "@/sim/types";
import { makeCrossroads, makeStreet } from "./traffic-support";

function engineFor(city: City, spawns: Parameters<typeof createEngine>[0]["spawns"]): EngineState {
  return createEngine({ city, controller: createFixedController(), spawns });
}

/**
 * Signalized 4-arm fixture with INDEPENDENT arm lengths: center 0 at (100,100),
 * east approach road 0 / exit road 1, north approach road 2 / exit road 3.
 * Fails over to geometric grouping: group 0 = east approach, group 1 = north
 * approach (red first under the default timing).
 */
function signalCity(spec: {
  eastApproach: number;
  eastExit: number;
  northApproach: number;
  northExit: number;
}): City {
  const road = (id: number, from: number, to: number, length: number): Road => ({
    id,
    from,
    to,
    length,
    lanes: 1,
    speedLimit: 10,
    capacity: 4,
    kind: "local",
    closed: false,
  });
  const node = (id: number, x: number, y: number, control: "signal" | "uncontrolled"): Intersection => ({
    id,
    x,
    y,
    incoming: [],
    outgoing: [],
    control,
    regionId: 0,
  });
  const intersections: Intersection[] = [
    node(0, 100, 100, "signal"),
    node(1, 100 - spec.eastApproach, 100, "uncontrolled"),
    node(2, 100 + spec.eastExit, 100, "uncontrolled"),
    node(3, 100, 100 - spec.northApproach, "uncontrolled"),
    node(4, 100, 100 + spec.northExit, "uncontrolled"),
  ];
  const roads: Road[] = [
    road(0, 1, 0, spec.eastApproach),
    road(1, 0, 2, spec.eastExit),
    road(2, 3, 0, spec.northApproach),
    road(3, 0, 4, spec.northExit),
  ];
  for (const r of roads) {
    intersections[r.from].outgoing.push(r.id);
    intersections[r.to].incoming.push(r.id);
  }
  return {
    size: "small",
    seed: 0,
    gridWidth: 2,
    gridHeight: 2,
    intersections,
    roads,
    corridors: [],
  };
}

describe("approach-arrival events", () => {
  it("records one arrival for a direct pass and none at the destination", () => {
    // Car crosses road 0's end (uncontrolled, immediate), then finishes road 1.
    const { city } = makeStreet([{ length: 2, speedLimit: 10 }, { length: 4, speedLimit: 10 }]);
    const engine = engineFor(city, [{ timeMs: 0, type: "car", origin: 0, destination: 2 }]);
    runEngine(engine, 600);
    expect(engine.arrivals.counts.get(0)).toBe(1); // the crossing
    expect(engine.arrivals.counts.get(1)).toBeUndefined(); // final arrival is not demand
    expect(approachArrivalRatePerSecond(engine.arrivals, 0)).toBeCloseTo(0.2, 12);
  });

  it("counts a vehicle that has to queue once, never its retries", () => {
    // North approach (road 2) is red first under the default timing: the car
    // reaches the end, queues for ~34 s, then crosses on green. Retries inside
    // the queue phase must not report new arrivals, and the exit road must not
    // count either (its end is the final trip arrival).
    const { city } = makeCrossroads({
      control: "signal",
      arms: [
        { angleDeg: 0, length: 2 },
        { angleDeg: 90, length: 2 },
      ],
    });
    const engine = engineFor(city, [{ timeMs: 0, type: "car", origin: 3, destination: 4 }]);
    runEngine(engine, 2_000);
    expect(engine.traffic.vehicles[0].state).toBe("queued");
    expect(engine.arrivals.counts.get(2)).toBe(1);
    runEngine(engine, 4_900); // ~47 more queued retries, still inside the window
    expect(engine.traffic.vehicles[0].state).toBe("queued");
    expect(engine.arrivals.counts.get(2)).toBe(1); // retries never recount
    runEngine(engine, 41_000); // released at ~34.1 s, crosses, finishes
    expect(engine.traffic.vehicles[0].state).toBe("arrived");
    // Exactly one arrival was ever reported — and the exit road never counts.
    expect(engine.arrivals.events).toEqual([{ timeMs: 200, roadId: 2 }]);
    expect(engine.arrivals.counts.size).toBe(0);
  });

  it("records each road end crossed within one timestep (leftover distance)", () => {
    const { city } = makeStreet([
      { length: 1, speedLimit: 20 },
      { length: 1, speedLimit: 20 },
      { length: 5, speedLimit: 10 },
    ]);
    const engine = engineFor(city, [{ timeMs: 0, type: "car", origin: 0, destination: 3 }]);
    stepEngine(engine); // 2 units of movement: crosses road 0 then road 1
    expect(engine.arrivals.counts.get(0)).toBe(1);
    expect(engine.arrivals.counts.get(1)).toBe(1);
    expect(engine.traffic.vehicles[0].roadId).toBe(2);
  });

  it("expires events after the rolling window (half-open at the old end)", () => {
    const tracker = createApproachArrivalTracker();
    recordApproachArrival(tracker, 1_000, 5);
    recordApproachArrival(tracker, 2_000, 5);
    expect(approachArrivalRatePerSecond(tracker, 5)).toBeCloseTo(0.4, 12);
    // An event exactly windowMs old is outside (now - window, now].
    expireApproachArrivals(tracker, 7_000);
    expect(approachArrivalRatePerSecond(tracker, 5)).toBe(0);
    // Recording after a gap expires old events while keeping the new one.
    recordApproachArrival(tracker, 12_001, 5);
    expect(approachArrivalRatePerSecond(tracker, 5)).toBeCloseTo(0.2, 12);
    recordApproachArrival(tracker, 12_100, 5);
    expect(approachArrivalRatePerSecond(tracker, 5)).toBeCloseTo(0.4, 12);
  });

  it("produces identical rates and frames for identical runs", () => {
    const make = () => {
      const { city } = makeCrossroads({
        control: "signal",
        arms: [
          { angleDeg: 0, length: 4 },
          { angleDeg: 90, length: 4 },
        ],
      });
      return {
        city,
        engine: engineFor(city, [
          { timeMs: 0, type: "car", origin: 1, destination: 2 },
          { timeMs: 0, type: "car", origin: 3, destination: 4 },
          { timeMs: 5_000, type: "truck", origin: 1, destination: 4 },
        ]),
      };
    };
    const serialize = (city: City, engine: EngineState) => {
      const frame = buildObservationFrame(city, engine.traffic, engine.arrivals);
      return JSON.stringify({
        timeMs: frame.timeMs,
        approaches: [...frame.approaches.entries()],
        intersections: [...frame.intersections.entries()],
      });
    };
    const a = make();
    const b = make();
    for (let tick = 0; tick < 200; tick += 1) {
      stepEngine(a.engine);
      stepEngine(b.engine);
      if (tick % 50 === 0) {
        expect(serialize(a.city, a.engine)).toBe(serialize(b.city, b.engine));
      }
    }
    expect([...a.engine.arrivals.counts.entries()]).toEqual([...b.engine.arrivals.counts.entries()]);
  });
});

describe("approach observations", () => {
  it("carries queue, continuous wait, rate, occupancy and downstream ratio", () => {
    // Short north approach so the car queues at 2 ticks; long north exit so a
    // parked car holds its occupancy for the whole observation.
    const city = signalCity({ eastApproach: 4, eastExit: 4, northApproach: 2, northExit: 100 });
    const engine = engineFor(city, [
      { timeMs: 0, type: "car", origin: 3, destination: 4 }, // north approach -> north exit (queues)
      { timeMs: 0, type: "car", origin: 0, destination: 4 }, // parks on exit road 3
    ]);
    runEngine(engine, 2_000);
    const frame = buildObservationFrame(city, engine.traffic, engine.arrivals);
    const observation = frame.approaches.get(2);
    expect(observation).toBeDefined();
    expect(observation?.queuedVehicles).toBe(1);
    expect(observation?.maxWaitMs).toBe(1_800); // continuous: queued since t=200
    expect(observation?.arrivalRatePerSecond).toBeCloseTo(0.2, 12);
    expect(observation?.approachOccupancyRatio).toBeCloseTo(0.25, 12);
    expect(observation?.downstreamOccupancyRatio).toBeCloseTo(0.25, 12); // exit road 3: 1 of 4

    // Phase aggregates build from the approach map: the queued car is in group
    // 1 (north axis), so phase 1 carries the pressure.
    const intersection = frame.intersections.get(0);
    expect(intersection?.phaseCount).toBe(2);
    expect(intersection?.phases[1].queuedVehicles).toBe(1);
    expect(intersection?.phases[1].maxWaitMs).toBe(1_800);
    expect(intersection?.phases[1].downstreamOccupancyRatio).toBeCloseTo(0.25, 12);
    expect(intersection?.phases[0].queuedVehicles).toBe(0);
    expect(intersection?.phases[0].maxWaitMs).toBe(0);
  });

  it("uses the worst intended downstream and ignores vehicles without a next road", () => {
    const city = signalCity({ eastApproach: 4, eastExit: 4, northApproach: 2, northExit: 50 });
    const engine = engineFor(city, [
      { timeMs: 0, type: "car", origin: 3, destination: 4 }, // north approach -> exit road 3
      { timeMs: 0, type: "car", origin: 0, destination: 4 }, // parks on exit road 3
      { timeMs: 0, type: "car", origin: 0, destination: 4 }, // parks on exit road 3 (2 of 4 units)
    ]);
    runEngine(engine, 1_000);
    const frame = buildObservationFrame(city, engine.traffic, engine.arrivals);
    // Vehicles on their final leg contribute no downstream intentions.
    expect(frame.approaches.get(3)?.downstreamOccupancyRatio).toBe(0);
    expect(frame.approaches.get(2)?.downstreamOccupancyRatio).toBeCloseTo(0.5, 12);
  });
});
