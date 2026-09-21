/**
 * Frame buffer tests (Task 11 polish pass): the interpolation baseline must
 * never span a restart, or the first frames of a new run lerp against the
 * previous run's vehicles.
 */
import { describe, expect, it } from "vitest";
import { createFrameBuffer, pushFrame, setFrameModel } from "@/components/frame-buffer";
import { chicagoModel } from "./chicago-support";
import { buildDirectedPathIndexes } from "@/render/map-geometry";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";

function snapshot(sequence: number, timeMs: number): PresentationSnapshot {
  return {
    sequence,
    timeMs,
    controller: "adaptive",
    governance: { modified: false, manualIncidents: 0 },
    policy: null,
    ego: null,
    roadTraffic: [],
    routeControls: [],
    trip: null,
    roadConditions: [],
    incidents: [],
  };
}

describe("frame buffer", () => {
  it("keeps the previous frame for smooth interpolation", () => {
    const buffer = createFrameBuffer();
    pushFrame(buffer, snapshot(1, 0), 100);
    pushFrame(buffer, snapshot(2, 200), 300);
    expect(buffer.previous?.sequence).toBe(1);
    expect(buffer.current?.sequence).toBe(2);
  });

  it("drops the baseline when a run restarts", () => {
    const buffer = createFrameBuffer();
    pushFrame(buffer, snapshot(1, 0), 100);
    pushFrame(buffer, snapshot(2, 600_000), 200);
    pushFrame(buffer, snapshot(3, 0), 300); // RESET: the clock went backwards
    expect(buffer.previous).toBeNull();
    expect(buffer.current?.timeMs).toBe(0);
  });

  it("drops the baseline on an out-of-order frame", () => {
    const buffer = createFrameBuffer();
    pushFrame(buffer, snapshot(2, 400), 100);
    pushFrame(buffer, snapshot(2, 400), 200);
    expect(buffer.previous).toBeNull();
  });

  it("clears both frames when a new scale arrives", () => {
    const buffer = createFrameBuffer();
    pushFrame(buffer, snapshot(1, 0), 100);
    const model = chicagoModel(4);
    setFrameModel(buffer, model, buildDirectedPathIndexes(model));
    expect(buffer.previous).toBeNull();
    expect(buffer.current).toBeNull();
    expect(buffer.generation).toBe(1);
  });
});
