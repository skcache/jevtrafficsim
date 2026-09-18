import { describe, expect, it } from "vitest";
import { DEFAULT_SIGNAL_TIMING, type SignalTiming } from "@/sim/config";
import {
  canApproachProceed,
  createSignalState,
  deriveApproachGroups,
  permittedApproaches,
  stepSignal,
  validateSignalPlan,
  validateSignalPlanForCity,
  validateSignalState,
} from "@/sim/signals";
import type { RoadId } from "@/sim/types";
import { makeCrossroads } from "./traffic-support";

const FAST_TIMING: SignalTiming = {
  minGreenMs: 300,
  maxGreenMs: 1000,
  yellowMs: 200,
  allRedMs: 100,
};

function cross(angleDegs: number[]) {
  return makeCrossroads({
    control: "signal",
    arms: angleDegs.map((angleDeg) => ({ angleDeg, length: 2 })),
  });
}

describe("approach group derivation", () => {
  it("splits a four-way cross into two opposing-axis groups, ordered by axis", () => {
    const { city, centerId, approachRoadIds } = cross([0, 90, 180, 270]);
    const groups = deriveApproachGroups(city, centerId);
    expect(groups).toEqual([
      [approachRoadIds[0], approachRoadIds[2]],
      [approachRoadIds[1], approachRoadIds[3]],
    ]);
    expect(validateSignalPlanForCity(city, centerId, groups)).toEqual([]);
  });

  it("splits a grid-plus-diagonal intersection into THREE axis groups", () => {
    const { city, centerId, approachRoadIds } = cross([0, 90, 180, 270, 45]);
    const groups = deriveApproachGroups(city, centerId);
    // Three distinct street axes: E/W, diagonal, N/S — nothing collapsed.
    expect(groups).toEqual([
      [approachRoadIds[0], approachRoadIds[2]], // 0deg / 180deg
      [approachRoadIds[4]], // 45deg diagonal stands alone
      [approachRoadIds[1], approachRoadIds[3]], // 90deg / 270deg
    ]);
    expect(validateSignalPlanForCity(city, centerId, groups)).toEqual([]);
  });

  it("never merges distinct non-opposing axes (three streets, 60deg apart)", () => {
    const { city, centerId, approachRoadIds } = cross([0, 60, 120, 180, 240, 300]);
    const groups = deriveApproachGroups(city, centerId);
    expect(groups).toEqual([
      [approachRoadIds[0], approachRoadIds[3]], // 0 / 180
      [approachRoadIds[1], approachRoadIds[4]], // 60 / 240
      [approachRoadIds[2], approachRoadIds[5]], // 120 / 300
    ]);
    expect(validateSignalPlanForCity(city, centerId, groups)).toEqual([]);
  });

  it("orders groups and road ids deterministically regardless of input order", () => {
    const { city, centerId } = cross([90, 0, 180, 270, 45]);
    const groups = deriveApproachGroups(city, centerId);
    // Arm order changed the road ids, but groups stay axis-ordered with sorted ids.
    expect(groups).toEqual([[2, 4], [8], [0, 6]]);
    expect(deriveApproachGroups(city, centerId)).toEqual(groups);
  });

  it("handles a single-axis street as one group", () => {
    const { city, centerId, approachRoadIds } = cross([0, 180]);
    const groups = deriveApproachGroups(city, centerId);
    expect(groups).toEqual([[approachRoadIds[0], approachRoadIds[1]]]);
    expect(validateSignalPlanForCity(city, centerId, groups)).toEqual([]);
  });

  it("handles T-junctions", () => {
    const { city, centerId, approachRoadIds } = cross([0, 90, 180]);
    const groups = deriveApproachGroups(city, centerId);
    expect(groups).toEqual([
      [approachRoadIds[0], approachRoadIds[2]],
      [approachRoadIds[1]],
    ]);
  });

  it("handles skewed opposing pairs within tolerance", () => {
    const { city, centerId, approachRoadIds } = cross([47, 137, 227, 317]);
    const groups = deriveApproachGroups(city, centerId);
    expect(groups).toEqual([
      [approachRoadIds[0], approachRoadIds[2]],
      [approachRoadIds[1], approachRoadIds[3]],
    ]);
    expect(validateSignalPlanForCity(city, centerId, groups)).toEqual([]);
  });
});

describe("signal state machine", () => {
  it("starts in a legal green state with default timing", () => {
    const { city, centerId } = cross([0, 90, 180, 270]);
    const state = createSignalState(city, centerId);
    expect(state.stage).toBe("green");
    expect(state.phaseIndex).toBe(0);
    expect(state.stageElapsedMs).toBe(0);
    expect(state.timing).toEqual(DEFAULT_SIGNAL_TIMING);
    expect(validateSignalState(state)).toEqual([]);
  });

  it("rejects intersections without approaches and bad timings", () => {
    const { city, centerId } = cross([]);
    expect(() => createSignalState(city, centerId)).toThrow(RangeError);
    const bad = cross([0, 180]);
    expect(() =>
      createSignalState(bad.city, bad.centerId, { ...FAST_TIMING, minGreenMs: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      createSignalState(bad.city, bad.centerId, {
        ...FAST_TIMING,
        minGreenMs: 2000,
        maxGreenMs: 1000,
      }),
    ).toThrow(RangeError);
  });

  it("runs green -> yellow -> all-red -> opposite green with exact durations", () => {
    const { city, centerId } = cross([0, 90, 180, 270]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    for (let i = 0; i < 9; i += 1) {
      stepSignal(state, 100);
    }
    expect(state.stage).toBe("green"); // 900ms < maxGreen 1000
    stepSignal(state, 100); // elapsed hits 1000 -> yellow
    expect(state.stage).toBe("yellow");
    expect(state.stageElapsedMs).toBe(0);
    stepSignal(state, 100);
    expect(state.stage).toBe("yellow"); // 100 < 200
    stepSignal(state, 100);
    expect(state.stage).toBe("all-red"); // 200 reached
    stepSignal(state, 100);
    expect(state.stage).toBe("green"); // all-red 100 reached -> opposite green
    expect(state.phaseIndex).toBe(1);
  });

  it("cycles N groups in a ring: 0 -> 1 -> 2 -> 0", () => {
    const { city, centerId } = cross([0, 90, 180, 270, 45]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    const transitions: string[] = [];
    let last = `${state.phaseIndex}:${state.stage}`;
    for (let tick = 1; tick <= 40; tick += 1) {
      stepSignal(state, 100);
      const current = `${state.phaseIndex}:${state.stage}`;
      if (current !== last) {
        transitions.push(`t${tick} ${current}`);
        last = current;
      }
    }
    expect(transitions).toEqual([
      "t10 0:yellow",
      "t12 0:all-red",
      "t13 1:green",
      "t23 1:yellow",
      "t25 1:all-red",
      "t26 2:green",
      "t36 2:yellow",
      "t38 2:all-red",
      "t39 0:green",
    ]);
  });

  it("holds one-group signals green indefinitely without clearance cycles", () => {
    const { city, centerId, approachRoadIds } = cross([0, 180]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    for (let tick = 0; tick < 1000; tick += 1) {
      stepSignal(state, 100);
      expect(state.stage).toBe("green");
      expect(state.phaseIndex).toBe(0);
    }
    for (const roadId of approachRoadIds) {
      expect(canApproachProceed(state, roadId)).toBe(true);
    }
    stepSignal(state, 100, "hold"); // explicit hold — still green
    stepSignal(state, 100, "advance"); // nothing to advance to — still green
    expect(state.stage).toBe("green");
    expect(validateSignalState(state)).toEqual([]);
  });

  it("ignores an early advance directive before minimum green", () => {
    const { city, centerId } = cross([0, 90, 180, 270]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    stepSignal(state, 100, "advance"); // elapsed 100 < 300
    expect(state.stage).toBe("green");
    stepSignal(state, 100, "advance"); // elapsed 200 < 300
    expect(state.stage).toBe("green");
    stepSignal(state, 100, "advance"); // elapsed 300 >= 300 -> switch
    expect(state.stage).toBe("yellow");
  });

  it("never exceeds maximum green even without requests", () => {
    const { city, centerId } = cross([0, 90, 180, 270]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    let ticks = 0;
    while (state.stage === "green" && ticks < 100) {
      stepSignal(state, 100);
      ticks += 1;
    }
    expect(ticks).toBe(10);
    expect(state.stage).toBe("yellow");
    // An explicit hold cannot keep green past max green either.
    const held = createSignalState(city, centerId, FAST_TIMING);
    let heldTicks = 0;
    while (held.stage === "green" && heldTicks < 100) {
      stepSignal(held, 100, "hold");
      heldTicks += 1;
    }
    expect(heldTicks).toBe(10);
    expect(held.stage).toBe("yellow");
  });

  it("rejects invalid directives and advances the ring one group at a time", () => {
    const { city, centerId } = cross([0, 90, 180, 270, 45]); // three groups
    const state = createSignalState(city, centerId, FAST_TIMING);
    expect(() => stepSignal(state, 100, "jump" as never)).toThrow(RangeError);
    expect(() => stepSignal(state, 100, 2 as never)).toThrow(RangeError);
    for (let i = 0; i < 3; i += 1) {
      stepSignal(state, 100, "advance");
    }
    expect(state.stage).toBe("yellow");
    while (state.stage !== "green") {
      stepSignal(state, 100, "advance");
    }
    expect(state.phaseIndex).toBe(1); // (0 + 1) % 3 — never skips a group
  });

  it("yellow and all-red durations are fully respected across many cycles", () => {
    const { city, centerId } = cross([0, 90, 180, 270]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    const runs: Array<{ stage: string; ticks: number }> = [];
    let current = state.stage;
    let run = 0;
    for (let i = 0; i < 500; i += 1) {
      stepSignal(state, 100);
      if (state.stage === current) {
        run += 1;
      } else {
        runs.push({ stage: current, ticks: run + 1 });
        current = state.stage;
        run = 0;
      }
    }
    expect(runs.length).toBeGreaterThan(10);
    for (const entry of runs) {
      if (entry.stage === "yellow") expect(entry.ticks).toBe(2);
      if (entry.stage === "all-red") expect(entry.ticks).toBe(1);
      if (entry.stage === "green") expect(entry.ticks).toBe(10);
    }
  });

  it("never permits conflicting groups and keeps state valid across transitions", () => {
    const { city, centerId } = cross([0, 90, 180, 270, 45]); // three groups
    const state = createSignalState(city, centerId, FAST_TIMING);
    for (let i = 0; i < 600; i += 1) {
      const directive = i % 17 < 12 ? "advance" : "hold";
      stepSignal(state, 100, directive);
      expect(validateSignalState(state)).toEqual([]);
      const permitted = permittedApproaches(state);
      if (state.stage === "green") {
        expect(permitted).toEqual(state.groups[state.phaseIndex]);
        // Permitted roads come from exactly one group — never a mix.
        for (const group of state.groups) {
          const overlap = permitted.filter((roadId: RoadId) => group.includes(roadId));
          expect(overlap.length === permitted.length || overlap.length === 0).toBe(true);
        }
      } else {
        expect(permitted).toEqual([]);
      }
    }
  });

  it("grants permission only to the green group; yellow and all-red block new entries", () => {
    const { city, centerId, approachRoadIds } = cross([0, 90, 180, 270]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    expect(canApproachProceed(state, approachRoadIds[0])).toBe(true);
    expect(canApproachProceed(state, approachRoadIds[2])).toBe(true);
    expect(canApproachProceed(state, approachRoadIds[1])).toBe(false);
    stepSignal(state, 100, "advance");
    stepSignal(state, 100, "advance");
    stepSignal(state, 100, "advance"); // -> yellow
    expect(state.stage).toBe("yellow");
    for (const roadId of approachRoadIds) {
      expect(canApproachProceed(state, roadId)).toBe(false);
    }
    stepSignal(state, 100);
    stepSignal(state, 100); // -> all-red
    expect(state.stage).toBe("all-red");
    for (const roadId of approachRoadIds) {
      expect(canApproachProceed(state, roadId)).toBe(false);
    }
    stepSignal(state, 100); // -> green group 1
    expect(canApproachProceed(state, approachRoadIds[1])).toBe(true);
    expect(canApproachProceed(state, approachRoadIds[3])).toBe(true);
    expect(canApproachProceed(state, approachRoadIds[0])).toBe(false);
  });
});

describe("signal plan validation", () => {
  it("validateSignalPlan enforces non-empty groups and unique roads", () => {
    expect(validateSignalPlan([[0], [1]])).toEqual([]);
    expect(validateSignalPlan([[0, 1], [2]])).toEqual([]);
    expect(validateSignalPlan([])).not.toEqual([]);
    expect(validateSignalPlan([[], [1]])).not.toEqual([]);
    expect(validateSignalPlan([[0, 1], [1, 2]])).not.toEqual([]);
  });

  it("validateSignalPlanForCity checks partition and axis compatibility", () => {
    const { city, centerId } = cross([0, 90, 180, 270, 45]);
    const valid = deriveApproachGroups(city, centerId);
    expect(validateSignalPlanForCity(city, centerId, valid)).toEqual([]);
    // Two perpendicular approaches in one group is a conflict violation.
    const merged = [[valid[0][0], valid[2][0]], valid[1], [valid[0][1], valid[2][1]]];
    expect(validateSignalPlanForCity(city, centerId, merged)).not.toEqual([]);
    // Missing road.
    expect(
      validateSignalPlanForCity(city, centerId, [valid[0], valid[1], [valid[2][0]]]),
    ).not.toEqual([]);
    // Road that is not incoming.
    expect(
      validateSignalPlanForCity(city, centerId, [valid[0], valid[1], [valid[2][0], 999]]),
    ).not.toEqual([]);
    // Unknown intersection.
    expect(validateSignalPlanForCity(city, 42, valid)).not.toEqual([]);
  });

  it("validateSignalState flags malformed states", () => {
    const { city, centerId } = cross([0, 90, 180, 270, 45]);
    const state = createSignalState(city, centerId, FAST_TIMING);
    expect(validateSignalState({ ...state, stageElapsedMs: -1 })).not.toEqual([]);
    expect(validateSignalState({ ...state, phaseIndex: 5 })).not.toEqual([]);
    expect(validateSignalState({ ...state, stage: "flashing" as never })).not.toEqual([]);
  });
});
