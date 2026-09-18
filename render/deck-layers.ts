/**
 * deck.gl dynamic layers (Task 11 polish pass): vehicles, signals and incident
 * overlays, rebuilt each animation frame from the bounded 5 Hz presentation
 * snapshot (interpolated). The GPU draws everything — no DOM per vehicle.
 *
 * Vehicle language (two channels):
 *   body  = class identity (light chips, always legible on roads)
 *   ring  = wait heat (warm outline; dark ink while free-flowing)
 * Bodies are split into five heat-bucket layers drawn coldest-first so a
 * waiting vehicle is never buried under neutral ones.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { MapModel } from "@/cities/map-model";
import { deriveApproachGroups } from "@/sim/signals";
import type { RoadId } from "@/sim/types";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { RenderedVehicle } from "./interpolate";
import { metricToLngLat, type Projection } from "@/cities/map-model";
import { waitHeatBucket, WAIT_HEAT_COLORS } from "./map-geometry";
import {
  egressArrows,
  groupByHeatBucket,
  hatchSegments,
  signalAxisReachMetres,
  signalTier,
  signalTierOpacity,
  stopBarGeometry,
  VEHICLE_BODY_COLORS,
  VEHICLE_OUTLINE_COLOR,
  ringScaleForZoom,
  vehicleHaloColor,
  vehicleHaloExtraPx,
  vehicleLengthPx,
  vehicleRingExtraPx,
} from "./visuals";
import type { VehicleIconSet } from "./vehicle-icons";

export type LngLat = [number, number];

/** Local metres -> WGS84 through the model's projection. */
export function toLngLat(projection: Projection, x: number, y: number): LngLat {
  return metricToLngLat(projection, x, y);
}

export interface SignalPlanEntry {
  readonly intersectionId: number;
  readonly x: number;
  readonly y: number;
  /** Mean bearing (radians) of each approach group, in phase order. */
  readonly groupBearings: readonly number[];
}

function meanBearing(model: MapModel, roads: readonly RoadId[]): number {
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
export function buildSignalPlans(model: MapModel): Map<number, SignalPlanEntry> {
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
  green: [47, 138, 85, 235] as const,
  yellow: [201, 138, 43, 235] as const,
  "all-red": [178, 58, 44, 235] as const,
};

/* ------------------------------------------------------------------ */
/* Vehicles                                                            */
/* ------------------------------------------------------------------ */

export function buildVehicleLayers(
  projection: Projection,
  vehicles: readonly RenderedVehicle[],
  icons: VehicleIconSet,
  zoom: number,
): Layer[] {
  if (vehicles.length === 0) {
    return [];
  }
  // Glow first: the most patient vehicles get a soft warm bloom underneath.
  const halos = new IconLayer<RenderedVehicle>({
    id: "vehicle-halos",
    data: vehicles.filter((vehicle) => vehicleHaloExtraPx(waitHeatBucket(vehicle.blockedWaitMs)) > 0),
    iconAtlas: icons.atlas,
    iconMapping: icons.mapping,
    getIcon: (vehicle) => vehicle.type,
    getPosition: (vehicle) => toLngLat(projection, vehicle.x, vehicle.y),
    getSize: (vehicle) =>
      vehicleLengthPx(vehicle.type, zoom) +
      vehicleHaloExtraPx(waitHeatBucket(vehicle.blockedWaitMs)) * ringScaleForZoom(zoom),
    getColor: (vehicle) => [...vehicleHaloColor(waitHeatBucket(vehicle.blockedWaitMs))],
    getAngle: (vehicle) => (vehicle.headingRadians * 180) / Math.PI,
    sizeUnits: "pixels",
    billboard: false,
    pickable: false,
    updateTriggers: { getSize: zoom },
  });
  const rings = new IconLayer<RenderedVehicle>({
    id: "vehicle-rings",
    data: vehicles as RenderedVehicle[],
    iconAtlas: icons.atlas,
    iconMapping: icons.mapping,
    getIcon: (vehicle) => vehicle.type,
    getPosition: (vehicle) => toLngLat(projection, vehicle.x, vehicle.y),
    getSize: (vehicle) =>
      vehicleLengthPx(vehicle.type, zoom) +
      vehicleRingExtraPx(waitHeatBucket(vehicle.blockedWaitMs)) * ringScaleForZoom(zoom),
    getColor: (vehicle) => {
      const bucket = waitHeatBucket(vehicle.blockedWaitMs);
      if (bucket === 0) {
        return [...VEHICLE_OUTLINE_COLOR];
      }
      const [r, g, b] = WAIT_HEAT_COLORS[bucket];
      return [r, g, b, 235];
    },
    getAngle: (vehicle) => (vehicle.headingRadians * 180) / Math.PI,
    sizeUnits: "pixels",
    billboard: false,
    pickable: false,
    updateTriggers: {
      getSize: zoom,
      getColor: vehicles.map((vehicle) => vehicle.blockedWaitMs).join(","),
    },
  });
  const bodies = groupByHeatBucket(vehicles).map(
    (group, bucket) =>
      new IconLayer<RenderedVehicle>({
        id: `vehicle-body-${bucket}`,
        data: group,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: (vehicle) => vehicle.type,
        getPosition: (vehicle) => toLngLat(projection, vehicle.x, vehicle.y),
        getSize: (vehicle) => vehicleLengthPx(vehicle.type, zoom),
        getColor: (vehicle) => [...VEHICLE_BODY_COLORS[vehicle.type], 255],
        getAngle: (vehicle) => (vehicle.headingRadians * 180) / Math.PI,
        sizeUnits: "pixels",
        billboard: false,
        pickable: false,
        updateTriggers: { getSize: zoom },
      }),
  );
  return [halos, rings, ...bodies];
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */

interface SignalEntry {
  intersectionId: number;
  position: LngLat;
  x: number;
  y: number;
  color: readonly [number, number, number, number];
  bearing: number | null;
  phaseIndex: number;
}

export function buildSignalLayers(
  projection: Projection,
  snapshot: PresentationSnapshot | null,
  plans: Map<number, SignalPlanEntry>,
  zoom: number,
): Layer[] {
  const tier = signalTier(zoom);
  if (!snapshot || tier === "hidden") {
    return [];
  }
  const opacity = signalTierOpacity(zoom);
  const entries: SignalEntry[] = [];
  for (const signal of snapshot.signals) {
    const plan = plans.get(signal.intersectionId);
    if (!plan) {
      continue;
    }
    const base = SIGNAL_COLORS[signal.stage];
    const bearing =
      signal.stage !== "all-red" && plan.groupBearings.length > 0
        ? plan.groupBearings[signal.phaseIndex % plan.groupBearings.length]
        : null;
    entries.push({
      intersectionId: signal.intersectionId,
      position: toLngLat(projection, plan.x, plan.y),
      x: plan.x,
      y: plan.y,
      color: [base[0], base[1], base[2], Math.round(base[3] * opacity)],
      bearing,
      phaseIndex: signal.phaseIndex,
    });
  }

  const layers: Layer[] = [];
  if (tier === "far") {
    layers.push(
      new ScatterplotLayer<SignalEntry>({
        id: "signals-dot",
        data: entries,
        getPosition: (entry) => entry.position,
        getRadius: 3.2,
        radiusUnits: "pixels",
        getFillColor: (entry) => [...entry.color],
        pickable: false,
      }),
    );
    return layers;
  }

  // Mid and close: active-axis bar (the phase, made readable).
  const reach = signalAxisReachMetres(tier);
  const axes = entries.filter((entry) => entry.bearing !== null);
  layers.push(
    new LineLayer<SignalEntry>({
      id: "signals-axis",
      data: axes,
      getSourcePosition: (entry) => toLngLat(projection, entry.x, entry.y),
      getTargetPosition: (entry) =>
        toLngLat(projection, 
          entry.x + Math.cos(entry.bearing!) * reach,
          entry.y + Math.sin(entry.bearing!) * reach,
        ),
      getColor: (entry) => [...entry.color],
      getWidth: tier === "close" ? 6 : 4,
      widthUnits: "pixels",
      pickable: false,
    }),
  );

  if (tier === "mid") {
    layers.push(
      new ScatterplotLayer<SignalEntry>({
        id: "signals-disc",
        data: entries,
        getPosition: (entry) => entry.position,
        getRadius: 5.4,
        radiusUnits: "pixels",
        getFillColor: (entry) => [...entry.color],
        stroked: true,
        getLineColor: [255, 255, 255, Math.round(200 * opacity)],
        lineWidthUnits: "pixels",
        getLineWidth: 1.5,
        pickable: false,
      }),
    );
    return layers;
  }

  // Close: stop bar + crosswalk ticks + a lit lamp at the approach end.
  interface StopBar {
    path: LngLat[];
  }
  const stopBars: StopBar[] = [];
  const lamps: { position: LngLat; color: readonly [number, number, number, number] }[] = [];
  for (const entry of entries) {
    if (entry.bearing === null) {
      continue;
    }
    const geometry = stopBarGeometry([entry.x, entry.y], entry.bearing + Math.PI);
    stopBars.push({ path: geometry.bar.map(([x, y]) => toLngLat(projection, x, y)) });
    for (const tick of geometry.crosswalk) {
      stopBars.push({ path: tick.map(([x, y]) => toLngLat(projection, x, y)) });
    }
    lamps.push({
      position: toLngLat(projection, 
        entry.x + Math.cos(entry.bearing) * (reach - 6),
        entry.y + Math.sin(entry.bearing) * (reach - 6),
      ),
      color: [...entry.color],
    });
  }
  layers.push(
    new PathLayer<StopBar>({
      id: "signals-stopbars",
      data: stopBars,
      getPath: (bar) => bar.path,
      getColor: [255, 255, 255, Math.round(245 * opacity)],
      getWidth: 3,
      widthUnits: "pixels",
      pickable: false,
    }),
    new ScatterplotLayer<(typeof lamps)[number]>({
      id: "signals-lamps",
      data: lamps,
      getPosition: (lamp) => lamp.position,
      getRadius: 4,
      radiusUnits: "pixels",
      getFillColor: (lamp) => [...lamp.color],
      pickable: false,
    }),
    new ScatterplotLayer<SignalEntry>({
      id: "signals-base-close",
      data: entries,
      getPosition: (entry) => entry.position,
      getRadius: 6,
      radiusUnits: "pixels",
      getFillColor: [33, 29, 24, Math.round(210 * opacity)],
      pickable: false,
    }),
  );
  return layers;
}

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

export interface IncidentExtras {
  /** DOM plates rendered by the map component (bridges, events). */
  readonly plates: readonly { id: string; kind: string; x: number; y: number; label: string }[];
}

export function buildIncidentLayers(
  snapshot: PresentationSnapshot | null,
  model: MapModel,
  nowMs: number,
): { layers: Layer[]; extras: IncidentExtras } {
  const projection = model.projection;
  const layers: Layer[] = [];
  const plates: { id: string; kind: string; x: number; y: number; label: string }[] = [];
  if (!snapshot) {
    return { layers, extras: { plates } };
  }

  const closedPaths: LngLat[][] = [];
  const closedHatches: LngLat[][] = [];
  const closedBridgePaths: LngLat[][] = [];
  const closedRoundels: LngLat[] = [];
  const crashMarkers: { position: LngLat; x: number; y: number; bearing: number }[] = [];
  const crashDebris: LngLat[][] = [];
  const eventCenters: { position: LngLat; x: number; y: number }[] = [];
  const seen = new Set<string>();

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
    const converted = path.map(([x, y]) => toLngLat(projection, x, y));
    const isBridge = model.city.roads[roadId]?.kind === "bridge";
    if (isBridge) {
      closedBridgePaths.push(converted);
      const mid = path[Math.floor(path.length / 2)];
      closedRoundels.push(toLngLat(projection, mid[0], mid[1]));
      const piece = model.streets.find((candidate) => candidate.roadIds.includes(roadId));
      const name = piece?.bridge?.name ?? "Bridge";
      const already = plates.some((plate) => plate.label.startsWith(name));
      if (!already) {
        plates.push({ id: `bridge-${name}`, kind: "bridge-closed", x: mid[0], y: mid[1], label: `${name} closed` });
      }
    } else {
      closedPaths.push(converted);
      for (const segment of hatchSegments(path, 4, 5)) {
        closedHatches.push(segment.map(([x, y]) => toLngLat(projection, x, y)));
      }
      closedRoundels.push(toLngLat(projection, path[0][0], path[0][1]));
      closedRoundels.push(
        toLngLat(projection, path[path.length - 1][0], path[path.length - 1][1]),
      );
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
        const midIndex = Math.floor(path.length / 2);
        const mid = path[midIndex];
        const previous = path[Math.max(0, midIndex - 1)];
        const next = path[Math.min(path.length - 1, midIndex + 1)];
        const bearing = Math.atan2(next[1] - previous[1], next[0] - previous[0]);
        crashMarkers.push({
          position: toLngLat(projection, mid[0], mid[1]),
          x: mid[0],
          y: mid[1],
          bearing,
        });
        // Debris ticks perpendicular to the road: "lane blocked", not "red dot".
        const px = -Math.sin(bearing);
        const py = Math.cos(bearing);
        for (const offset of [-7, 7]) {
          crashDebris.push([
            toLngLat(projection, mid[0] + px * offset - Math.cos(bearing) * 3, mid[1] + py * offset - Math.sin(bearing) * 3),
            toLngLat(projection, mid[0] + px * offset + Math.cos(bearing) * 3, mid[1] + py * offset + Math.sin(bearing) * 3),
          ]);
        }
      }
    } else if (incident.kind === "event-release" && incident.eventCenterIntersectionId !== null) {
      const center = model.city.intersections[incident.eventCenterIntersectionId];
      if (center) {
        eventCenters.push({ position: toLngLat(projection, center.x, center.y), x: center.x, y: center.y });
        plates.push({
          id: `event-${incident.id}`,
          kind: "event-release",
          x: center.x,
          y: center.y - 40,
          label: "Event lets out",
        });
      }
    }
  }

  const eventBearings = eventCenters.flatMap((center) => {
    const node = model.city.intersections.find(
      (intersection) => intersection.x === center.x && intersection.y === center.y,
    );
    if (!node) {
      return [];
    }
    return node.outgoing.slice(0, 6).map((roadId) => {
      const road = model.city.roads[roadId];
      const to = model.city.intersections[road.to];
      return Math.atan2(to.y - node.y, to.x - node.x);
    });
  });
  const arrows = eventCenters.flatMap((center) =>
    egressArrows([center.x, center.y], eventBearings).map((arrow) => ({
      source: toLngLat(projection, arrow.source[0], arrow.source[1]),
      target: toLngLat(projection, arrow.target[0], arrow.target[1]),
    })),
  );

  const pulse = (nowMs % 1400) / 1400;

  if (closedPaths.length > 0) {
    layers.push(
      new PathLayer<LngLat[]>({
        id: "closed-roads",
        data: closedPaths,
        getPath: (path) => path,
        getColor: [200, 64, 44, 210],
        getWidth: 9,
        widthUnits: "pixels",
        capRounded: true,
        pickable: false,
      }),
      new PathLayer<LngLat[]>({
        id: "closed-roads-hatch",
        data: closedHatches,
        getPath: (path) => path,
        getColor: [255, 253, 249, 220],
        getWidth: 2,
        widthUnits: "pixels",
        pickable: false,
      }),
    );
  }
  if (closedBridgePaths.length > 0) {
    layers.push(
      new PathLayer<LngLat[]>({
        id: "closed-bridges",
        data: closedBridgePaths,
        getPath: (path) => path,
        getColor: [176, 57, 43, 235],
        getWidth: 12,
        widthUnits: "pixels",
        capRounded: true,
        pickable: false,
      }),
    );
  }
  if (closedRoundels.length > 0) {
    layers.push(
      new ScatterplotLayer<LngLat>({
        id: "closed-roundels",
        data: closedRoundels,
        getPosition: (position) => position,
        getRadius: 6,
        radiusUnits: "pixels",
        getFillColor: [255, 253, 249, 250],
        stroked: true,
        getLineColor: [176, 57, 43, 250],
        lineWidthUnits: "pixels",
        getLineWidth: 2.5,
        pickable: false,
      }),
    );
  }
  if (eventCenters.length > 0) {
    layers.push(
      new ScatterplotLayer<{ position: LngLat }>({
        id: "event-rings",
        data: eventCenters,
        getPosition: (center) => center.position,
        getRadius: 30 + pulse * 26,
        radiusUnits: "pixels",
        stroked: true,
        filled: false,
        getLineColor: [111, 102, 232, Math.round(200 - pulse * 120)],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
        pickable: false,
      }),
      new LineLayer<{ source: LngLat; target: LngLat }>({
        id: "event-arrows",
        data: arrows,
        getSourcePosition: (arrow) => arrow.source,
        getTargetPosition: (arrow) => arrow.target,
        getColor: [111, 102, 232, 190],
        getWidth: 2.5,
        widthUnits: "pixels",
        pickable: false,
      }),
    );
  }
  if (crashMarkers.length > 0) {
    layers.push(
      new LineLayer<LngLat[]>({
        id: "crash-debris",
        data: crashDebris,
        getSourcePosition: (line) => line[0],
        getTargetPosition: (line) => line[1],
        getColor: [33, 29, 24, 150],
        getWidth: 1.5,
        widthUnits: "pixels",
        pickable: false,
      }),
      new ScatterplotLayer<(typeof crashMarkers)[number]>({
        id: "crash-markers",
        data: crashMarkers,
        getPosition: (marker) => marker.position,
        getRadius: 8,
        radiusUnits: "pixels",
        getFillColor: [176, 57, 43, 245],
        stroked: true,
        getLineColor: [255, 253, 249, 250],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
        pickable: false,
      }),
      new PolygonLayer<{ polygon: LngLat[] }>({
        id: "crash-chevrons",
        data: crashMarkers.map((marker) => ({
          polygon: [
            toLngLat(projection, marker.x - 2.5, marker.y - 2.5),
            toLngLat(projection, marker.x + 2.5, marker.y + 2.5),
            toLngLat(projection, marker.x + 2.5, marker.y + 1.2),
            toLngLat(projection, marker.x - 1.2, marker.y - 2.5),
          ],
        })),
        getPolygon: (entry) => entry.polygon,
        getFillColor: [255, 253, 249, 235],
        pickable: false,
      }),
    );
  }

  return { layers, extras: { plates } };
}
