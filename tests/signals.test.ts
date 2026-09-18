import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_TIMING, type SignalTiming } from "@/sim/config";
import {
  canApproachProceed,
  createSignalState,
  deriveApproachGroups,
  permittedApproaches,
  stepSignal,
  validateSignalPlan,
  validateSignalState,
  type SignalState,
} from "@/sim/signals";
import { makeCrossroads } from "./traffic-support";

const FAST_TIMING: SignalTiming = {
  minGreenMs: 300,
  maxGreenMs: 1000,
  yellowMs: 200,
  allRedMs: 100,
};

function cross() {
  return makeCrossroads({
    control: "signal",
    arms: [
      { angleDeg: 0, length: 2 },
      { angleDeg: 90, length: 2 },
      { angleDeg: 180, length: 2 },
      { angleDeg: 270, length: 2 },
    ],
  });
}

describe("approach group derivation", () => {
  it("splits a four-way cross into opposing street groups", () => {
    const { city, centerId, approachRoadIds } = cross();
    const groups = deriveApproachGroups(city, centerId);
    expect(groups[0]).toEqual([approachRoadIds[0], approachRoadIds[2]]);
    expect(groups[1]).toEqual([approachRoadIds[1], approachRoadIds[3]]);
    expect(validateSignalPlan(groups)).toEqual([]);
  });

  it("handles T-junctions and skewed geometry deterministically", () => {
    const t = makeCrossroads({
      control: "signal",
      arms: [
        { angleDeg: 0, length: 2 },
        { angleDeg: 90, length: 2 },
        { angleDeg: 180, length: 2 },
      ],
    });
    const tGroups = deriveApproachGroups(t.city, t.centerId);
    expect(tGroups[0]).toEqual([t.approachRoadIds[0], t.approachRoadIds[2]]);
    expect(tGroups[1]).toEqual([t.approachRoadIds[1]]);

    const skewed = makeCrossroads({
      control: "signal",
      arms: [
        { angleDeg: 47, length: 2 },
        { angleDeg: 137, length: 2 },
        { angleDeg: 227, length: 2 },
        { angleDeg: 317, length: 2 },
      ],
    });
    const skewedGroups = deriveApproachGroups(skewed.city, skewed.centerId);
    expect(skewedGroups[0]).toEqual([
      skewed.approachRoadIds[0],
      skewed.approachRoadIds[2],
    ]);
    expect(skewedGroups[1]).toEqual([
      skewed.approachRoadIds[1],
      skewed.approachRoadIds[3],
    ]);
    expect(validateSignalPlan(skewedGroups)).toEqual([]);
  });
});

describe("signal state machine", () => {
  it("starts in a legal green state with default timing", () => {
    const { city, centerId } = cross();
    const state = createSignalState(city, centerId);
    expect(state.stage).toBe("green");
    expect(state.phaseIndex).toBe(0);
    expect(state.stageElapsedMs).toBe(0);
    expect(state.timing).toEqual(DEFAULT_SIGNAL_TIMING);
    expect(validateSignalState(state)).toEqual([]);
  });

  it("runs green -> yellow -> all-red -> opposite green with exact durations", () => {
    const { city, centerId } = cross();
    const state = createSignalState(city, centerId, FAST_TIMING);
    for (let i = 0; i < 9; i += 1) {
      stepSignal(state, 100);
    }
    expect(state.stage).toBe("green");
    expect(state.stageElapsedMs).toBe(900);
    stepSignal(state, 100); // 1000 >= maxGreen -> yellow
    expect(state.stage).toBe("yellow");
    expect(state.stageElapsedMs).toBe(0);
    stepSignal(state, 100); // 100 < 200
    expect(state.stage).toBe("yellow");
    stepSignal(state, 100); // 200 -> all-red
    expect(state.stage).toBe("all-red");
    stepSignal(state, 100); // 100 >= 100 -> green phase 1
    expect(state.stage).toBe("green");
    expect(state.phaseIndex).toBe(1);
    expect(state.stageElapsedMs).toBe(0);
  });

  it("defers a phase request until minimum green has elapsed", () => {
    const { city, centerId } = cross();
    const state = createSignalState(city, centerId, FAST_TIMING);
    stepSignal(state, 100, 1);
    expect(state.stage).toBe("green"); // 100 < 300
    stepSignal(state, 100, 1);
    expect(state.stage).toBe("green"); // 200 < 300
    stepSignal(state, 100, 1);
    expect(state.stage).toBe("yellow"); // 300 >= 300
  });

  it("never holds green longer than maximum green without requests", () => {
    const { city, centerId } = cross();
    const state = createSignalState(city, centerId, FAST_TIMING);
    let ticks = 0;
    while (state.stage === "green" && ticks < 100) {
      stepSignal(state, 100);
      ticks += 1;
    }
    expect(ticks).toBe(10);
    expect(state.stage).toBe("yellow");
  });

  it("honours exact stage durations across many cycles", () => {
    const { city, centerId } = cross();
    const state = createSignalState(city, centerId, FAST_TIMING);
    const runs: Array<{ stage: string; ticks: number }> = [];
    let current: string = state.stage;
    let run = 0;
    for (let i = 0; i < 300; i += 1) {
      stepSignal(state, 100);
      if (state.stage === current) {
        run += 1;
      } else {
        runs.push({ stage: current, ticks: run + 1 });
        current = state.stage;
        run = 0;
      }
    }
    expect(runs.length).toBeGreaterThan(20);
    for (const { stage, ticks } of runs) {
      if (stage === "green") {
        expect(ticks).toBe(10);
      } else if (stage === "yellow") {
        expect(ticks).toBe(2);
      } else {
        expect(ticks).toBe(1);
      }
    }
  });

  it("never permits conflicting groups across transitions", () => {
    const { city, centerId } = cross();
    const state = createSignalState(city, centerId, FAST_TIMING);
    const g0 = new Set(state.groups[0]);
    const g1 = new Set(state.groups[1]);
    for (let i = 0; i < 400; i += 1) {
      stepSignal(state, 100, i % 7 < 2 ? 1 : 0);
      expect(validateSignalState(state)).toEqual([]);
      const permitted = permittedApproaches(state);
      if (state.stage === "green") {
        const fromG0 = permitted.filter((id) => g0.has(id)).length;
        const fromG1 = permitted.filter((id) => g1.has(id)).length;
        expect(fromG0 === 0 || fromG1 === 0).toBe(true);
        expect(fromG0 + fromG1).toBe(permitted.length);
      } else {
        expect(permitted).toEqual([]);
      }
    }
  });

  it("grants permission per approach group; yellow and all-red block new entries", () => {
    const { city, centerId, approachRoadIds } = cross();
    const state = createSignalState(city, centerId, FAST_TIMING);
    expect(canApproachProceed(state, approachRoadIds[0])).toBe(true);
    expect(canApproachProceed(state, approachRoadIds[2])).toBe(true);
    expect(canApproachProceed(state, approachRoadIds[1])).toBe(false);
    expect(canApproachProceed(state, approachRoadIds[3])).toBe(false);

    stepSignal(state, 100, 1);
    stepSignal(state, 100, 1);
    stepSignal(state, 100, 1); // -> yellow
    expect(state.stage).toBe("yellow");
    for (const roadId of approachRoadIds) {
      expect(canApproachProceed(state, roadId)).toBe(false);
    }
    stepSignal(state, 100);
    stepSignal(state, 100); // -> all-red
    expect(state.stage).toBe("all-red");
    stepSignal(state, 100); // -> green phase 1
    expect(canApproachProceed(state, approachRoadIds[1])).toBe(true);
    expect(canApproachProceed(state, approachRoadIds[0])).toBe(false);
  });

  it("validates plans, timings, and malformed states", () => {
    expect(validateSignalPlan([[0, 1], [1, 2]])).not.toEqual([]);
    expect(validateSignalPlan([[], []])).not.toEqual([]);

    const { city, centerId } = cross();
    expect(() =>
      createSignalState(city, centerId, {
        minGreenMs: 0,
        maxGreenMs: 1000,
        yellowMs: 200,
        allRedMs: 100,
      }),
    ).toThrow(RangeError);
    expect(() =>
      createSignalState(city, centerId, {
        minGreenMs: 2000,
        maxGreenMs: 1000,
        yellowMs: 200,
        allRedMs: 100,
      }),
    ).toThrow(RangeError);

    const state = createSignalState(city, centerId, FAST_TIMING);
    const negative: SignalState = { ...state, stageElapsedMs: -1 };
    expect(validateSignalState(negative)).not.toEqual([]);
    const badStage = { ...state, stage: "flashing" } as unknown as SignalState;
    expect(validateSignalState(badStage)).not.toEqual([]);
  });
});
