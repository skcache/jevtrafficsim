/**
 * Signal rendering grammar and zoom detail tiers.
 *
 * The product rejection list is explicit: no sea of green dots, no giant signal
 * dominating a road, no glyph in the middle of a junction, nothing on
 * expressways or roundabouts. These tests pin that grammar down.
 */
import { describe, expect, it } from "vitest";
import { buildSignalLayers, buildSignalPlans } from "@/render/deck-layers";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { metricToLngLat } from "@/cities/map-model";
import { CLOSE_TIER_MINZOOM, detailTier } from "@/render/zoom-grammar";
import type { PresentationSnapshot, PresentationSignal } from "@/worker/presentation-snapshot";
import { chicagoAsset, chicagoModel } from "./chicago-support";

function snapshotWithSignals(signals: PresentationSignal[]): PresentationSnapshot {
  return { sequence: 1, timeMs: 1000, vehicles: [], signals } as unknown as PresentationSnapshot;
}

describe("zoom detail grammar", () => {
  it("splits far, mid and close tiers at the documented zooms", () => {
    expect(detailTier(9)).toBe("far");
    expect(detailTier(11.8)).toBe("mid");
    expect(detailTier(14.6)).toBe("close");
    expect(detailTier(17)).toBe("close");
  });
});

describe("signal rendering", () => {
  const model = chicagoModel(2);
  const indexes = buildDirectedPathIndexes(model);
  const plans = buildSignalPlans(model);

  it("hides every signal glyph below street zoom", () => {
    const signals: PresentationSignal[] = [...plans.keys()]
      .slice(0, 12)
      .map((intersectionId) => ({ intersectionId, phaseIndex: 0, stage: "green" }));
    const snapshot = snapshotWithSignals(signals);
    for (const zoom of [9, 11, 12.5, 13.9, CLOSE_TIER_MINZOOM - 0.05]) {
      expect(buildSignalLayers(model.projection, model, snapshot, plans, indexes, zoom)).toEqual([]);
    }
    expect(
      buildSignalLayers(model.projection, model, snapshot, plans, indexes, 16).length,
    ).toBeGreaterThan(0);
  });

  it("returns nothing without a snapshot", () => {
    expect(buildSignalLayers(model.projection, model, null, plans, indexes, 16)).toEqual([]);
  });

  it("places heads on the approach, never in the middle of the junction", () => {
    // A signalized intersection with several approaches.
    const entry = [...plans.entries()].find(([, plan]) => plan.groupIncoming.length >= 2);
    expect(entry).toBeTruthy();
    const [intersectionId, plan] = entry!;
    const snapshot = snapshotWithSignals([{ intersectionId, phaseIndex: 0, stage: "green" }]);
    const layers = buildSignalLayers(model.projection, model, snapshot, plans, indexes, 17);
    // Heads are a housing sprite plus a lamp dot; the lamp layer carries the
    // per-approach positions.
    const headLayer = layers.find((layer) => layer.id === "signals-lamps");
    expect(headLayer).toBeTruthy();
    const heads = (headLayer as unknown as { props: { data: { position: [number, number] }[] } })
      .props.data;
    expect(heads.length).toBeGreaterThanOrEqual(2);
    // Every head sits off the junction centre: a signal head is a roadside
    // object, not a dot on the crossing.
    const junctionLngLat = metricToLngLat(model.projection, plan.x, plan.y);
    for (const head of heads) {
      const metres = Math.hypot(
        (head.position[0] - junctionLngLat[0]) * model.projection.metresPerDegreeLon,
        (head.position[1] - junctionLngLat[1]) * model.projection.metresPerDegreeLat,
      );
      // Off the crossing, but on this junction's own approach.
      expect(metres).toBeGreaterThan(2);
      expect(metres).toBeLessThan(40);
    }
    void plan;
  });

  it("never signals an uncontrolled junction or a roundabout ring", () => {
    const asset = chicagoAsset(2);
    const byId = new Map(asset.intersections.map((entry) => [entry.id, entry]));
    // Every signal the simulation drives belongs to a signal-controlled node.
    for (const intersectionId of plans.keys()) {
      expect(byId.get(intersectionId)?.control).toBe("signal");
    }
    // And no roundabout ring node is ever signalized in the imported data.
    for (const intersection of asset.intersections) {
      if (intersection.roundabout) {
        expect(intersection.control).not.toBe("signal");
      }
    }
  });

  it("keeps motorway nodes out of the signal plan", () => {
    const asset = chicagoAsset(2);
    const byId = new Map(asset.intersections.map((entry) => [entry.id, entry]));
    const classes = new Map<number, Set<string>>();
    for (const road of asset.roads) {
      for (const node of [road.from, road.to]) {
        const set = classes.get(node) ?? new Set<string>();
        set.add(road.osmClass);
        classes.set(node, set);
      }
    }
    for (const intersectionId of plans.keys()) {
      const nodeClasses = classes.get(intersectionId) ?? new Set<string>();
      const onlyMotorway = nodeClasses.size > 0 && [...nodeClasses].every((c) => c === "motorway");
      expect(onlyMotorway, `signal on a motorway node ${byId.get(intersectionId)?.osmid}`).toBe(
        false,
      );
    }
  });
});
