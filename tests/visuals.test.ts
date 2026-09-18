/**
 * Presentation-logic tests (Task 11 polish pass): the vehicle language, signal
 * tiers, incident geometry and sparkline are pure functions — pinned here so
 * the map cannot quietly regress into unreadable chips or hard zoom cuts.
 */
import { describe, expect, it } from "vitest";
import {
  egressArrows,
  ringScaleForZoom,
  vehicleHaloColor,
  vehicleHaloExtraPx,
  vehicleRingExtraPx,
  groupByHeatBucket,
  hatchSegments,
  signalAxisReachMetres,
  signalTier,
  signalTierOpacity,
  sparklineLastPoint,
  sparklinePath,
  stopBarGeometry,
  VEHICLE_BASE_LENGTHS,
  VEHICLE_BODY_COLORS,
  VEHICLE_OUTLINE_COLOR,
  vehicleLengthPx,
  vehicleSizeScale,
} from "@/render/visuals";
import { waitHeatBucket, WAIT_HEAT_COLORS } from "@/render/map-geometry";

describe("vehicle sizing", () => {
  it("uses three bands: chip at city zoom, full size mid, larger at street zoom", () => {
    expect(vehicleSizeScale(13)).toBeCloseTo(0.58, 5);
    expect(vehicleSizeScale(15.2)).toBeCloseTo(0.58, 5);
    expect(vehicleSizeScale(16.2)).toBeCloseTo(1, 5);
    expect(vehicleSizeScale(19.5)).toBeCloseTo(1.32, 5);
    expect(vehicleSizeScale(21)).toBeCloseTo(1.32, 5);
  });

  it("never shrinks as zoom increases", () => {
    let previous = vehicleSizeScale(12);
    for (let zoom = 12; zoom <= 19.5; zoom += 0.1) {
      const current = vehicleSizeScale(zoom);
      expect(current).toBeGreaterThanOrEqual(previous - 1e-9);
      previous = current;
    }
  });

  it("keeps class lengths ordered car < truck and readable at city zoom", () => {
    expect(VEHICLE_BASE_LENGTHS.truck).toBeGreaterThan(VEHICLE_BASE_LENGTHS.car);
    expect(VEHICLE_BASE_LENGTHS.car).toBeGreaterThan(VEHICLE_BASE_LENGTHS.bicycle);
    // A chip, not sub-pixel noise: 7 px car at whole-city zoom.
    expect(vehicleLengthPx("car", 14)).toBeCloseTo(6.96, 2);
    expect(vehicleLengthPx("car", 16.2)).toBe(12);
    expect(vehicleLengthPx("truck", 16.2)).toBe(18);
    expect(vehicleLengthPx("bicycle", 16.2)).toBe(8);
  });

  it("thickens the ring and adds a halo as a vehicle waits", () => {
    // The ring is the queue channel: it must grow monotonically with heat.
    expect(vehicleRingExtraPx(0)).toBeLessThan(vehicleRingExtraPx(1));
    expect(vehicleRingExtraPx(1)).toBeLessThan(vehicleRingExtraPx(3));
    // Whole-city zoom keeps the ring proportionate to the smaller chip.
    expect(ringScaleForZoom(14)).toBeLessThan(ringScaleForZoom(17));
    expect(ringScaleForZoom(17)).toBe(1);
    // Only genuinely stuck vehicles (30 s+) bloom.
    expect(vehicleHaloExtraPx(0)).toBe(0);
    expect(vehicleHaloExtraPx(2)).toBe(0);
    expect(vehicleHaloExtraPx(3)).toBeGreaterThan(0);
    expect(vehicleHaloExtraPx(4)).toBeGreaterThan(0);
    const halo = vehicleHaloColor(4);
    expect(halo[3]).toBeGreaterThan(0);
    expect(halo[3]).toBeLessThan(200);
  });

  it("gives every class a light body and a dark outline", () => {
    for (const type of ["car", "truck", "bicycle"] as const) {
      const [r, g, b] = VEHICLE_BODY_COLORS[type];
      // Light chips: the outline carries the contrast against pale roads.
      expect(Math.min(r, g, b)).toBeGreaterThan(200);
    }
    expect(VEHICLE_OUTLINE_COLOR[3]).toBeGreaterThan(100);
  });
});

describe("vehicle heat buckets", () => {
  const vehicle = (blockedWaitMs: number) => ({ id: blockedWaitMs, blockedWaitMs });

  it("splits vehicles into five buckets in heat order", () => {
    const groups = groupByHeatBucket([
      vehicle(0),
      vehicle(6_000),
      vehicle(20_000),
      vehicle(45_000),
      vehicle(90_000),
    ]);
    expect(groups).toHaveLength(5);
    expect(groups.map((group) => group.length)).toEqual([1, 1, 1, 1, 1]);
    // Buckets follow the frozen thresholds: 0-5 / 5-15 / 15-30 / 30-60 / 60+.
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

  it("preserves every vehicle and never reorders within a bucket", () => {
    const input = [vehicle(0), vehicle(1_000), vehicle(7_000), vehicle(2_000)];
    const groups = groupByHeatBucket(input);
    const flat = groups.flat();
    expect(flat).toHaveLength(input.length);
    expect(groups[0].map((entry) => entry.id)).toEqual([0, 1_000, 2_000]);
    expect(groups[1].map((entry) => entry.id)).toEqual([7_000]);
  });
});

describe("signal tiers", () => {
  it("fades in with zoom instead of cutting hard", () => {
    expect(signalTier(12.9)).toBe("hidden");
    expect(signalTier(13.0)).toBe("far");
    expect(signalTier(14.6)).toBe("mid");
    expect(signalTier(16.4)).toBe("close");
    expect(signalTierOpacity(12.9)).toBe(0);
    expect(signalTierOpacity(13.0)).toBe(0);
    expect(signalTierOpacity(13.6)).toBeCloseTo(1, 5);
    expect(signalTierOpacity(15.2)).toBeCloseTo(1, 5);
  });

  it("shortens the active-axis bar at street zoom", () => {
    expect(signalAxisReachMetres("mid")).toBe(40);
    expect(signalAxisReachMetres("close")).toBe(26);
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

  it("places the stop bar across the approach, behind the intersection", () => {
    const center: [number, number] = [100, 100];
    // Approach heading east (bearing 0) => the bar is north-south, west of center.
    const geometry = stopBarGeometry(center, 0, 3.5);
    const [[ax, ay], [bx, by]] = geometry.bar;
    expect(ax).toBeCloseTo(bx, 5);
    expect(ax).toBeLessThan(center[0]);
    expect(Math.abs(ay - by)).toBeCloseTo(7, 5);
    expect(geometry.crosswalk).toHaveLength(3);
    // Crosswalk ticks sit further back than the bar.
    for (const [start] of geometry.crosswalk) {
      expect(start[0]).toBeLessThan(ax);
    }
  });

  it("spreads event egress arrows along the outgoing roads", () => {
    const arrows = egressArrows([0, 0], [0, Math.PI / 2], 16, 40);
    expect(arrows).toHaveLength(2);
    expect(arrows[0].source[0]).toBeCloseTo(16, 5);
    expect(arrows[0].target[0]).toBeCloseTo(40, 5);
    expect(arrows[1].source[1]).toBeCloseTo(16, 5);
    expect(arrows[1].target[1]).toBeCloseTo(40, 5);
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
