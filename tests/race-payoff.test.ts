/**
 * The payoff is a race, not a dashboard — and a race is arithmetic.
 *
 * These tests pin the four things a visitor reads in the first two seconds: the
 * three trip times, the one delta sentence, and the fact that the delta is the
 * MEASURED difference rather than a manufactured verdict. A controller that lost
 * has to say so.
 */
import { describe, expect, it } from "vitest";
import { formatRaceTime, raceDelta, raceEntries } from "@/components/ui-model";

/** Only the two fields the race reads, so the test cannot drift into the rest. */
function trip(tripTimeMs: number, completed = true) {
  return { trip: { tripTimeMs, completed } } as never;
}

describe("race times are the unit a visitor reads", () => {
  it("formats m:ss, padding the seconds", () => {
    expect(formatRaceTime(399_000)).toBe("6:39");
    expect(formatRaceTime(412_000)).toBe("6:52");
    expect(formatRaceTime(432_000)).toBe("7:12");
    expect(formatRaceTime(65_000)).toBe("1:05");
    expect(formatRaceTime(9_000)).toBe("0:09");
  });
});

describe("race delta is measured, never manufactured", () => {
  it("reports the live run faster than Adaptive when it is", () => {
    // The issue's own example: Jev 6:39, Adaptive 6:52, Fixed 7:12.
    const rows = raceEntries(trip(432_000), trip(412_000), trip(399_000), "Jev");
    const delta = raceDelta(rows, "Jev");
    expect(delta?.deltaMs).toBe(13_000);
    expect(delta?.text).toBe("Jev finished 13s faster than Adaptive.");
    expect(delta?.comparedWith).toBe("Adaptive");
  });

  it("reports the live run slower when it lost", () => {
    const rows = raceEntries(trip(432_000), trip(399_000), trip(412_000), "Jev");
    const delta = raceDelta(rows, "Jev");
    expect(delta?.deltaMs).toBe(-13_000);
    expect(delta?.text).toBe("Jev finished 13s slower than Adaptive.");
  });

  it("says so plainly when they arrive within a second", () => {
    const rows = raceEntries(trip(430_000), trip(400_400), trip(400_000), "Jev");
    const delta = raceDelta(rows, "Jev");
    expect(delta?.text).toBe("Jev and Adaptive arrived within a second of each other.");
  });

  it("never invents a time for a run that did not finish", () => {
    const rows = raceEntries(trip(432_000), trip(412_000), trip(0, false), "Jev");
    const delta = raceDelta(rows, "Jev");
    expect(delta?.text).toBe("Jev did not finish the trip within the run.");
    expect(delta?.deltaMs).toBe(0);
  });

  it("keeps the three labels in race order and marks which one is live", () => {
    const rows = raceEntries(trip(432_000), trip(412_000), trip(399_000), "Jev");
    expect(rows.map((row) => row.key)).toEqual(["jev", "adaptive", "fixed"]);
    expect(rows.map((row) => row.label)).toEqual(["Jev", "Adaptive", "Fixed"]);
    expect(rows.filter((row) => row.live)).toHaveLength(1);
  });
});
