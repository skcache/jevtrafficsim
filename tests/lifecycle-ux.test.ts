/**
 * Lifecycle UX tests (Issue #39).
 *
 * What is pinned here is the honesty of the run's lifecycle, not its pixels:
 *
 *   - a manual incident cannot silently destroy comparison eligibility: the
 *     first one is announced with the consequence in words, and the warning is
 *     never repeated once the run is already modified
 *   - a modified run stays non-comparable; an untouched one still compares
 *   - the stretch after arrival says what it is waiting for, and a failed
 *     baseline computation becomes a visible, recoverable state
 *   - an incident the world cannot run is disabled and explained using the same
 *     resolver a click would use (so the dock cannot drift from the behaviour)
 *   - nothing that throws a run away happens without an explicit acknowledgement
 *
 * The predicate tests use the same functions the components call; the incident
 * tests run the real resolver on the real world.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BASELINE_COMPUTING_TEXT,
  BASELINE_FAILED_TEXT,
  CLEAN_RUN_LOST_NOTICE,
  INCIDENT_WARNING_BODY,
  INCIDENT_WARNING_CANCEL,
  INCIDENT_WARNING_CONFIRM,
  INCIDENT_WARNING_TITLE,
  baselinePanelState,
  discardCopy,
  discardNeedsConfirm,
  firstCleanRunWarning,
  incidentAvailability,
  runShowsNonComparable,
  unavailableIncidentHint,
  type DiscardAction,
} from "@/components/ui-model";
import { loadBenchmarkModel } from "@/benchmark/model";
import { createAdaptiveController } from "@/controllers/adaptive";
import { INCIDENT_KINDS } from "@/sim/incidents";
import { generateDemand } from "@/sim/demand";
import { createEngine, stepEngine, type ScheduledSpawn } from "@/sim/engine";
import {
  incidentCapabilities,
  resolveManualChallengeIncident,
  type ManualChallengeIncidentInput,
} from "@/worker/challenge-incidents";
import { buildChallengeScenario, resolveScenarioWorld } from "@/worker/challenge-scenario";
import { comparisonVerdictAll, type ChallengeResult } from "@/worker/challenge-result";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";

const model = loadBenchmarkModel();
const TRIP_ID = "soldier-field-to-navy-pier" as const;
const SEED = 42;
const DURATION_MS = 600_000;

/** A live run in progress, with the ego on its route: the incident probe's world. */
function liveRun(): {
  input: Omit<ManualChallengeIncidentInput, "kind">;
  engine: ReturnType<typeof createEngine>;
} {
  const trafficLevel = "everyday" as const;
  const challenge = materializeChallengeTrip(model, TRIP_ID, SEED);
  const scenario = buildChallengeScenario({
    tripId: TRIP_ID,
    trafficLevel,
    driver: "tourist",
    seed: SEED,
    durationMs: DURATION_MS,
  });
  const world = resolveScenarioWorld(model, challenge.trip, scenario);
  const spawns: ScheduledSpawn[] = [
    challenge.spawn,
    ...generateDemand({ city: model.city, level: trafficLevel, seed: world.demandSeed, durationMs: DURATION_MS }),
  ];
  const engine = createEngine({
    city: model.city,
    controller: createAdaptiveController(),
    spawns,
    driver: "tourist",
    incidents: { seed: world.incidentPlan.incidentSeed, script: [...world.incidentPlan.entries] },
  });
  for (let i = 0; i < 200; i += 1) {
    stepEngine(engine);
  }
  const ego =
    engine.egoVehicleId === null
      ? null
      : engine.traffic.vehicles.find((vehicle) => vehicle.id === engine.egoVehicleId) ?? null;
  if (ego === null) {
    throw new Error("the fixture run has no ego");
  }
  return {
    engine,
    input: {
      model,
      city: engine.city,
      atMs: engine.traffic.timeMs,
      seed: world.incidentPlan.incidentSeed,
      sequence: 0,
      routeRoadIds: ego.route,
      routeIndex: ego.routeIndex,
      egoRoadId: ego.roadId,
      destinationIntersectionId: ego.destination,
    },
  };
}

/** A finished-result stub: only the fields the cleanliness verdict reads. */
function resultStub(
  controller: ChallengeResult["controller"],
  overrides: Partial<Pick<ChallengeResult, "manualIncidents" | "modified">> = {},
): ChallengeResult {
  return {
    fingerprint: "deadbeef",
    controller,
    driver: "tourist",
    simulatedMs: DURATION_MS,
    trip: {
      completed: true,
      tripTimeMs: 300_000,
      stoppedMs: 20_000,
      distanceM: 9_000,
      averageSpeedMps: 7,
      rerouteCount: 0,
    },
    city: {
      averageWaitMs: 20_000,
      p95WaitMs: 60_000,
      completedTrips: 500,
      throughputPerMinute: 50,
      gridlockRatio: 0.02,
      activeVehicles: 200,
    },
    manualIncidents: 0,
    modified: false,
    ...overrides,
  };
}

describe("a manual incident cannot silently kill the comparison", () => {
  it("warns before the first incident, in words that name the consequence", () => {
    expect(firstCleanRunWarning({ modified: false, manualIncidents: 0 })).toBe(true);
    // The copy has to say what is actually lost, not merely that something is.
    expect(INCIDENT_WARNING_TITLE.toLowerCase()).toContain("non-comparable");
    expect(INCIDENT_WARNING_BODY.toLowerCase()).toContain("comparison");
    expect(INCIDENT_WARNING_BODY.toLowerCase()).toContain("modified");
    expect(INCIDENT_WARNING_BODY.toLowerCase()).toContain("keeps running");
    expect(INCIDENT_WARNING_CONFIRM.length).toBeGreaterThan(0);
    expect(INCIDENT_WARNING_CANCEL.length).toBeGreaterThan(0);
    expect(CLEAN_RUN_LOST_NOTICE.toLowerCase()).toContain("comparison");
  });

  it("marks the run non-comparable for an incident too, not only for a live change", () => {
    // The chrome badge has to agree with the verdict, which refuses a run either
    // way — otherwise a hand-touched run looks clean while it plays.
    expect(runShowsNonComparable({ modified: false, manualIncidents: 0 })).toBe(false);
    expect(runShowsNonComparable({ modified: true, manualIncidents: 0 })).toBe(true);
    expect(runShowsNonComparable({ modified: false, manualIncidents: 1 })).toBe(true);
  });

  it("never asks again once the run is already modified", () => {
    // After a queued incident, or after a live setting change broke comparability.
    expect(firstCleanRunWarning({ modified: false, manualIncidents: 1 })).toBe(false);
    expect(firstCleanRunWarning({ modified: true, manualIncidents: 0 })).toBe(false);
    expect(firstCleanRunWarning({ modified: true, manualIncidents: 3 })).toBe(false);
  });

  it("keeps a hand-touched run non-comparable, and an untouched one comparable", () => {
    // The product's three runs: the visible Jev run plus both headless baselines.
    const untouched = comparisonVerdictAll([
      resultStub("fixed"),
      resultStub("adaptive"),
      resultStub("jev"),
    ]);
    expect(untouched.comparable).toBe(true);

    const withIncident = comparisonVerdictAll([
      resultStub("fixed"),
      resultStub("adaptive"),
      resultStub("jev", { manualIncidents: 1 }),
    ]);
    expect(withIncident.comparable).toBe(false);
    expect(withIncident.comparable ? "" : withIncident.reason).toContain("changed by hand");

    const withLiveChange = comparisonVerdictAll([
      resultStub("fixed"),
      resultStub("adaptive"),
      resultStub("jev", { modified: true }),
    ]);
    expect(withLiveChange.comparable).toBe(false);
    expect(withLiveChange.comparable ? "" : withLiveChange.reason).toContain("changed mid-run");
  });
});

describe("the wait after arrival says what it is waiting for", () => {
  it("is a visible computing state, never a vague one", () => {
    const state = baselinePanelState({
      runComplete: true,
      hasBaselines: false,
      running: true,
      failed: false,
    });
    expect(state).toBe("computing");
    expect(BASELINE_COMPUTING_TEXT).toContain("same-scenario baselines");
    // No invented progress: the copy promises a state, not a percentage.
    expect(BASELINE_COMPUTING_TEXT).not.toMatch(/\d+\s?%/);
  });

  it("does not claim to be computing before the run is over", () => {
    expect(
      baselinePanelState({ runComplete: false, hasBaselines: false, running: true, failed: false }),
    ).toBe("waiting");
  });

  it("hands over to the comparison when the baselines land", () => {
    expect(
      baselinePanelState({ runComplete: true, hasBaselines: true, running: false, failed: false }),
    ).toBe("comparison");
  });

  it("turns a baseline failure into an explicit, recoverable state", () => {
    const failed = baselinePanelState({
      runComplete: true,
      hasBaselines: false,
      running: false,
      failed: true,
    });
    expect(failed).toBe("failed");
    expect(BASELINE_FAILED_TEXT.toLowerCase()).toContain("could not be computed");
    // A run that finished with baselines missing and nothing running is a
    // failure, not an eternal wait.
    expect(
      baselinePanelState({ runComplete: true, hasBaselines: false, running: false, failed: false }),
    ).toBe("failed");
  });
});

describe("incident applicability comes from the world, not from hope", () => {
  it("offers everything while the world's answer is unknown", () => {
    for (const kind of INCIDENT_KINDS) {
      const availability = incidentAvailability(kind, null);
      expect(availability.applicable).toBe(true);
      expect(availability.reason).toBeNull();
    }
  });

  it("disables what the worker ruled out, and explains with the worker's words", () => {
    const availability = incidentAvailability("bridge-closed", [
      { kind: "bridge-closed", applicable: false, reason: "No safe route-relevant bridge" },
    ]);
    expect(availability.applicable).toBe(false);
    expect(unavailableIncidentHint(availability)).toBe("No safe route-relevant bridge");
  });

  it("agrees with the resolver a click would run — for every instrument", () => {
    const { input } = liveRun();
    const capabilities = incidentCapabilities(input);
    expect(capabilities.map((capability) => capability.kind)).toEqual([...INCIDENT_KINDS]);
    for (const capability of capabilities) {
      const resolution = resolveManualChallengeIncident({ ...input, kind: capability.kind });
      // The dock's answer IS the click's answer: no duplicated targeting logic.
      expect(capability.applicable).toBe(resolution.entry !== null);
      expect(capability.reason).toBe(resolution.entry === null ? resolution.label : null);
      if (capability.applicable) {
        // Byte-identical to what a click would queue.
        expect(resolution.entry).toEqual(
          resolveManualChallengeIncident({ ...input, kind: capability.kind }).entry,
        );
      }
    }
  });

  it("is deterministic: the same world asks the same question twice", () => {
    const { input } = liveRun();
    expect(incidentCapabilities(input)).toEqual(incidentCapabilities(input));
  });
});

describe("discarding a run is always an explicit choice", () => {
  it("asks when there is progress to lose", () => {
    expect(discardNeedsConfirm({ started: true, runComplete: false, hasResult: false })).toBe(true);
    expect(discardNeedsConfirm({ started: false, runComplete: true, hasResult: true })).toBe(true);
    expect(discardNeedsConfirm({ started: false, runComplete: false, hasResult: true })).toBe(true);
  });

  it("stays frictionless when nothing has happened yet", () => {
    expect(discardNeedsConfirm({ started: false, runComplete: false, hasResult: false })).toBe(false);
  });

  it("names the loss for every destructive action", () => {
    const actions: readonly DiscardAction[] = ["trip", "driver", "seed", "restart", "new-scenario"];
    for (const action of actions) {
      const copy = discardCopy(action);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.confirm.length).toBeGreaterThan(0);
      expect(copy.body.toLowerCase()).toMatch(/discard|discarded|rebuilds|drawn|played again/);
    }
  });
});

describe("the run's own account reaches the presentation frame", () => {
  it("carries governance through a JSON round trip", () => {
    const { engine } = liveRun();
    const governance = { modified: true, manualIncidents: 2 };
    const snapshot = buildPresentationSnapshot(engine, 0, TRIP_ID, null, governance);
    const parsed = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(parsed.governance).toEqual(governance);
    // An untouched run says so just as clearly, and is the default.
    expect(buildPresentationSnapshot(engine, 0, TRIP_ID).governance).toEqual({
      modified: false,
      manualIncidents: 0,
    });
  });
});

describe("stale wording stays gone", () => {
  it("never promises a new city where the geography is fixed", () => {
    const dir = path.join(process.cwd(), "components");
    const offenders = readdirSync(dir)
      .filter((name) => name.endsWith(".tsx") || name.endsWith(".ts"))
      .filter((name) => readFileSync(path.join(dir, name), "utf8").includes("New city"));
    expect(offenders).toEqual([]);
  });
});
