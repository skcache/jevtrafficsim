/**
 * Presentation-logic tests: the vehicle sizing language, the signal tier fade,
 * incident hatching and the sparkline are pure functions — pinned here so the
 * map cannot quietly regress into unreadable chips or hard zoom cuts.
 *
 * The Phase-2 ring/halo, signal-axis-bar and event-egress-arrow helpers were
 * deleted with the layers that drew them, and their tests went with them: a
 * test that preserves visual behaviour the product intentionally removed is
 * not coverage, it is a trap for the next person.
 */
import { describe, expect, it } from "vitest";
import {
  hatchSegments,
  signalTier,
  signalTierOpacity,
  sparklineLastPoint,
  sparklinePath,
  VEHICLE_BASE_LENGTHS,
  vehicleLengthPx,
  vehicleSizeScale,
} from "@/render/visuals";
import { waitHeatBucket, WAIT_HEAT_COLORS } from "@/render/map-geometry";

describe("vehicle sizing", () => {
  it("keeps vehicle classes legible once the camera enters simulation detail", () => {
    expect(vehicleSizeScale(14.4)).toBeCloseTo(0.72, 5);
    expect(vehicleSizeScale(16)).toBeCloseTo(1, 5);
    expect(vehicleSizeScale(18.2)).toBeCloseTo(1.12, 5);
    expect(vehicleSizeScale(21)).toBeCloseTo(1.12, 5);
    const car = vehicleLengthPx("car", 19.5);
    const truck = vehicleLengthPx("truck", 19.5);
    const bicycle = vehicleLengthPx("bicycle", 19.5);
    expect(car).toBeGreaterThanOrEqual(15);
    expect(car).toBeLessThanOrEqual(16);
    expect(truck).toBeGreaterThanOrEqual(23);
    expect(truck).toBeLessThanOrEqual(24);
    expect(bicycle).toBeGreaterThanOrEqual(10);
    expect(bicycle).toBeLessThanOrEqual(11);
  });

  it("never shrinks as zoom increases", () => {
    let previous = vehicleSizeScale(12);
    for (let zoom = 12; zoom <= 19.5; zoom += 0.1) {
      const current = vehicleSizeScale(zoom);
      expect(current).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = current;
    }
  });

  it("keeps class lengths ordered car < truck and clearly separated", () => {
    expect(VEHICLE_BASE_LENGTHS.truck).toBeGreaterThan(VEHICLE_BASE_LENGTHS.car);
    expect(VEHICLE_BASE_LENGTHS.car).toBeGreaterThan(VEHICLE_BASE_LENGTHS.bicycle);
    expect(vehicleLengthPx("car", 14.4)).toBeCloseTo(10.08, 2);
    expect(vehicleLengthPx("car", 16)).toBe(14);
    expect(vehicleLengthPx("truck", 16)).toBe(21);
    expect(vehicleLengthPx("bicycle", 16)).toBe(9);
  });
});

describe("wait heat", () => {
  it("follows the frozen thresholds: 0-5 / 5-15 / 15-30 / 30-60 / 60+", () => {
    expect(waitHeatBucket(4_999)).toBe(0);
    expect(waitHeatBucket(5_000)).toBe(1);
    expect(waitHeatBucket(15_000)).toBe(2);
    expect(waitHeatBucket(30_000)).toBe(3);
    expect(waitHeatBucket(60_000)).toBe(4);
  });

  it("keeps bucket 1 distinct from the highway gold", () => {
    const [r, g, b] = WAIT_HEAT_COLORS[1];
    const highway = [0xf8, 0xce, 0x8b];
    const distance = Math.hypot(r - highway[0], g - highway[1], b - highway[2]);
    expect(distance).toBeGreaterThan(60);
  });
});

describe("signal tiers", () => {
  it("stays absent at map zoom, then fades state in before physical housings", () => {
    expect(signalTier(15.7)).toBe("hidden");
    expect(signalTier(15.8)).toBe("mid");
    expect(signalTier(17)).toBe("close");
    expect(signalTierOpacity(15.7)).toBe(0);
    expect(signalTierOpacity(15.8)).toBe(0);
    expect(signalTierOpacity(16.2)).toBeCloseTo(1, 5);
  });
});

describe("incident geometry", () => {
  it("hatches a closed road into alternating dashes", () => {
    const straight = Array.from({ length: 21 }, (_, index) => [index * 5, 0] as [number, number]);
    const segments = hatchSegments(straight, 4, 5);
    expect(segments.length).toBeGreaterThan(3);
    for (const segment of segments) {
      expect(segment.length).toBeGreaterThanOrEqual(2);
      const length = segment.reduce(
        (total, point, index) =>
          index === 0
            ? 0
            : total + Math.hypot(point[0] - segment[index - 1][0], point[1] - segment[index - 1][1]),
        0,
      );
      expect(length).toBeLessThanOrEqual(4.0001);
    }
    // Consecutive dashes leave a gap (the hatch never becomes a solid band).
    const firstEnd = segments[0][segments[0].length - 1][0];
    const secondStart = segments[1][0][0];
    expect(secondStart - firstEnd).toBeGreaterThan(1);
  });

  it("returns no hatch for degenerate paths", () => {
    expect(hatchSegments([])).toEqual([]);
    expect(hatchSegments([[0, 0]])).toEqual([]);
    expect(hatchSegments([[0, 0], [0, 0]])).toEqual([]);
  });
});

describe("sparkline", () => {
  it("is empty for no samples and flat for one", () => {
    expect(sparklinePath([], 100, 20)).toBe("");
    expect(sparklinePath([5], 100, 20)).toBe("M0.0 0.0");
  });

  it("normalises to the series max and spans the full width", () => {
    const path = sparklinePath([0, 5, 10], 100, 20);
    expect(path).toBe("M0.0 20.0 L50.0 10.0 L100.0 0.0");
  });

  it("marks the newest sample", () => {
    const point = sparklineLastPoint([0, 10], 100, 20);
    expect(point).toEqual({ x: 100, y: 0 });
    expect(sparklineLastPoint([], 100, 20)).toBeNull();
  });
});
