import { describe, expect, it } from "vitest";
import {
  SIMULATION_TICKS_PER_SECOND,
  SIMULATION_TIMESTEP_MS,
} from "@/sim/config";

describe("simulation timing constants", () => {
  it("fixes the world update at 10 Hz (100 ms timestep)", () => {
    expect(SIMULATION_TIMESTEP_MS).toBe(100);
    expect(SIMULATION_TICKS_PER_SECOND).toBe(10);
  });

  it("keeps the timestep an exact integer divisor of one second", () => {
    expect(1000 % SIMULATION_TIMESTEP_MS).toBe(0);
  });
});
