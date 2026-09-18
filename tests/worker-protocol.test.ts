import { describe, expect, it } from "vitest";
import {
  LIVE_RUN_HORIZON_MS,
  METRICS_EVERY_TICKS,
  nextSeed,
  parseWorkerCommand,
  SIM_TICK_MS,
  SNAPSHOT_EVERY_TICKS,
} from "@/worker/protocol";

describe("worker protocol validation", () => {
  it("accepts a well-formed INIT and applies defaults", () => {
    const command = parseWorkerCommand({
      type: "INIT",
      citySize: "medium",
      trafficLevel: "everyday",
      controller: "adaptive",
      seed: 42,
    });
    expect(command).toEqual({
      type: "INIT",
      citySize: "medium",
      trafficLevel: "everyday",
      controller: "adaptive",
      seed: 42,
      durationMs: undefined,
    });
    const withDuration = parseWorkerCommand({
      type: "INIT",
      citySize: "large",
      trafficLevel: "rush-hour",
      controller: "fixed",
      seed: 0xffffffff,
      durationMs: 120_000,
    });
    expect(withDuration.type === "INIT" && withDuration.durationMs).toBe(120_000);
  });

  it("rejects malformed INIT payloads", () => {
    const base = {
      type: "INIT",
      citySize: "medium",
      trafficLevel: "everyday",
      controller: "fixed",
      seed: 42,
    };
    expect(() => parseWorkerCommand(null)).toThrow(RangeError);
    expect(() => parseWorkerCommand([base])).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, citySize: "huge" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, trafficLevel: "apocalypse" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, controller: "jev" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: Number.NaN })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: -1 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: 1.5 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, seed: 2 ** 32 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: 0 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: -5 })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: Number.NaN })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ ...base, durationMs: 10 * 24 * 60 * 60 * 1000 })).toThrow(
      RangeError,
    );
  });

  it("accepts START / PAUSE and rejects unknown command types", () => {
    expect(parseWorkerCommand({ type: "START" })).toEqual({ type: "START" });
    expect(parseWorkerCommand({ type: "PAUSE" })).toEqual({ type: "PAUSE" });
    expect(() => parseWorkerCommand({ type: "STEP" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({})).toThrow(RangeError);
    expect(() => parseWorkerCommand("START")).toThrow(RangeError);
  });

  it("validates RESET modes", () => {
    expect(parseWorkerCommand({ type: "RESET", mode: "same-seed" })).toEqual({
      type: "RESET",
      mode: "same-seed",
    });
    expect(parseWorkerCommand({ type: "RESET", mode: "new-seed" })).toEqual({
      type: "RESET",
      mode: "new-seed",
    });
    expect(() => parseWorkerCommand({ type: "RESET", mode: "random" })).toThrow(RangeError);
    expect(() => parseWorkerCommand({ type: "RESET" })).toThrow(RangeError);
  });

  it("validates SET_CONTROLLER and never accepts Jev", () => {
    expect(parseWorkerCommand({ type: "SET_CONTROLLER", controller: "fixed" })).toEqual({
      type: "SET_CONTROLLER",
      controller: "fixed",
    });
    expect(parseWorkerCommand({ type: "SET_CONTROLLER", controller: "adaptive" })).toEqual({
      type: "SET_CONTROLLER",
      controller: "adaptive",
    });
    expect(() => parseWorkerCommand({ type: "SET_CONTROLLER", controller: "jev" })).toThrow(
      RangeError,
    );
    expect(() => parseWorkerCommand({ type: "SET_CONTROLLER" })).toThrow(RangeError);
  });

  it("accepts all five incident kinds and rejects anything else", () => {
    const kinds = ["traffic-burst", "crash", "close-road", "bridge-closed", "event-release"];
    for (const kind of kinds) {
      expect(parseWorkerCommand({ type: "INCIDENT", kind })).toEqual({ type: "INCIDENT", kind });
    }
    expect(() => parseWorkerCommand({ type: "INCIDENT", kind: "alien-invasion" })).toThrow(
      RangeError,
    );
    expect(() => parseWorkerCommand({ type: "INCIDENT" })).toThrow(RangeError);
  });

  it("keeps the centralized cadence constants consistent", () => {
    expect(SIM_TICK_MS).toBe(100);
    expect(SNAPSHOT_EVERY_TICKS).toBe(2); // 5 Hz
    expect(METRICS_EVERY_TICKS).toBe(5); // 2 Hz
    expect(LIVE_RUN_HORIZON_MS).toBe(600_000);
  });

  it("advances seeds in uint32 space deterministically", () => {
    expect(nextSeed(42)).toBe(43);
    expect(nextSeed(0)).toBe(1);
    expect(nextSeed(0xffffffff)).toBe(0);
  });
});
