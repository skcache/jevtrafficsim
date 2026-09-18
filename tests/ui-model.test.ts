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
      citySize: "medium",
      trafficLevel: "everyday",
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
    store.setCitySize("large");
    store.setTrafficLevel("rush-hour");
    store.applyReady(
      { citySize: "large", trafficLevel: "rush-hour", controller: "adaptive", seed: 77, durationMs: 600_000 },
      "Metro",
    );
    const state = useUiStore.getState();
    expect(state.ready).toBe(true);
    expect(state.running).toBe(true);
    expect(state.seed).toBe(77);
    expect(state.scaleLabel).toBe("Metro");
    expect(state.citySize).toBe("large");
    expect(state.trafficLevel).toBe("rush-hour");
  });

  it("switching controller is a live change, not a reset", () => {
    const store = useUiStore.getState();
    store.applyReady(
      { citySize: "medium", trafficLevel: "everyday", controller: "adaptive", seed: 42, durationMs: 600_000 },
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
