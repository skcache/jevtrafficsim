/**
 * Signal rendering grammar, zoom detail tiers, and the signal sprite contract.
 *
 * The product rejection list is explicit: no sea of coloured dots, no black
 * hedgehog cluster at every junction, nothing on expressways or roundabouts.
 * Signal STATE belongs at the stop line as a colored gate; the physical
 * three-lamp housing is progressive close-zoom detail. These tests pin that
 * grammar down, including deduplication of raw OSM approaches.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { buildSignalLayers, buildSignalPlans } from "@/render/deck-layers";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import { metricToLngLat } from "@/cities/map-model";
import { SIGNAL_HEAD_MINZOOM, SIGNAL_STATE_MINZOOM, detailTier } from "@/render/zoom-grammar";
import {
  createSignalSprites,
  signalIconSizeForHousingPx,
  signalSpriteForStage,
  SIGNAL_SPRITE_IDS,
  SIGNAL_SPRITE_LIT_LAMP,
  SIGNAL_SPRITE_PATHS,
  SIGNAL_SPRITE_UNITS,
  type SignalSpriteId,
  type SignalSpriteSet,
} from "@/render/signal-sprites";
import type { PresentationSnapshot, PresentationSignal } from "@/worker/presentation-snapshot";
import { chicagoAsset, chicagoModel } from "./chicago-support";

function snapshotWithSignals(signals: PresentationSignal[]): PresentationSnapshot {
  return { sequence: 1, timeMs: 1000, vehicles: [], signals } as unknown as PresentationSnapshot;
}

/** A sprite set without a DOM: the layer only needs an atlas and a mapping. */
function stubSprites(): SignalSpriteSet {
  const cell = { x: 0, y: 0, width: 10, height: 10, anchorX: 5, anchorY: 5, mask: false };
  return {
    atlas: "data:image/png;base64,",
    mapping: Object.fromEntries(SIGNAL_SPRITE_IDS.map((id) => [id, cell])) as Record<
      SignalSpriteId,
      typeof cell
    >,
  };
}

type HeadLayer = {
  props: {
    data: { position: [number, number]; sprite: SignalSpriteId }[];
    iconMapping: Record<string, unknown>;
    getIcon: (head: { sprite: SignalSpriteId }) => string;
    getSize: number;
    getAngle: number;
    billboard: boolean;
    opacity: number;
  };
};

describe("zoom detail grammar", () => {
  it("splits far, mid and close tiers at the documented zooms", () => {
    expect(detailTier(9)).toBe("far");
    expect(detailTier(11.8)).toBe("mid");
    expect(detailTier(14.6)).toBe("close");
    expect(detailTier(17)).toBe("close");
  });
});

describe("signal sprites", () => {
  it("ships exactly the three states, each lighting a different lamp", () => {
    expect([...SIGNAL_SPRITE_IDS]).toEqual(["signal-red", "signal-yellow", "signal-green"]);
    expect(SIGNAL_SPRITE_LIT_LAMP["signal-red"]).toBe(0);
    expect(SIGNAL_SPRITE_LIT_LAMP["signal-yellow"]).toBe(1);
    expect(SIGNAL_SPRITE_LIT_LAMP["signal-green"]).toBe(2);
    // Three lamp positions per state, plus the housing parts.
    for (const id of SIGNAL_SPRITE_IDS) {
      expect(SIGNAL_SPRITE_PATHS[id].length).toBeGreaterThanOrEqual(3 + 3);
    }
    // The states are genuinely different artwork, not one sprite recoloured.
    const red = JSON.stringify(SIGNAL_SPRITE_PATHS["signal-red"]);
    const yellow = JSON.stringify(SIGNAL_SPRITE_PATHS["signal-yellow"]);
    const green = JSON.stringify(SIGNAL_SPRITE_PATHS["signal-green"]);
    expect(red).not.toBe(yellow);
    expect(yellow).not.toBe(green);
  });

  it("maps the simulation's stages onto the three sprites", () => {
    expect(signalSpriteForStage("green", true)).toBe("signal-green");
    expect(signalSpriteForStage("yellow", true)).toBe("signal-yellow");
    expect(signalSpriteForStage("all-red", true)).toBe("signal-red");
    // An approach that does not hold the stage reads red, whatever the stage.
    for (const stage of ["green", "yellow", "all-red"] as const) {
      expect(signalSpriteForStage(stage, false)).toBe("signal-red");
    }
  });

  it("sizes the housing from the sprite's own proportions", () => {
    // The rendered housing height equals the requested pixel height.
    const size = signalIconSizeForHousingPx(11);
    expect(size).toBeGreaterThan(11);
    expect((size * SIGNAL_SPRITE_UNITS.height) / 128).toBeCloseTo(11, 6);
  });

  it("returns null without a DOM instead of inventing a fallback", () => {
    // Node environment: no document. The contract is "quietly unavailable",
    // and the layer hides the heads — never a coloured dot substitute.
    expect(createSignalSprites()).toBeNull();
  });
});

describe("signal rendering", () => {
  const model = chicagoModel(2);
  const indexes = buildDirectedPathIndexes(model);
  const plans = buildSignalPlans(model);
  const sprites = stubSprites();

  it("hides signal state until the camera is close enough to reason about an intersection", () => {
    const signals: PresentationSignal[] = [...plans.keys()]
      .slice(0, 12)
      .map((intersectionId) => ({ intersectionId, phaseIndex: 0, stage: "green" }));
    const snapshot = snapshotWithSignals(signals);
    for (const zoom of [9, 11, 12.5, 14.5, SIGNAL_STATE_MINZOOM - 0.05]) {
      expect(
        buildSignalLayers(model.projection, model, snapshot, plans, indexes, zoom, sprites),
      ).toEqual([]);
    }
    expect(
      buildSignalLayers(model.projection, model, snapshot, plans, indexes, 16, sprites).length,
    ).toBeGreaterThan(0);
  });

  it("returns nothing without a snapshot", () => {
    expect(
      buildSignalLayers(model.projection, model, null, plans, indexes, 16, sprites),
    ).toEqual([]);
  });

  it("never expands raw OSM roads into more visual signal arms", () => {
    for (const plan of [...plans.values()].slice(0, 40)) {
      plan.groupIncoming.forEach((roads, index) => {
        expect(plan.groupArms[index].length).toBeLessThanOrEqual(roads.length);
        expect(plan.groupArms[index].length).toBeGreaterThan(0);
      });
    }
  });

  it("uses colored state gates before physical housings appear", () => {
    const entry = [...plans.entries()].find(([, plan]) => plan.groupArms.length >= 2);
    expect(entry).toBeTruthy();
    const [intersectionId] = entry!;
    const snapshot = snapshotWithSignals([{ intersectionId, phaseIndex: 0, stage: "green" }]);
    const layers = buildSignalLayers(
      model.projection,
      model,
      snapshot,
      plans,
      indexes,
      SIGNAL_HEAD_MINZOOM - 0.05,
      sprites,
    );
    expect(layers.find((layer) => layer.id === "signals-state-gates")).toBeTruthy();
    expect(layers.find((layer) => layer.id === "signals-heads")).toBeUndefined();
  });

  it("draws heads from the signal atlas and never from a vehicle icon", () => {
    const entry = [...plans.entries()].find(([, plan]) => plan.groupIncoming.length >= 2);
    expect(entry).toBeTruthy();
    const [intersectionId] = entry!;
    const snapshot = snapshotWithSignals([{ intersectionId, phaseIndex: 0, stage: "green" }]);
    const layers = buildSignalLayers(model.projection, model, snapshot, plans, indexes, 17, sprites);

    const headLayer = layers.find((layer) => layer.id === "signals-heads") as unknown as HeadLayer;
    expect(headLayer).toBeTruthy();
    // The layer is driven by the signal mapping, and every icon it can ask for
    // is a signal sprite. "car" — the old placeholder — must not appear.
    for (const id of SIGNAL_SPRITE_IDS) {
      expect(Object.keys(headLayer.props.iconMapping)).toContain(id);
    }
    expect(Object.keys(headLayer.props.iconMapping)).not.toContain("car");
    for (const head of headLayer.props.data) {
      expect(SIGNAL_SPRITE_IDS).toContain(headLayer.props.getIcon(head));
      expect(SIGNAL_SPRITE_IDS).toContain(head.sprite);
    }
    // The physical traffic-light annotation stays screen-aligned. Direction is
    // carried by the colored gate across the approach, not by rotating the icon.
    expect(headLayer.props.getAngle).toBe(0);
    expect(headLayer.props.billboard).toBe(true);
    // No coloured-dot layers survive anywhere in the signal stack.
    for (const layer of layers) {
      expect(["signals-lamps", "signals-lamps-idle", "signals-housings"]).not.toContain(layer.id);
    }
  });

  it("hides the heads when the atlas is missing, rather than drawing dots", () => {
    const entry = [...plans.entries()].find(([, plan]) => plan.groupIncoming.length >= 2);
    const [intersectionId] = entry!;
    const snapshot = snapshotWithSignals([{ intersectionId, phaseIndex: 0, stage: "green" }]);
    const layers = buildSignalLayers(model.projection, model, snapshot, plans, indexes, 17, null);
    expect(layers.find((layer) => layer.id === "signals-heads")).toBeUndefined();
    expect(layers.find((layer) => layer.id === "signals-lamps")).toBeUndefined();
    // The colored state gates are the primary signal channel and still render.
    expect(layers.find((layer) => layer.id === "signals-state-gates")).toBeTruthy();
  });

  it("places heads on the approach, never in the middle of the junction", () => {
    const entry = [...plans.entries()].find(([, plan]) => plan.groupIncoming.length >= 2);
    expect(entry).toBeTruthy();
    const [intersectionId, plan] = entry!;
    const snapshot = snapshotWithSignals([{ intersectionId, phaseIndex: 0, stage: "green" }]);
    const layers = buildSignalLayers(model.projection, model, snapshot, plans, indexes, 17, sprites);
    const headLayer = layers.find((layer) => layer.id === "signals-heads") as unknown as HeadLayer;
    const heads = headLayer.props.data;
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

describe("production wiring", () => {
  /**
   * The bug this guards: the map created a signal atlas but never passed it to
   * the layer builder, so the sprite path was dead and production fell back to
   * coloured dots. Types and layer tests cannot catch that — only the call site
   * can — so this reads the component that assembles the frame.
   */
  const source = readFileSync(new URL("../components/CityMap.tsx", import.meta.url), "utf8");

  it("builds the signal atlas once and hands it to the signal layers", () => {
    expect(source).toContain("createSignalSprites");
    expect(source).toMatch(/signalSpritesRef\.current\s*=\s*createSignalSprites\(\)/);
    // The call passes the atlas as an argument. (A lazy match to the first ")"
    // stops inside `new Map()`, so bound the window instead.)
    expect(source).toMatch(/buildSignalLayers\([\s\S]{0,600}?signalSpritesRef\.current/);
  });

  it("no longer references the placeholder housing", () => {
    expect(source).not.toContain("createSignalHousing");
  });
});
