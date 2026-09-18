"use client";

/**
 * Frame buffer (Task 11): high-frequency presentation frames live in a plain
 * mutable ref shared between the worker client and CityCanvas — deliberately
 * NOT in React state, so 5 Hz frames never rerender the tree.
 */
import type { StaticRenderModel } from "@/render/model";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";

export interface FrameBuffer {
  /** Static city geometry from READY; null until the first run. */
  model: StaticRenderModel | null;
  previous: PresentationSnapshot | null;
  current: PresentationSnapshot | null;
  currentReceivedAtMs: number;
  /** Bumped whenever a new render model arrives (INIT/RESET). */
  generation: number;
}

export function createFrameBuffer(): FrameBuffer {
  return {
    model: null,
    previous: null,
    current: null,
    currentReceivedAtMs: 0,
    generation: 0,
  };
}

export function setFrameModel(buffer: FrameBuffer, model: StaticRenderModel): void {
  buffer.model = model;
  buffer.previous = null;
  buffer.current = null;
  buffer.currentReceivedAtMs = 0;
  buffer.generation += 1;
}

export function pushFrame(
  buffer: FrameBuffer,
  snapshot: PresentationSnapshot,
  receivedAtMs: number,
): void {
  buffer.previous = buffer.current;
  buffer.current = snapshot;
  buffer.currentReceivedAtMs = receivedAtMs;
}
