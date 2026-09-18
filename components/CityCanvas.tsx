"use client";

/**
 * CityCanvas (Task 11): one canvas, one rAF loop, zero DOM fleet nodes.
 * The render loop reads the shared frame buffer directly and never triggers
 * React rerenders. Sizing follows container CSS size × devicePixelRatio with
 * ResizeObserver + DPR-change tracking.
 */
import { useEffect, useRef, type RefObject } from "react";
import { CanvasRenderer } from "@/render/canvas-renderer";
import { frameAlpha, interpolateVehicles, type RenderedVehicle } from "@/render/interpolate";
import { SIM_TICK_MS, SNAPSHOT_EVERY_TICKS } from "@/worker/protocol";
import type { FrameBuffer } from "./frame-buffer";

const EXPECTED_FRAME_INTERVAL_MS = SIM_TICK_MS * SNAPSHOT_EVERY_TICKS;

export function CityCanvas({
  frames,
  debug = false,
}: {
  frames: RefObject<FrameBuffer>;
  debug?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const debugRef = useRef(debug);
  useEffect(() => {
    debugRef.current = debug;
  }, [debug]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const renderer = new CanvasRenderer(canvas);
    const applySize = () => {
      const rect = canvas.getBoundingClientRect();
      renderer.resize(rect.width, rect.height, window.devicePixelRatio || 1);
    };
    applySize(); // zero-size initial layout is handled defensively by the renderer
    const observer = new ResizeObserver(applySize);
    observer.observe(canvas);
    let dprQuery: MediaQueryList | null = null;
    const watchDpr = () => {
      dprQuery?.removeEventListener?.("change", onDprChange);
      dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      dprQuery.addEventListener?.("change", onDprChange);
    };
    const onDprChange = () => {
      applySize();
      watchDpr();
    };
    watchDpr();

    let handle = 0;
    let lastGeneration = -1;
    let vehicles: RenderedVehicle[] = [];
    const loop = (now: number) => {
      const buffer = frames.current;
      if (buffer) {
        if (buffer.generation !== lastGeneration) {
          renderer.setModel(buffer.model);
          lastGeneration = buffer.generation;
        }
        if (buffer.model) {
          vehicles =
            buffer.current !== null
              ? interpolateVehicles(
                  buffer.model,
                  buffer.previous,
                  buffer.current,
                  frameAlpha(now, buffer.currentReceivedAtMs, EXPECTED_FRAME_INTERVAL_MS),
                )
              : [];
          renderer.draw({
            model: buffer.model,
            vehicles,
            snapshot: buffer.current,
            nowMs: now,
            debug: debugRef.current,
          });
        }
      }
      handle = requestAnimationFrame(loop);
    };
    handle = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(handle);
      observer.disconnect();
      dprQuery?.removeEventListener?.("change", onDprChange);
    };
  }, [frames]);

  return (
    <canvas
      ref={canvasRef}
      aria-label="City map with live traffic"
      className="absolute inset-0 h-full w-full"
    />
  );
}
