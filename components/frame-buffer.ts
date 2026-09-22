"use client";

/**
 * Frame buffer (Task 11 visual correction): high-frequency presentation
 * frames and the compiled showcase geometry live in a plain mutable ref
 * shared between the worker client and the map surface — deliberately NOT in
 * React state, so worker frames never rerender the tree.
 */
import type { MapModel } from "@/cities/map-model";
import type { DirectedPathIndexes } from "@/render/map-geometry";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";

export interface FrameBuffer {
  /** Compiled showcase model for the active scale (deterministic, shared with the worker). */
  model: MapModel | null;
  paths: DirectedPathIndexes | null;
  previous: PresentationSnapshot | null;
  current: PresentationSnapshot | null;
  currentReceivedAtMs: number;
  /** Bumped whenever a new scale/model arrives (INIT/RESET). */
  generation: number;
}

export function createFrameBuffer(): FrameBuffer {
  return {
    model: null,
    paths: null,
    previous: null,
    current: null,
    currentReceivedAtMs: 0,
    generation: 0,
  };
}

export function setFrameModel(
  buffer: FrameBuffer,
  model: MapModel,
  paths: DirectedPathIndexes,
): void {
  buffer.model = model;
  buffer.paths = paths;
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
  // A reset (same-seed restart) restarts the clock: interpolating between the
  // finished run's last frame and the new run's first would draw nonsense for
  // one frame interval, so the baseline is dropped instead.
  const restarted = buffer.current !== null && snapshot.timeMs <= buffer.current.timeMs;
  buffer.previous = restarted ? null : buffer.current;
  buffer.current = snapshot;
  buffer.currentReceivedAtMs = receivedAtMs;
}
