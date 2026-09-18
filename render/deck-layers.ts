/**
 * deck.gl dynamic layers (Task 11 visual correction): vehicles, signals and
 * incident overlays. Built fresh each animation frame from the bounded 5 Hz
 * presentation snapshot (interpolated) — the GPU does the drawing, no DOM
 * nodes per vehicle.
 *
 * Framework-free apart from deck.gl itself (a browser presentation
 * dependency); no simulation logic here.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer, LineLayer, PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { ShowcaseMapModel } from "@/cities/showcase-city";
import { deriveApproachGroups } from "@/sim/signals";
import type { RoadId } from "@/sim/types";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { RenderedVehicle } from "./interpolate";
import { METRES_PER_DEGREE } from "./showcase-geojson";
import { WAIT_HEAT_COLORS, waitHeatBucket } from "./showcase-geometry";
import { vehicleSizeScale, type VehicleIconSet } from "./vehicle-icons";

export type LngLat = [number, number];

export function toLngLat(x: number, y: number): LngLat {
  return [x / METRES_PER_DEGREE, y / METRES_PER_DEGREE];
}

export interface SignalPlanEntry {
  readonly intersectionId: number;
  readonly x: number;
  readonly y: number;
  /** Mean bearing (radians) of each approach group, in phase order. */
  readonly groupBearings: readonly number[];
}

function meanBearing(model: ShowcaseMapModel, roads: readonly RoadId[]): number {
  let sx = 0;
  let sy = 0;
  for (const roadId of roads) {
    const road = model.city.roads[roadId];
    if (!road) {
      continue;
    }
    const from = model.city.intersections[road.from];
    const to = model.city.intersections[road.to];
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    sx += (to.x - from.x) / length;
    sy += (to.y - from.y) / length;
  }
  return Math.atan2(sy, sx);
}

/** Precomputed per-intersection phase geometry (built once per compiled scale). */
export function buildSignalPlans(model: ShowcaseMapModel): Map<number, SignalPlanEntry> {
  const plans = new Map<number, SignalPlanEntry>();
  for (const intersection of model.city.intersections) {
    if (intersection.control !== "signal") {
      continue;
    }
    const groups = deriveApproachGroups(model.city, intersection.id);
    plans.set(intersection.id, {
      intersectionId: intersection.id,
      x: intersection.x,
      y: intersection.y,
      groupBearings: groups.map((roads) => meanBearing(model, roads)),
    });
  }
  return plans;
}

const SIGNAL_COLORS = {
  green: [63, 157, 99, 235] as const,
  yellow: [217, 161, 60, 235] as const,
  "all-red": [196, 69, 58, 235] as const,
};

export function buildVehicleLayer(
  vehicles: readonly RenderedVehicle[],
  icons: VehicleIconSet,
  zoom: number,
): Layer {
  const scale = vehicleSizeScale(zoom);
  return new IconLayer<RenderedVehicle>({
    id: "vehicles",
    data: vehicles as RenderedVehicle[],
    iconAtlas: icons.atlas,
    iconMapping: icons.mapping,
    getIcon: (vehicle) => vehicle.type,
    getPosition: (vehicle) => toLngLat(vehicle.x, vehicle.y),
    getSize: (vehicle) => icons.lengths[vehicle.type] * scale,
    getColor: (vehicle) => [...WAIT_HEAT_COLORS[waitHeatBucket(vehicle.blockedWaitMs)]],
    getAngle: (vehicle) => (vehicle.headingRadians * 180) / Math.PI,
    sizeUnits: "pixels",
    billboard: false,
    pickable: false,
    updateTriggers: {
      getSize: zoom,
      getColor: vehicles.map((vehicle) => vehicle.blockedWaitMs).join(","),
      getAngle: vehicles.map((vehicle) => vehicle.headingRadians).join(","),
    },
  });
}

export function buildSignalLayers(
  snapshot: PresentationSnapshot | null,
  plans: Map<number, SignalPlanEntry>,
  zoom: number,
): Layer[] {
  if (!snapshot || zoom < 13.2) {
    return [];
  }
  const opacity = Math.min(1, Math.max(0, (zoom - 13.2) / 1.6));
  interface SignalPoint {
    intersectionId: number;
    position: LngLat;
    color: readonly [number, number, number, number];
  }
  const points: SignalPoint[] = [];
  interface Axis {
    source: LngLat;
    target: LngLat;
    color: readonly [number, number, number, number];
  }
  const axes: Axis[] = [];
  for (const signal of snapshot.signals) {
    const plan = plans.get(signal.intersectionId);
    if (!plan) {
      continue;
    }
    const color = SIGNAL_COLORS[signal.stage];
    points.push({
      intersectionId: signal.intersectionId,
      position: toLngLat(plan.x, plan.y),
      color: [color[0], color[1], color[2], Math.round(color[3] * opacity)],
    });
    if (signal.stage !== "all-red" && plan.groupBearings.length > 0) {
      const bearing = plan.groupBearings[signal.phaseIndex % plan.groupBearings.length];
      const reach = 11;
      axes.push({
        source: toLngLat(plan.x - Math.cos(bearing) * reach, plan.y - Math.sin(bearing) * reach),
        target: toLngLat(plan.x + Math.cos(bearing) * reach, plan.y + Math.sin(bearing) * reach),
        color: [color[0], color[1], color[2], Math.round(230 * opacity)],
      });
    }
  }
  return [
    new LineLayer<Axis>({
      id: "signals-axis",
      data: axes,
      getSourcePosition: (axis) => axis.source,
      getTargetPosition: (axis) => axis.target,
      getColor: (axis) => [...axis.color],
      getWidth: 4,
      widthUnits: "pixels",
      pickable: false,
    }),
    new ScatterplotLayer<SignalPoint>({
      id: "signals-base",
      data: points,
      getPosition: (point) => point.position,
      getRadius: 4.4,
      radiusUnits: "pixels",
      getFillColor: (point) => [...point.color],
      stroked: true,
      getLineColor: [255, 255, 255, Math.round(220 * opacity)],
      lineWidthUnits: "pixels",
      getLineWidth: 1.4,
      pickable: false,
    }),
  ];
}

export function buildIncidentLayers(
  snapshot: PresentationSnapshot | null,
  model: ShowcaseMapModel,
  nowMs: number,
): Layer[] {
  if (!snapshot) {
    return [];
  }
  const closedPaths: LngLat[][] = [];
  const closedBridgePaths: LngLat[][] = [];
  const closedBridgeMarkers: LngLat[] = [];
  const seen = new Set<string>();
  const crashMarkers: LngLat[] = [];
  const eventCenters: LngLat[] = [];
  const closedRoadIds = new Set(
    snapshot.roadConditions.filter((condition) => condition.closed).map((condition) => condition.roadId),
  );
  for (const roadId of closedRoadIds) {
    const path = model.directedPaths[roadId];
    if (!path || path.length < 2) {
      continue;
    }
    const key = `${path[0][0]}|${path[0][1]}|${path[path.length - 1][0]}|${path[path.length - 1][1]}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const converted = path.map(([x, y]) => toLngLat(x, y));
    if (model.city.roads[roadId]?.kind === "bridge") {
      // Bridges get their own, stronger treatment: a closed crossing is the
      // most consequential incident on the map.
      closedBridgePaths.push(converted);
      const mid = path[Math.floor(path.length / 2)];
      closedBridgeMarkers.push(toLngLat(mid[0], mid[1]));
    } else {
      closedPaths.push(converted);
    }
  }
  for (const incident of snapshot.incidents) {
    if (incident.status !== "active") {
      continue;
    }
    if (incident.kind === "crash") {
      for (const roadId of incident.roadIds) {
        const path = model.directedPaths[roadId];
        if (!path || path.length < 2) {
          continue;
        }
        const mid = path[Math.floor(path.length / 2)];
        crashMarkers.push(toLngLat(mid[0], mid[1]));
      }
    } else if (incident.kind === "event-release" && incident.eventCenterIntersectionId !== null) {
      const center = model.city.intersections[incident.eventCenterIntersectionId];
      if (center) {
        eventCenters.push(toLngLat(center.x, center.y));
      }
    }
  }
  const pulse = (nowMs % 2500) / 2500;
  return [
    new PathLayer<LngLat[]>({
      id: "closed-roads",
      data: closedPaths,
      getPath: (path) => path,
      getColor: [176, 74, 58, 205],
      getWidth: 5.5,
      widthUnits: "pixels",
      capRounded: true,
      pickable: false,
    }),
    new PathLayer<LngLat[]>({
      id: "closed-bridges",
      data: closedBridgePaths,
      getPath: (path) => path,
      getColor: [158, 52, 40, 235],
      getWidth: 8,
      widthUnits: "pixels",
      capRounded: true,
      pickable: false,
    }),
    new ScatterplotLayer<LngLat>({
      id: "closed-bridge-markers",
      data: closedBridgeMarkers,
      getPosition: (position) => position,
      getRadius: 7,
      radiusUnits: "pixels",
      getFillColor: [158, 52, 40, 245],
      stroked: true,
      getLineColor: [255, 255, 255, 245],
      lineWidthUnits: "pixels",
      getLineWidth: 2.2,
      pickable: false,
    }),
    new ScatterplotLayer<LngLat>({
      id: "event-rings",
      data: eventCenters,
      getPosition: (position) => position,
      getRadius: 12 + pulse * 16,
      radiusUnits: "pixels",
      stroked: true,
      filled: false,
      getLineColor: [111, 102, 232, Math.round(210 - pulse * 110)],
      lineWidthUnits: "pixels",
      getLineWidth: 2,
      pickable: false,
    }),
    new ScatterplotLayer<LngLat>({
      id: "crash-markers",
      data: crashMarkers,
      getPosition: (position) => position,
      getRadius: 5.5,
      radiusUnits: "pixels",
      getFillColor: [196, 69, 58, 240],
      stroked: true,
      getLineColor: [255, 255, 255, 240],
      lineWidthUnits: "pixels",
      getLineWidth: 1.6,
      pickable: false,
    }),
  ];
}
