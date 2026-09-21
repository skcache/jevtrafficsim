/**
 * Soft pan boundary: the camera centre may look past the city edge for context,
 * but it cannot be dragged off the map into blank paper.
 *
 * These pin the BOX and the clamp (the parts a unit test can own). The wiring
 * that applies them to the live MapLibre camera is deliberately not MapLibre's
 * `maxBounds`: measured on the running map, a 25%-padded maxBounds pinned the
 * camera at zoom 13.09 and made the app's own minZoom 12 unreachable, because
 * MapLibre zooms in whenever the viewport is larger than the bounds.
 */
import { describe, expect, it } from "vitest";
import {
  CAMERA_PRESETS,
  clampToBounds,
  MAX_PAN_PADDING_FRACTION,
  maxPanBounds,
  networkBounds,
  presetPose,
  type CameraPresetName,
} from "@/render/camera-presets";
import { lngLatToMetric, metricToLngLat } from "@/cities/map-model";
import { chicagoModel } from "./chicago-support";

describe("soft pan boundary", () => {
  const model = chicagoModel(4);
  const network = networkBounds(model);
  const pan = maxPanBounds(model);

  it("grows the network box by the documented fraction on every side", () => {
    const padX = (network.maxX - network.minX) * MAX_PAN_PADDING_FRACTION;
    const padY = (network.maxY - network.minY) * MAX_PAN_PADDING_FRACTION;
    expect(pan.minX).toBeCloseTo(network.minX - padX, 9);
    expect(pan.maxX).toBeCloseTo(network.maxX + padX, 9);
    expect(pan.minY).toBeCloseTo(network.minY - padY, 9);
    expect(pan.maxY).toBeCloseTo(network.maxY + padY, 9);
    // A soft margin, not an unbounded map: 35% of the span each way.
    expect(pan.maxX - pan.minX).toBeCloseTo(
      (network.maxX - network.minX) * (1 + 2 * MAX_PAN_PADDING_FRACTION),
      9,
    );
    expect(pan.maxY - pan.minY).toBeCloseTo(
      (network.maxY - network.minY) * (1 + 2 * MAX_PAN_PADDING_FRACTION),
      9,
    );
  });

  it("keeps every camera preset inside the boundary", () => {
    for (const name of Object.keys(CAMERA_PRESETS) as CameraPresetName[]) {
      const pose = presetPose(name);
      const [x, y] = lngLatToMetric(model.projection, pose.center[0], pose.center[1]);
      expect(x, `${name} x`).toBeGreaterThan(pan.minX);
      expect(x, `${name} x`).toBeLessThan(pan.maxX);
      expect(y, `${name} y`).toBeGreaterThan(pan.minY);
      expect(y, `${name} y`).toBeLessThan(pan.maxY);
    }
  });

  it("clamps only the axes that leave the box", () => {
    const cx = (pan.minX + pan.maxX) / 2;
    const cy = (pan.minY + pan.maxY) / 2;
    // Inside: untouched, to the last bit — the live handler must not fight a
    // camera move that is already legal.
    expect(clampToBounds(pan, cx, cy)).toEqual([cx, cy]);
    // Outside on both axes: pulled to the corner.
    expect(clampToBounds(pan, pan.maxX + 5_000, pan.maxY + 5_000)).toEqual([pan.maxX, pan.maxY]);
    expect(clampToBounds(pan, pan.minX - 5_000, pan.minY - 5_000)).toEqual([pan.minX, pan.minY]);
    // Outside on one axis: the other keeps its value.
    expect(clampToBounds(pan, pan.maxX + 1, cy)).toEqual([pan.maxX, cy]);
    expect(clampToBounds(pan, cx, pan.minY - 1)).toEqual([cx, pan.minY]);
  });

  it("pulls a far-dragged centre back onto the box, through lng/lat", () => {
    // Exactly what CityMap does per move event: centre -> metric -> clamp ->
    // back to lng/lat for the camera.
    const far = metricToLngLat(model.projection, pan.maxX + 50_000, pan.minY - 50_000);
    const [x, y] = lngLatToMetric(model.projection, far[0], far[1]);
    const [clampedX, clampedY] = clampToBounds(pan, x, y);
    const back = metricToLngLat(model.projection, clampedX, clampedY);
    const [roundX, roundY] = lngLatToMetric(model.projection, back[0], back[1]);
    expect(roundX).toBeCloseTo(pan.maxX, 6);
    expect(roundY).toBeCloseTo(pan.minY, 6);
  });
});
