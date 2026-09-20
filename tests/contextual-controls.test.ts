/**
 * Issue #26 — contextual road controls.
 *
 * Only the controls the ego is about to meet get pixels, revealed by distance
 * AHEAD ALONG THE ROUTE (never a straight-line radius), and the traffic light
 * answers the ego's own question: "can my car go?" — using the engine's exact
 * approach-group rule.
 */
import { describe, expect, it } from "vitest";
import type { City, Intersection, Road } from "@/sim/types";
import type { MapModel } from "@/cities/map-model";
import { buildPathIndex, type Point } from "@/cities/paths";
import {
  canApproachProceed,
  canApproachProceedForPhase,
  createSignalState,
  deriveApproachGroups,
  stepSignal,
} from "@/sim/signals";
import { createEngine, runEngine, setEngineController } from "@/sim/engine";
import { createFixedController } from "@/controllers/fixed";
import { createAdaptiveController } from "@/controllers/adaptive";
import { buildPresentationSnapshot } from "@/worker/presentation-snapshot";
import { materializeChallengeTrip } from "@/worker/ego-spawn";
import {
  CONTROL_REVEAL,
  deriveContextualControls,
  upcomingControl,
  type ContextualControl,
} from "@/render/contextual-controls";
import { buildControlLayers, controlPixelBounds, controlSpriteFor } from "@/render/control-layers";
import { CONTROL_SPRITE_IDS, createControlSprites } from "@/render/control-sprites";
import { CONTROL_SCALE } from "@/render/scale";
import { chicagoModel } from "./chicago-support";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function road(id: number, from: number, to: number, length: number): Road {
  return { id, from, to, length, lanes: 2, speedLimit: 10, capacity: 20, kind: "arterial", closed: false };
}

function intersection(
  id: number,
  x: number,
  y: number,
  incoming: number[],
  outgoing: number[],
  control: Intersection["control"],
): Intersection {
  return { id, x, y, incoming, outgoing, control, regionId: 0 };
}

/**
 * Straight chain: road i runs node i -> i+1 along +x, each `lengths[i]` long.
 * `controls` sets the control at the node a road ENDS on.
 */
function chainModel(
  lengths: number[],
  controls: Record<number, "signal" | "stop"> = {},
): MapModel {
  const nodes = lengths.length + 1;
  const xs: number[] = [0];
  for (const length of lengths) {
    xs.push(xs[xs.length - 1] + length);
  }
  const roads: Road[] = lengths.map((length, index) => road(index, index, index + 1, length));
  const intersections: Intersection[] = Array.from({ length: nodes }, (_, id) =>
    intersection(
      id,
      xs[id],
      0,
      id === 0 ? [] : [id - 1],
      id === nodes - 1 ? [] : [id],
      controls[id] ?? "uncontrolled",
    ),
  );
  const city: City = {
    size: "medium",
    seed: 0,
    gridWidth: 0,
    gridHeight: 0,
    corridors: [],
    intersections,
    roads,
  };
  const directedPaths = lengths.map(
    (_, index) => [[xs[index], 0], [xs[index + 1], 0]] as Point[],
  );
  return {
    scaleIndex: 2,
    size: "medium",
    city,
    streets: [],
    directedPaths,
    projection: { originLng: 0, originLat: 0, metresPerDegree: 111_320 },
  } as unknown as MapModel;
}

/** A cross: two approaches into the centre node, so the signal has two groups. */
function crossModel(): { model: MapModel; horizontal: number; vertical: number; center: number } {
  const roads = [road(0, 0, 2, 120), road(1, 3, 2, 120)];
  const intersections: Intersection[] = [
    intersection(0, 0, 0, [], [0], "uncontrolled"),
    intersection(1, 0, -120, [], [], "uncontrolled"),
    intersection(2, 120, 0, [0, 1], [], "signal"),
    intersection(3, 120, -120, [], [1], "uncontrolled"),
  ];
  const city: City = {
    size: "medium",
    seed: 0,
    gridWidth: 0,
    gridHeight: 0,
    corridors: [],
    intersections,
    roads,
  };
  const directedPaths: Point[][] = [
    [[0, 0], [120, 0]],
    [[120, -120], [120, 0]],
  ];
  return {
    model: {
      scaleIndex: 2,
      size: "medium",
      city,
      streets: [],
      directedPaths,
      projection: { originLng: 0, originLat: 0, metresPerDegree: 111_320 },
    } as unknown as MapModel,
    horizontal: 0,
    vertical: 1,
    center: 2,
  };
}

function trip(routeRoadIds: number[], routeIndex: number, destination: number) {
  return {
    tripId: "test-trip",
    originIntersectionId: 0,
    destinationIntersectionId: destination,
    routeRoadIds,
    routeIndex,
    tripTimeMs: 0,
    waitTimeMs: 0,
    distanceRemainingM: 0,
    distanceTravelledM: 0,
    intersectionsCleared: routeIndex,
    completed: false,
    estimatedRemainingMs: 0,
  };
}

function derive(
  model: MapModel,
  routeRoadIds: number[],
  routeIndex: number,
  ego: { roadId: number | null; progress: number },
  routeControls: { intersectionId: number; phaseIndex: number; stage: "green" | "yellow" | "all-red" }[] = [],
): ContextualControl[] {
  return deriveContextualControls({
    model,
    indexes: model.directedPaths.map((points) => (points ? buildPathIndex(points) : null)),
    laneOffsets: model.city.roads.map(() => 0),
    trip: trip(routeRoadIds, routeIndex, routeRoadIds[routeRoadIds.length - 1] + 1),
    ego,
    routeControls,
  });
}

/* ------------------------------------------------------------------ */
/* Route-distance reveal policy                                        */
/* ------------------------------------------------------------------ */

describe("contextual controls: route distance", () => {
  const model = chainModel([100, 100, 100], { 1: "signal", 2: "stop" });

  it("measures distance ahead ALONG the route, not straight-line", () => {
    const controls = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 40 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(controls.length).toBeGreaterThan(0);
    // The control is measured to the physical stop line, 7 m before node 1.
    expect(controls[0].intersectionId).toBe(1);
    expect(controls[0].distanceAheadM).toBeCloseTo(53, 6);
  });

  it("accumulates future roads in route order", () => {
    const controls = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 90 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    // Physical stop lines are 7 m before each controlled node.
    expect(controls.map((control) => control.intersectionId)).toEqual([1, 2]);
    expect(controls[0].distanceAheadM).toBeCloseTo(3, 6);
    expect(controls[1].distanceAheadM).toBeCloseTo(103, 6);
    expect(controls[1].kind).toBe("stop");
  });

  it("hides controls outside the preview band", () => {
    const long = chainModel([300, 100], { 1: "signal" });
    const far = derive(long, [0, 1], 0, { roadId: 0, progress: 0 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(far.length).toBe(0);
    // One metre inside the band it appears, and only as a preview.
    const inside = derive(
      long,
      [0, 1],
      0,
      { roadId: 0, progress: 300 - (CONTROL_REVEAL.previewM - 1) },
      [{ intersectionId: 1, phaseIndex: 0, stage: "green" }],
    );
    expect(inside.length).toBe(1);
    expect(inside[0].prominence).toBe("preview");
  });

  it("makes the nearest control primary and any second quieter", () => {
    const controls = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 95 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(controls[0].prominence).toBe("primary");
    expect(controls[1].prominence).toBe("preview");
    expect(controls[0].distanceAheadM).toBeLessThanOrEqual(CONTROL_REVEAL.primaryM);
    expect(controls[0].emphasis).toBe(1);
    expect(controls[1].emphasis).toBeGreaterThanOrEqual(0);
    expect(controls[1].emphasis).toBeLessThan(1);
  });

  it("retires a control the ego has passed", () => {
    const before = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 95 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(before.some((control) => control.intersectionId === 1)).toBe(true);
    // Now on the next road: the node-1 signal is behind the ego and gone.
    const after = derive(model, [0, 1, 2], 1, { roadId: 1, progress: 5 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
      { intersectionId: 2, phaseIndex: 0, stage: "green" },
    ]);
    expect(after.some((control) => control.intersectionId === 1)).toBe(false);
    expect(after[0].intersectionId).toBe(2);
    expect(after[0].distanceAheadM).toBeCloseTo(88, 6);
  });

  it("discovers signals only from the remaining route", () => {
    // The signal at node 1 belongs to a route the ego already left: never shown.
    const controls = derive(model, [1, 2], 0, { roadId: 1, progress: 0 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(controls.map((control) => control.intersectionId)).toEqual([2]);
    expect(controls[0].kind).toBe("stop");
  });

  it("swaps controls when the payload's route changes (reroute)", () => {
    // Two different remaining routes through the same graph: road 1 ends on
    // node 2 (stop-controlled), road 2 ends on node 3 (signal-controlled).
    // Past the divergence the payload's route decides what is ahead.
    const grid = chainModel([100, 100, 100], { 1: "signal", 2: "stop", 3: "signal" });
    const straight = derive(grid, [0, 1], 1, { roadId: 1, progress: 20 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
      { intersectionId: 2, phaseIndex: 0, stage: "green" },
    ]);
    const rerouted = derive(grid, [0, 2], 1, { roadId: 2, progress: 20 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
      { intersectionId: 3, phaseIndex: 0, stage: "green" },
    ]);
    expect(straight[0].intersectionId).toBe(2);
    expect(straight[0].kind).toBe("stop");
    expect(rerouted[0].intersectionId).toBe(3);
    expect(rerouted[0].kind).toBe("signal");
    // Node 3 has a single incoming road: its own group is green, so the ego may go.
    expect(rerouted[0].signal?.egoApproachPermitted).toBe(true);
  });

  it("has nothing to show when the trip is complete", () => {
    // The real arrival shape: the ego rests on its LAST road (routeIndex
    // length-1) with the trip marked complete — no control may remain.
    const resting = deriveContextualControls({
      model,
      indexes: model.directedPaths.map((points) => (points ? buildPathIndex(points) : null)),
      laneOffsets: model.city.roads.map(() => 0),
      trip: { ...trip([0, 1, 2], 2, 3), completed: true, intersectionsCleared: 2 },
      ego: { roadId: 2, progress: 100 },
      routeControls: [{ intersectionId: 3, phaseIndex: 0, stage: "green" }],
    });
    expect(resting).toEqual([]);
    expect(upcomingControl(resting)).toBeNull();
    // Past the end of the route entirely.
    const done = derive(model, [0, 1, 2], 3, { roadId: 2, progress: 100 }, []);
    expect(done).toEqual([]);
  });

  it("never shows a corridor of controls", () => {
    // Three controlled nodes inside the preview band: the nearest plus at most
    // one quieter control, never all three.
    const dense = chainModel([40, 40, 40, 40], { 1: "signal", 2: "signal", 3: "signal" });
    const controls = derive(dense, [0, 1, 2, 3], 0, { roadId: 0, progress: 0 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
      { intersectionId: 2, phaseIndex: 0, stage: "green" },
      { intersectionId: 3, phaseIndex: 0, stage: "green" },
    ]);
    expect(controls.length).toBe(CONTROL_REVEAL.maxVisible);
    expect(controls[0].prominence).toBe("primary");
    expect(controls[1].prominence).toBe("preview");
  });

  it("is deterministic for identical inputs", () => {
    const once = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 50 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    const twice = derive(model, [0, 1, 2], 0, { roadId: 0, progress: 50 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(once.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Stop signs: static graph semantics                                  */
/* ------------------------------------------------------------------ */

describe("contextual controls: stop signs", () => {
  const model = chainModel([100, 100], { 1: "stop" });

  it("reads stop control from the city graph, with no fake dynamic state", () => {
    const controls = derive(model, [0, 1], 0, { roadId: 0, progress: 40 });
    expect(controls.length).toBe(1);
    expect(controls[0].kind).toBe("stop");
    expect(controls[0].signal).toBeNull();
    expect(controls[0].prominence).toBe("primary");
  });

  it("renders the sign, never a signal head, for a stop-controlled node", () => {
    const controls = derive(model, [0, 1], 0, { roadId: 0, progress: 40 });
    expect(controlSpriteFor(controls[0])).toBe("control-stop");
  });

  it("ignores uncontrolled intersections", () => {
    const plain = chainModel([100, 100]);
    expect(derive(plain, [0, 1], 0, { roadId: 0, progress: 40 })).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Signal semantics: "can MY car go?"                                  */
/* ------------------------------------------------------------------ */

describe("contextual controls: ego approach semantics", () => {
  const { model, horizontal, vertical, center } = crossModel();
  const groups = deriveApproachGroups(model.city, center);

  it("splits the cross into two phase groups", () => {
    expect(groups.length).toBe(2);
    expect(groups.flat().sort()).toEqual([horizontal, vertical].sort());
  });

  it("permits the ego only when its own group is green", () => {
    const egoGroup = groups.findIndex((group) => group.includes(horizontal));
    const otherGroup = (egoGroup + 1) % groups.length;
    expect(canApproachProceedForPhase(groups, "green", egoGroup, horizontal)).toBe(true);
    expect(canApproachProceedForPhase(groups, "green", otherGroup, horizontal)).toBe(false);
    expect(canApproachProceedForPhase(groups, "yellow", egoGroup, horizontal)).toBe(false);
    expect(canApproachProceedForPhase(groups, "all-red", egoGroup, horizontal)).toBe(false);
  });

  it("shows green only for the permitted approach and red for the other group", () => {
    const egoGroup = groups.findIndex((group) => group.includes(horizontal));
    const otherGroup = (egoGroup + 1) % groups.length;
    const green = derive(model, [0], 0, { roadId: horizontal, progress: 60 }, [
      { intersectionId: center, phaseIndex: egoGroup, stage: "green" },
    ]);
    expect(controlSpriteFor(green[0])).toBe("control-signal-green");
    expect(green[0].signal?.egoApproachPermitted).toBe(true);

    // Green stage, DIFFERENT group active: the ego's light is red.
    const otherGreen = derive(model, [0], 0, { roadId: horizontal, progress: 60 }, [
      { intersectionId: center, phaseIndex: otherGroup, stage: "green" },
    ]);
    expect(controlSpriteFor(otherGreen[0])).toBe("control-signal-red");
    expect(otherGreen[0].signal?.egoApproachPermitted).toBe(false);

    const yellow = derive(model, [0], 0, { roadId: horizontal, progress: 60 }, [
      { intersectionId: center, phaseIndex: egoGroup, stage: "yellow" },
    ]);
    expect(controlSpriteFor(yellow[0])).toBe("control-signal-yellow");
    expect(yellow[0].signal?.egoApproachPermitted).toBe(false);

    const allRed = derive(model, [0], 0, { roadId: horizontal, progress: 60 }, [
      { intersectionId: center, phaseIndex: egoGroup, stage: "all-red" },
    ]);
    expect(controlSpriteFor(allRed[0])).toBe("control-signal-red");
  });

  it("agrees with the engine's permission behaviour in every stage", () => {
    // Drive a real signal state through its whole cycle and compare, for every
    // incoming road and every phase, against the presentation helper.
    const state = createSignalState(model.city, center);
    for (let phase = 0; phase < groups.length; phase += 1) {
      for (let step = 0; step < 60; step += 1) {
        const enginePermits = canApproachProceed(state, horizontal);
        const presentationPermits = canApproachProceedForPhase(
          state.groups,
          state.stage,
          state.phaseIndex,
          horizontal,
        );
        expect(presentationPermits).toBe(enginePermits);
        const enginePermitsVertical = canApproachProceed(state, vertical);
        const presentationVertical = canApproachProceedForPhase(
          state.groups,
          state.stage,
          state.phaseIndex,
          vertical,
        );
        expect(presentationVertical).toBe(enginePermitsVertical);
        stepSignal(state, 1_000, "advance");
      }
    }
    expect(state.phaseIndex).toBeGreaterThanOrEqual(0);
  });

  it("draws nothing for a signal with no authoritative state", () => {
    // A signal-controlled node with no routeControls entry: no invented stage.
    const controls = derive(model, [0], 0, { roadId: horizontal, progress: 60 }, []);
    expect(controls).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Placement and scale                                                 */
/* ------------------------------------------------------------------ */

describe("contextual controls: placement and scale", () => {
  const model = chainModel([100, 100], { 1: "signal" });

  it("places the control beside the incoming approach, off the centreline", () => {
    const controls = derive(model, [0, 1], 0, { roadId: 0, progress: 40 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    const control = controls[0];
    // The road runs along +x at y = 0; the control must sit off the centreline,
    // on the approach side (before the intersection at x = 100).
    expect(Math.abs(control.y)).toBeGreaterThan(2);
    expect(control.x).toBeLessThanOrEqual(100);
    expect(control.x).toBeGreaterThan(90);
    expect(Math.hypot(control.x - 100, control.y)).toBeGreaterThan(2);
    // Bearing is the approach direction (east).
    expect(Math.abs(control.bearing)).toBeLessThan(0.01);
  });

  it("sizes controls in map metres with pixel floors and caps", () => {
    const controls = derive(model, [0, 1], 0, { roadId: 0, progress: 40 }, [
      { intersectionId: 1, phaseIndex: 0, stage: "green" },
    ]);
    const sprites = {
      atlas: "data:,",
      mapping: Object.fromEntries(
        CONTROL_SPRITE_IDS.map((id) => [id, { x: 0, y: 0, width: 8, height: 8, anchorX: 4, anchorY: 8, mask: false }]),
      ),
    } as never;
    const layers = buildControlLayers(model.projection, controls, sprites);
    expect(layers.map((layer) => layer.id)).toEqual(["control-primary"]);
    const props = (layers[0] as unknown as { props: Record<string, unknown> }).props;
    expect(props.sizeUnits).toBe("meters");
    expect(props.sizeMinPixels).toBe(CONTROL_SCALE.minPixels);
    expect(props.sizeMaxPixels).toBe(CONTROL_SCALE.maxPixels);
    expect((props.getSize as (control: ContextualControl) => number)(controls[0])).toBe(CONTROL_SCALE.signalHeightM);
    expect(controlPixelBounds().minPixels).toBeGreaterThan(0);
    expect(CONTROL_SCALE.minPixels).toBeLessThan(50);
    expect(CONTROL_SCALE.maxPixels).toBeGreaterThan(CONTROL_SCALE.minPixels);
    expect(props.billboard).toBe(true);

    // A preview control draws smaller and quieter.
    const previewOnly = [{ ...controls[0], prominence: "preview" as const, emphasis: 0 }];
    const previewLayers = buildControlLayers(model.projection, previewOnly, sprites);
    const previewProps = (previewLayers[0] as unknown as { props: Record<string, unknown> }).props;
    expect(previewProps.sizeMinPixels).toBe(CONTROL_SCALE.previewMinPixels);
    expect(previewProps.opacity).toBeCloseTo(CONTROL_SCALE.previewOpacity, 5);
    expect((previewProps.getSize as (control: ContextualControl) => number)(previewOnly[0])).toBeCloseTo(CONTROL_SCALE.signalHeightM * CONTROL_SCALE.previewSizeScale, 6);
  });

  it("draws nothing when the atlas is missing", () => {
    expect(buildControlLayers(model.projection, [], null)).toEqual([]);
    expect(createControlSprites).toBeTypeOf("function");
  });
});

/* ------------------------------------------------------------------ */
/* Real route, real payload                                            */
/* ------------------------------------------------------------------ */

describe("contextual controls on the curated challenge", () => {
  const model = chicagoModel(4);

  function liveFrame(controller: "fixed" | "adaptive", runMs: number) {
    const { spawn } = materializeChallengeTrip(model, "united-center-to-navy-pier", 11);
    const engine = createEngine({
      city: model.city,
      controller: controller === "fixed" ? createFixedController() : createAdaptiveController(),
      spawns: [spawn],
    });
    runEngine(engine, runMs);
    return { engine, snapshot: buildPresentationSnapshot(engine, 0, "united-center-to-navy-pier") };
  }

  it("derives at most a couple of controls from a real frame", () => {
    const { snapshot } = liveFrame("adaptive", 4_000);
    const controls = deriveContextualControls({
      model,
      indexes: model.directedPaths.map((points) => (points ? buildPathIndex(points) : null)),
      laneOffsets: model.city.roads.map(() => 0),
      trip: snapshot.trip,
      ego: snapshot.ego ? { roadId: snapshot.ego.roadId, progress: snapshot.ego.progress } : null,
      routeControls: snapshot.routeControls,
    });
    expect(controls.length).toBeLessThanOrEqual(2);
    for (const control of controls) {
      expect(control.distanceAheadM).toBeLessThanOrEqual(CONTROL_REVEAL.previewM);
      expect(control.distanceAheadM).toBeGreaterThan(0);
      if (control.kind === "signal") {
        expect(control.signal).not.toBeNull();
        expect(control.signal?.stage).toBeTruthy();
      }
    }
  });

  it("keeps the trip across a live controller switch, with controls still derived", () => {
    const { engine, snapshot } = liveFrame("fixed", 3_000);
    const egoBefore = engine.egoVehicleId;
    const routeBefore = [...(snapshot.trip?.routeRoadIds ?? [])];
    setEngineController(engine, createAdaptiveController());
    // runEngine takes an absolute horizon.
    runEngine(engine, 6_000);
    const after = buildPresentationSnapshot(engine, 1, "united-center-to-navy-pier");
    expect(engine.egoVehicleId).toBe(egoBefore);
    expect(after.trip?.routeRoadIds).toEqual(routeBefore);
    expect(after.trip?.tripTimeMs).toBeGreaterThan(snapshot.trip?.tripTimeMs ?? 0);
    // The signal state in the frame is the NEW controller's, and it still
    // derives cleanly.
    expect(after.routeControls.length).toBeGreaterThan(0);
    expect(after.routeControls.every((signal) => ["green", "yellow", "all-red"].includes(signal.stage))).toBe(true);
  });
});
