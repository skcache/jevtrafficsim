import { describe, expect, it } from "vitest";
import {
  ADAPTIVE_CONSTANTS,
  adaptiveDirective,
  phasePressure,
  starvedPhaseIndex,
} from "@/controllers/adaptive";
import { DEFAULT_SIGNAL_TIMING } from "@/sim/config";
import type { IntersectionObservation, PhaseObservation } from "@/sim/observations";
import type { SignalState, SignalStage } from "@/sim/signals";

function phase(
  phaseIndex: number,
  overrides: Partial<PhaseObservation> = {},
): PhaseObservation {
  return {
    phaseIndex,
    roads: [phaseIndex * 10],
    queuedVehicles: 0,
    maxWaitMs: 0,
    arrivalRatePerSecond: 0,
    occupancyRatio: 0,
    downstreamOccupancyRatio: 0,
    ...overrides,
  };
}

function observation(
  phases: PhaseObservation[],
  overrides: Partial<IntersectionObservation> = {},
): IntersectionObservation {
  return {
    intersectionId: 0,
    stage: "green",
    phaseIndex: 0,
    stageElapsedMs: 10_000,
    phaseCount: phases.length,
    phases,
    ...overrides,
  };
}

function signal(overrides: Partial<SignalState> = {}): SignalState {
  return {
    intersectionId: 0,
    groups: [[0], [10]],
    phaseIndex: 0,
    stage: "green" as SignalStage,
    stageElapsedMs: 10_000,
    timing: { ...DEFAULT_SIGNAL_TIMING },
    ...overrides,
  };
}

describe("adaptive phase pressure", () => {
  it("raises pressure with larger queues", () => {
    const low = phasePressure(phase(0, { queuedVehicles: 0 }));
    const mid = phasePressure(phase(0, { queuedVehicles: 3 }));
    const high = phasePressure(phase(0, { queuedVehicles: 6 }));
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
  });

  it("raises pressure substantially with longer continuous waits", () => {
    const fresh = phasePressure(phase(0, { maxWaitMs: 0 }));
    const long = phasePressure(phase(0, { maxWaitMs: 15_000 }));
    const starving = phasePressure(phase(0, { maxWaitMs: 45_000 }));
    expect(fresh).toBeLessThan(long);
    expect(long).toBeLessThan(starving);
    // Wait is the heaviest term: 45 s of wait outweighs a queue of 6 vehicles.
    expect(starving).toBeGreaterThan(
      phasePressure(phase(0, { queuedVehicles: ADAPTIVE_CONSTANTS.QUEUE_SCALE_VEHICLES })),
    );
  });

  it("raises pressure with higher arrival rates", () => {
    const idle = phasePressure(phase(0, { arrivalRatePerSecond: 0 }));
    const busy = phasePressure(phase(0, { arrivalRatePerSecond: 0.5 }));
    const flooding = phasePressure(phase(0, { arrivalRatePerSecond: 1.5 }));
    expect(idle).toBeLessThan(busy);
    expect(busy).toBeLessThan(flooding);
  });

  it("lowers effective pressure when the intended downstream is saturated", () => {
    const clear = phasePressure(phase(0, { queuedVehicles: 4, downstreamOccupancyRatio: 0 }));
    const half = phasePressure(phase(0, { queuedVehicles: 4, downstreamOccupancyRatio: 0.5 }));
    const saturated = phasePressure(phase(0, { queuedVehicles: 4, downstreamOccupancyRatio: 1 }));
    expect(clear).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(saturated);
    // A fully saturated exit can zero a phase's desire but never invert it.
    expect(
      phasePressure(
        phase(0, { queuedVehicles: 0, maxWaitMs: 0, arrivalRatePerSecond: 0, downstreamOccupancyRatio: 1 }),
      ),
    ).toBe(0);
  });

  it("never produces NaN, infinity or negative pressure", () => {
    const extremes: Array<Parameters<typeof phase>[1]> = [
      { queuedVehicles: 1e9, maxWaitMs: 1e9, arrivalRatePerSecond: 1e9, downstreamOccupancyRatio: 1 },
      { queuedVehicles: -5, maxWaitMs: -5, arrivalRatePerSecond: -5, downstreamOccupancyRatio: -1 },
      { downstreamOccupancyRatio: Number.NaN },
      { downstreamOccupancyRatio: Number.POSITIVE_INFINITY },
    ];
    for (const overrides of extremes) {
      const pressure = phasePressure(phase(0, overrides));
      expect(Number.isFinite(pressure)).toBe(true);
      expect(pressure).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("adaptive directives", () => {
  it("gives no opinion for single-group signals or non-green stages", () => {
    const single = signal({ groups: [[0]] });
    expect(adaptiveDirective(single, observation([phase(0)]))).toBeUndefined();
    for (const stage of ["yellow", "all-red"] as SignalStage[]) {
      const clearing = signal({ stage });
      expect(
        adaptiveDirective(clearing, observation([phase(0, { queuedVehicles: 9 }), phase(1, { queuedVehicles: 9 })])),
      ).toBeUndefined();
    }
  });

  it("never advances before minimum green, however loud the successor is", () => {
    const young = signal({ stageElapsedMs: DEFAULT_SIGNAL_TIMING.minGreenMs - 100 });
    const loud = observation([phase(0), phase(1, { queuedVehicles: 20, maxWaitMs: 20_000 })]);
    expect(adaptiveDirective(young, loud)).toBeUndefined();
  });

  it("keeps a current phase whose demand materially dominates the successor", () => {
    const current = signal({ stageElapsedMs: 10_000 });
    const pressure = observation([
      phase(0, { queuedVehicles: 12, arrivalRatePerSecond: 1 }), // ~2.0
      phase(1, { queuedVehicles: 3 }), // ~0.5
    ]);
    expect(adaptiveDirective(current, pressure)).toBe("hold");
  });

  it("advances when the successor beats the current phase by the switch margin", () => {
    const current = signal({ stageElapsedMs: 10_000 });
    const pressure = observation([
      phase(0, { queuedVehicles: 2 }), // ~0.33; diff 1.17 > margin (0.44 at age 1/3)
      phase(1, { queuedVehicles: 9 }), // ~1.5
    ]);
    expect(adaptiveDirective(current, pressure)).toBe("advance");
  });

  it("does not flap around equal scores (hysteresis margin)", () => {
    const current = signal({ stageElapsedMs: 5_000 });
    // Successor barely ahead: within the switch margin at young age.
    const nearTie = observation([
      phase(0, { queuedVehicles: 3 }), // 0.5
      phase(1, { queuedVehicles: 3, arrivalRatePerSecond: 0.2 }), // 0.5 + 0.4 = 0.9
    ]);
    // diff 0.4 < margin 0.6 * (1 - 0.8 * (5000/30000)) = 0.52 -> hold
    expect(adaptiveDirective(current, nearTie)).toBe("hold");
    // Identical observations, identical directive: no random tie-breaking.
    expect(adaptiveDirective(current, nearTie)).toBe("hold");
  });

  it("advances when the current phase has no meaningful demand and the successor does", () => {
    const current = signal({ stageElapsedMs: 6_000 });
    const idle = observation([phase(0), phase(1, { queuedVehicles: 1 })]);
    expect(adaptiveDirective(current, idle)).toBe("advance");
    const bothIdle = observation([phase(0), phase(1)]);
    expect(adaptiveDirective(current, bothIdle)).toBe("hold");
  });

  it("gives greater phase age more willingness to switch", () => {
    // Successor leads by 0.2: inside the young margin, outside the aged one.
    const phases = [phase(0, { queuedVehicles: 6, maxWaitMs: 6_000 }), phase(1, { queuedVehicles: 9 })];
    const young = signal({ stageElapsedMs: 10_000 });
    expect(adaptiveDirective(young, observation(phases))).toBe("hold");
    const aged = signal({ stageElapsedMs: DEFAULT_SIGNAL_TIMING.maxGreenMs });
    expect(adaptiveDirective(aged, observation(phases))).toBe("advance");
  });

  it("is deterministic: identical observations produce identical directives", () => {
    const fixtureSignal = signal({ stageElapsedMs: 12_000 });
    const fixture = observation([
      phase(0, { queuedVehicles: 4, maxWaitMs: 3_000, arrivalRatePerSecond: 0.4 }),
      phase(1, { queuedVehicles: 5, maxWaitMs: 2_000, downstreamOccupancyRatio: 0.8 }),
    ]);
    const first = adaptiveDirective(fixtureSignal, fixture);
    for (let i = 0; i < 5; i += 1) {
      expect(adaptiveDirective(fixtureSignal, fixture)).toBe(first);
    }
  });
});

describe("adaptive anti-starvation rule", () => {
  it("picks the greatest continuous wait, then the lowest phase index", () => {
    const starved = [
      phase(0),
      phase(1, { maxWaitMs: 40_000 }),
      phase(2, { maxWaitMs: 40_000 }),
    ];
    expect(starvedPhaseIndex(starved, 0)).toBe(1); // tie -> lowest index
    const unequal = [phase(0), phase(1, { maxWaitMs: 40_000 }), phase(2, { maxWaitMs: 41_000 })];
    expect(starvedPhaseIndex(unequal, 0)).toBe(2); // greatest wait wins
    const below = [phase(0), phase(1, { maxWaitMs: ADAPTIVE_CONSTANTS.STARVATION_THRESHOLD_MS - 100 })];
    expect(starvedPhaseIndex(below, 0)).toBeNull();
    const currentStarved = [phase(0, { maxWaitMs: 90_000 }), phase(1, { maxWaitMs: 36_000 })];
    expect(starvedPhaseIndex(currentStarved, 0)).toBe(1); // current is served, not "starved"
  });

  it("advances toward a starved phase even when normal policy would keep serving", () => {
    // Current phase dominates on every normal term; phase 2 is starving.
    const current = signal({
      groups: [[0], [10], [20]],
      phaseIndex: 0,
      stageElapsedMs: 15_000,
    });
    const pressure = observation([
      phase(0, { queuedVehicles: 12, arrivalRatePerSecond: 1 }), // ~2.0
      phase(1, { queuedVehicles: 1 }),
      phase(2, { maxWaitMs: 36_000, queuedVehicles: 1 }), // starved, 1 ring position past next
    ]);
    expect(adaptiveDirective(current, pressure)).toBe("advance");
  });

  it("keeps walking the ring until the starved phase is served", () => {
    // Same fixture, ring has reached phase 1: phase 2 still starving.
    const intermediate = signal({ groups: [[0], [10], [20]], phaseIndex: 1, stageElapsedMs: 9_000 });
    const pressure = observation([
      phase(0, { queuedVehicles: 12 }),
      phase(1, { queuedVehicles: 1 }),
      phase(2, { maxWaitMs: 36_000, queuedVehicles: 1 }),
    ]);
    expect(adaptiveDirective(intermediate, pressure)).toBe("advance");
  });

  it("guarantees a meaningful green once the starved phase is current", () => {
    const serving = signal({ groups: [[0], [10]], phaseIndex: 1, stageElapsedMs: 1_000 });
    const pressure = observation([
      phase(0, { queuedVehicles: 15 }), // successor screaming for service
      phase(1, { maxWaitMs: 40_000 }), // the starved phase, now green
    ]);
    expect(adaptiveDirective(serving, pressure)).toBe("hold"); // minimum service
    const served = signal({ groups: [[0], [10]], phaseIndex: 1, stageElapsedMs: 9_000 });
    expect(adaptiveDirective(served, pressure)).toBe("advance"); // past minimum service
  });

  it("still defers to minimum green while walking toward the starved phase", () => {
    const young = signal({ groups: [[0], [10], [20]], phaseIndex: 0, stageElapsedMs: 2_000 });
    const pressure = observation([
      phase(0, { queuedVehicles: 12 }),
      phase(1, { queuedVehicles: 1 }),
      phase(2, { maxWaitMs: 36_000 }),
    ]);
    expect(adaptiveDirective(young, pressure)).toBeUndefined(); // min green is mechanics law
  });
});
