import { describe, expect, it, beforeEach } from "vitest";
import {
  CITY_SIZE_OPTIONS,
  citySizeLabel,
  formatDuration,
  formatPercent,
  formatThroughput,
  normalizeSeed,
  scaleIndexForSize,
  seedFromRandom,
  sizeForScaleIndex,
  trafficLabel,
} from "@/components/ui-model";
import { useUiStore } from "@/store/ui-store";
import { comparisonRows } from "@/components/ui-model";
import type { ChallengeResult } from "@/worker/challenge-result";

describe("UI model", () => {
  it("labels the five nested scales Tiny..Metro", () => {
    expect(CITY_SIZE_OPTIONS.map((option) => option.label)).toEqual([
      "Tiny",
      "Small",
      "Medium",
      "Large",
      "Metro",
    ]);
    expect(citySizeLabel("small")).toBe("Tiny");
    expect(citySizeLabel("large")).toBe("Metro");
    expect(citySizeLabel("medium")).toBe("Medium");
    expect(trafficLabel("rush-hour")).toBe("Rush Hour");
  });

  it("maps scale indices both ways", () => {
    for (let index = 0; index < 5; index += 1) {
      const size = sizeForScaleIndex(index);
      expect(scaleIndexForSize(size)).toBe(index);
    }
    expect(scaleIndexForSize("small")).toBe(0);
    expect(scaleIndexForSize("large")).toBe(4);
    expect(sizeForScaleIndex(-3)).toBe("small");
    expect(sizeForScaleIndex(9)).toBe("large");
  });

  it("normalizes messy seed input to a uint32", () => {
    expect(normalizeSeed("42", 7)).toBe(42);
    expect(normalizeSeed("  43  ", 7)).toBe(43);
    expect(normalizeSeed("", 7)).toBe(7);
    expect(normalizeSeed("abc", 7)).toBe(7);
    expect(normalizeSeed("-5", 7)).toBe(7);
    expect(normalizeSeed("1.5", 7)).toBe(7);
    expect(normalizeSeed("0", 7)).toBe(0);
    expect(normalizeSeed("4294967295", 7)).toBe(0xffffffff);
    expect(normalizeSeed("4294967296", 7)).toBe(0);
  });

  it("turns any random source into a uint32 dice roll", () => {
    expect(seedFromRandom(() => 0)).toBe(0);
    expect(seedFromRandom(() => 0.5)).toBe(0x80000000);
    expect(seedFromRandom(() => 0.999999)).toBeLessThan(0x100000000);
    expect(seedFromRandom(() => 1)).toBe(0);
    expect(seedFromRandom(() => Number.NaN)).toBe(0);
  });

  it("formats metrics for humans", () => {
    expect(formatDuration(27_400)).toBe("27.4s");
    expect(formatDuration(68_000)).toBe("1m 08s");
    expect(formatDuration(125_000)).toBe("2m 05s");
    expect(formatDuration(-1)).toBe("—");
    expect(formatThroughput(43.2)).toBe("43/min");
    expect(formatPercent(0.18)).toBe("18%");
    expect(formatPercent(Number.NaN)).toBe("—");
  });
});

describe("UI store phases", () => {
  beforeEach(() => {
    useUiStore.setState({
      phase: "landing",
      trafficLevel: "everyday",
      tripId: "soldier-field-to-navy-pier",
      controller: "adaptive",
      seed: 42,
      ready: false,
      running: false,
      runComplete: false,
      error: null,
      metrics: null,
      config: null,
      scaleLabel: "Medium",
      scenarioOpen: false,
    });
  });

  it("selects a curated trip without retaining dead city-size state", () => {
    const store = useUiStore.getState();
    store.setTripId("streeterville-to-south-loop");
    expect(useUiStore.getState().tripId).toBe("streeterville-to-south-loop");
    expect("citySize" in useUiStore.getState()).toBe(false);
  });

  it("walks landing -> config -> entering -> city", () => {
    const store = useUiStore.getState();
    expect(store.phase).toBe("landing");
    store.setPhase("config");
    expect(useUiStore.getState().phase).toBe("config");
    store.setPhase("entering");
    expect(useUiStore.getState().phase).toBe("entering");
    store.setPhase("city");
    expect(useUiStore.getState().phase).toBe("city");
  });

  it("applies READY state without resetting selections", () => {
    const store = useUiStore.getState();
    store.setTrafficLevel("rush-hour");
    store.applyReady(
      { citySize: "large", trafficLevel: "rush-hour", tripId: "willis-tower-to-near-west-side", controller: "adaptive", driver: "tourist", seed: 77, durationMs: 600_000 },
      "Metro",
    );
    const state = useUiStore.getState();
    expect(state.ready).toBe(true);
    expect(state.running).toBe(true);
    expect(state.seed).toBe(77);
    expect(state.scaleLabel).toBe("Metro");
    expect(state.trafficLevel).toBe("rush-hour");
    expect(state.tripId).toBe("willis-tower-to-near-west-side");
  });

  it("switching controller is a live change, not a reset", () => {
    const store = useUiStore.getState();
    store.applyReady(
      { citySize: "large", trafficLevel: "everyday", tripId: "soldier-field-to-navy-pier", controller: "adaptive", driver: "tourist", seed: 42, durationMs: 600_000 },
      "Medium",
    );
    store.setRunComplete(true);
    store.setController("fixed");
    const state = useUiStore.getState();
    expect(state.controller).toBe("fixed");
    // A controller switch must not clear the run identity or completion state.
    expect(state.seed).toBe(42);
    expect(state.runComplete).toBe(true);
    expect(state.config?.controller).toBe("adaptive"); // config only changes on READY
  });

  it("records errors without touching the run", () => {
    const store = useUiStore.getState();
    store.setError("boom");
    expect(useUiStore.getState().error).toBe("boom");
    store.setError(null);
    expect(useUiStore.getState().error).toBeNull();
  });
});

describe("comparison panel (Issue #28, three columns since #15)", () => {
  const result = (
    completed: boolean,
    overrides: Partial<ChallengeResult["trip"]> = {},
    city: Partial<ChallengeResult["city"]> = {},
  ): ChallengeResult => ({
    fingerprint: "abc12345",
    controller: "fixed",
    driver: "tourist",
    manualIncidents: 0,
    modified: false,
    simulatedMs: 600_000,
    trip: {
      completed,
      tripTimeMs: 600_000,
      stoppedMs: 251_000,
      distanceM: 8_400,
      averageSpeedMps: 14,
      rerouteCount: 2,
      ...overrides,
    },
    city: {
      averageWaitMs: 90_000,
      p95WaitMs: 261_000,
      completedTrips: 1_084,
      throughputPerMinute: 108.4,
      gridlockRatio: 0.36,
      activeVehicles: 900,
      ...city,
    },
  });

  it("formats all three runs into the same rows", () => {
    const rows = comparisonRows(
      result(true),
      result(true, { stoppedMs: 98_000 }, { gridlockRatio: 0.16 }),
      result(true, { stoppedMs: 130_000, averageSpeedMps: 9 }, { averageWaitMs: 84_000 }),
    );
    const byLabel = new Map(rows.map((row) => [row.label, row]));
    expect(byLabel.get("Stopped")?.fixed).toBe("4m 11s");
    expect(byLabel.get("Stopped")?.adaptive).toBe("1m 38s");
    expect(byLabel.get("Stopped")?.jev).toBe("2m 10s");
    expect(byLabel.get("Trips done")?.fixed).toBe("1,084");
    expect(byLabel.get("Queued time")?.adaptive).toBe("16%");
    expect(byLabel.get("Reroutes")?.fixed).toBe("2");
    // Every row is a field of a real run, so no column is ever blank.
    for (const row of rows) {
      expect(row.jev, row.label).not.toBe("");
      expect(row.fixed, row.label).not.toBe("");
      expect(row.adaptive, row.label).not.toBe("");
    }
  });

  it("reports no trip time for a run that never arrived, per column", () => {
    const rows = comparisonRows(result(false), result(true), result(false));
    const tripTime = rows.find((row) => row.label === "Trip time");
    expect(tripTime?.fixed).toBe("—");
    expect(tripTime?.adaptive).toBe("10m 00s");
    expect(tripTime?.jev).toBe("—");
    const arrived = rows.find((row) => row.label === "Arrived");
    expect(arrived?.fixed).toBe("No");
    expect(arrived?.adaptive).toBe("Yes");
    expect(arrived?.jev).toBe("No");
  });
});
