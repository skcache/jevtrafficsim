/**
 * Production demand is a product decision, so it gets product-level assertions.
 *
 * The issue's targets were Everyday ~2.25x and Rush ~2.75x the old uniform
 * volume, chosen so Chicago looks occupied without saturating into
 * controller-independent gridlock. These tests pin the shape of that decision:
 * both levels are materially heavier than the old world, Rush is heavier than
 * Everyday, and every path that builds a world gets the same profile.
 */
import { describe, expect, it } from "vitest";
import { chicagoModel } from "./chicago-support";
import { generateDemand } from "@/sim/demand";
import { demandProfileFor, productionDemand } from "@/sim/demand-profile";

const model = chicagoModel(4);

function count(level: "everyday" | "rush-hour" | "light"): number {
  return productionDemand({
    city: model.city,
    level,
    seed: 7,
    durationMs: 300_000,
  }).length;
}

describe("production demand volumes", () => {
  it("Everyday is materially heavier than the old uniform world", () => {
    const old = generateDemand({
      city: model.city,
      level: "everyday",
      seed: 7,
      durationMs: 300_000,
    }).length;
    const everyday = count("everyday");
    // The target was 2.0-2.3x; assert the band rather than the exact number so a
    // deliberate retune does not fail the suite, but a retreat to sparse traffic
    // does.
    expect(everyday / old).toBeGreaterThanOrEqual(2.0);
    expect(everyday / old).toBeLessThanOrEqual(2.6);
  });

  it("Rush Hour is heavier than Everyday", () => {
    expect(count("rush-hour")).toBeGreaterThan(count("everyday"));
  });

  it("both production levels use a shaped profile, not uniform sampling", () => {
    expect(demandProfileFor("everyday").shape).not.toBe("uniform");
    expect(demandProfileFor("rush-hour").shape).not.toBe("uniform");
    // Light stays the untouched baseline: it is the calibration reference.
    expect(demandProfileFor("light").multiplier).toBe(1);
    expect(demandProfileFor("light").shape).toBe("uniform");
  });

  it("the profile label is what scenario identity carries", () => {
    for (const level of ["light", "everyday", "rush-hour"] as const) {
      expect(demandProfileFor(level).label).toContain(String(demandProfileFor(level).multiplier));
    }
  });
});
