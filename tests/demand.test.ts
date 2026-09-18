import { describe, expect, it } from "vitest";
import { TRAFFIC_LEVEL_TARGETS } from "@/sim/config";
import { generateCity } from "@/sim/city-generator";
import { generateDemand } from "@/sim/demand";
import type { CitySize, TrafficLevel } from "@/sim/types";

const SIZES: CitySize[] = ["small", "small-medium", "medium", "medium-large", "large"];
const LEVELS: TrafficLevel[] = ["light", "everyday", "rush-hour"];

describe("deterministic demand", () => {
  it("reproduces identical schedules for identical inputs", () => {
    const city = generateCity("medium", 42);
    const a = generateDemand({ city, level: "everyday", seed: 42, durationMs: 120_000 });
    const b = generateDemand({ city, level: "everyday", seed: 42, durationMs: 120_000 });
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].timeMs).toBe(0);
    for (let i = 0; i < a.length; i += 1) {
      const spawn = a[i];
      if (i > 0) {
        expect(spawn.timeMs).toBeGreaterThanOrEqual(a[i - 1].timeMs);
      }
      expect(spawn.origin).not.toBe(spawn.destination);
      expect(spawn.origin).toBeGreaterThanOrEqual(0);
      expect(spawn.destination).toBeLessThan(city.intersections.length);
    }
    // Dense rush demand at large sizes schedules SEVERAL vehicles per 100 ms
    // tick — exact interval multiples, snapped forward by the engine.
    const largeCity = generateCity("large", 42);
    const dense = generateDemand({ city: largeCity, level: "rush-hour", seed: 42, durationMs: 60_000 });
    expect(dense[1].timeMs - dense[0].timeMs).toBeLessThan(100);
  });

  it("scales demand with traffic level at equal city size", () => {
    const city = generateCity("small", 42);
    const schedules = LEVELS.map((level) =>
      generateDemand({ city, level, seed: 42, durationMs: 300_000 }),
    );
    const [light, everyday, rush] = schedules;
    expect(rush.length).toBeGreaterThan(everyday.length);
    expect(everyday.length).toBeGreaterThan(light.length);
    const interval = (schedule: Array<{ timeMs: number }>) =>
      schedule.length > 1 ? schedule[1].timeMs - schedule[0].timeMs : Number.POSITIVE_INFINITY;
    expect(interval(rush)).toBeLessThan(interval(everyday));
    expect(interval(everyday)).toBeLessThan(interval(light));
  });

  it("mixes car, truck and bicycle deterministically", () => {
    const city = generateCity("large", 42);
    const schedule = generateDemand({ city, level: "rush-hour", seed: 7, durationMs: 600_000 });
    expect(schedule.length).toBeGreaterThan(300);
    const counts = { car: 0, truck: 0, bicycle: 0 };
    for (const spawn of schedule) {
      counts[spawn.type] += 1;
    }
    const total = schedule.length;
    expect(counts.car / total).toBeGreaterThan(0.7);
    expect(counts.car / total).toBeLessThan(0.92);
    expect(counts.truck / total).toBeGreaterThan(0.05);
    expect(counts.bicycle).toBeGreaterThan(0);
    // Same schedule twice -> identical mix (already covered by deep-equality,
    // this pins the presence of all three classes).
    expect(counts.car + counts.truck + counts.bicycle).toBe(total);
  });

  it("keeps the PRD target table with level monotonicity", () => {
    expect(TRAFFIC_LEVEL_TARGETS.small.light).toEqual({ min: 20, max: 40 });
    expect(TRAFFIC_LEVEL_TARGETS["small-medium"]["rush-hour"]).toEqual({ min: 150, max: 230 });
    expect(TRAFFIC_LEVEL_TARGETS.medium.everyday).toEqual({ min: 200, max: 320 });
    expect(TRAFFIC_LEVEL_TARGETS["medium-large"].light).toEqual({ min: 250, max: 400 });
    expect(TRAFFIC_LEVEL_TARGETS.large["rush-hour"]).toEqual({ min: 1200, max: 2000 });
    for (const size of SIZES) {
      const targets = TRAFFIC_LEVEL_TARGETS[size];
      expect(targets.everyday.min).toBeGreaterThan(targets.light.min);
      expect(targets["rush-hour"].min).toBeGreaterThan(targets.everyday.min);
      expect(targets.everyday.min).toBeGreaterThanOrEqual(targets.light.max - 0);
      expect(targets["rush-hour"].min).toBeGreaterThanOrEqual(targets.everyday.max - 0);
      for (const level of LEVELS) {
        expect(targets[level].max).toBeGreaterThan(targets[level].min);
      }
    }
  });
});
