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
import type { DirectedPathIndexes } from "./map-geometry";
import { applyLaneOffset } from "./map-geometry";
import { LANE_WIDTH_M, type MapModel } from "@/cities/map-model";
import { CONGESTION_COLORS, type RoadPressure } from "./congestion";
import { widthPxAt } from "./road-presentation";
import {
  CLOSE_TIER_MINZOOM,
  CROSSWALK_MINZOOM,
  VEHICLE_MINZOOM,
  WAIT_HEAT_MINZOOM,
} from "./zoom-grammar";
import { samplePathIndex } from "@/cities/paths";
import { deriveApproachGroups } from "@/sim/signals";
import type { RoadId } from "@/sim/types";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { RenderedVehicle } from "./interpolate";
import { metricToLngLat, type Projection } from "@/cities/map-model";
import { waitHeatBucket, WAIT_HEAT_COLORS } from "./map-geometry";
import {
  hatchSegments,
  signalTierOpacity,
  vehicleLengthPx,
} from "./visuals";
import { iconSizeForLengthPx } from "./vehicle-sprites";
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
  /**
   * Incoming road ids per approach group, in phase order. Signal heads are
   * placed on these real approaches, at their stop lines, rather than at a
   * single dot in the middle of the junction.
   */
  readonly groupIncoming: readonly (readonly number[])[];
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
      groupIncoming: groups.map((roads) => [...roads]),
    });
  }
  return plans;
}

/** Stop line sits this far before the junction, on the real approach. */
const SIGNAL_STOP_BAR_OFFSET_M = 3.2;

const SIGNAL_COLORS = {
  green: [47, 138, 85, 235] as const,
  yellow: [201, 138, 43, 235] as const,
  "all-red": [178, 58, 44, 235] as const,
};

/* ------------------------------------------------------------------ */
/* Congestion                                                          */
/* ------------------------------------------------------------------ */

export interface CongestionRoad {
  readonly roadId: number;
  readonly path: readonly LngLat[];
  /** Physical width in metres, so the overlay matches the road it covers. */
  readonly widthM: number;
}

/**
 * Far/mid-zoom congestion: only roads under real pressure are drawn, at their
 * own physical width, in restrained amber/orange/red. This is what replaces
 * per-vehicle detail when the camera pulls back.
 */
export function buildCongestionLayers(
  roads: readonly CongestionRoad[],
  pressure: readonly RoadPressure[],
  zoom: number,
): Layer[] {
  if (pressure.length === 0) {
    return [];
  }
  const byId = new Map(roads.map((road) => [road.roadId, road]));
  const data = pressure
    .map((entry) => ({ entry, road: byId.get(entry.roadId) }))
    .filter((item): item is { entry: RoadPressure; road: CongestionRoad } => !!item.road?.path.length);
  if (data.length === 0) {
    return [];
  }
  return [
    new PathLayer<(typeof data)[number]>({
      id: "road-congestion",
      data,
      getPath: (item) => item.road.path as unknown as LngLat[],
      getColor: (item) => [...CONGESTION_COLORS[item.entry.level]],
      getWidth: (item) => Math.max(1.4, widthPxAt(zoom, item.road.widthM)),
      widthUnits: "pixels",
      pickable: false,
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* Vehicles                                                            */
/* ------------------------------------------------------------------ */

/**
 * Deterministic sampling: how much of the fleet is worth drawing at a zoom.
 * Below close zoom a thousand equally prominent cars is confetti, so the
 * population thins with distance — but a queued or badly blocked vehicle is
 * never sampled out, because that is the information the frame is carrying.
 */
export function vehicleSampleRatio(zoom: number): number {
  if (zoom >= 16) {
    return 1;
  }
  if (zoom >= 15) {
    return 0.6;
  }
  if (zoom >= 14) {
    return 0.25;
  }
  return 0.08;
}

/** Stable hash, so the same vehicle is drawn or hidden frame after frame. */
function vehicleHash(id: number): number {
  let value = (id * 2654435761) >>> 0;
  value ^= value >>> 13;
  value = (value * 1274126177) >>> 0;
  return (value ^ (value >>> 16)) >>> 0;
}

export function sampleVehicles(
  vehicles: readonly RenderedVehicle[],
  zoom: number,
): RenderedVehicle[] {
  const ratio = vehicleSampleRatio(zoom);
  if (ratio >= 1) {
    return [...vehicles];
  }
  const threshold = Math.round(ratio * 0xffffffff);
  return vehicles.filter(
    (vehicle) => vehicle.blockedWaitMs > 0 || vehicleHash(vehicle.id) < threshold,
  );
}

export function buildVehicleLayers(
  projection: Projection,
  vehicles: readonly RenderedVehicle[],
  icons: VehicleIconSet,
  zoom: number,
): Layer[] {
  if (vehicles.length === 0 || zoom < VEHICLE_MINZOOM) {
    // Far zoom is the congestion overlay's job: individual glyphs there were
    // visual noise rather than information.
    return [];
  }
  const visible = sampleVehicles(vehicles, zoom);
  // Glyph length in pixels per class, at this zoom: a car stays a car and a
  // truck stays a truck instead of every class shrinking together.
  const lengthPx = (type: RenderedVehicle["type"]) => vehicleLengthPx(type, zoom);
  const layers: Layer[] = [];
  // One layer per class (three at most, not the seven wait-heat buckets this
  // used to split into): the sprite already carries the class silhouette and
  // its restrained body colour, so nothing is tinted per frame.
  for (const type of ["car", "truck", "bicycle"] as const) {
    const group = visible.filter((vehicle) => vehicle.type === type);
    if (group.length === 0) {
      continue;
    }
    layers.push(
      new IconLayer<RenderedVehicle>({
        id: `vehicle-body-${type}`,
        data: group,
        iconAtlas: icons.atlas,
        iconMapping: icons.mapping,
        getIcon: () => type,
        getPosition: (vehicle) => toLngLat(projection, vehicle.x, vehicle.y),
        getSize: iconSizeForLengthPx(type, lengthPx(type)),
        getAngle: (vehicle) => (vehicle.headingRadians * 180) / Math.PI,
        sizeUnits: "pixels",
        billboard: false,
        pickable: false,
        updateTriggers: { getSize: zoom },
      }),
    );
  }
  // Wait state: a thin outline on a blocked vehicle, close zoom only. No halo,
  // no pulsing, no recoloured body — the road-level congestion overlay is the
  // macro signal, and this is a whisper for the one vehicle you are watching.
  if (zoom >= WAIT_HEAT_MINZOOM) {
    const waiting = visible.filter((vehicle) => vehicle.blockedWaitMs > 0);
    if (waiting.length > 0) {
      layers.push(
        new ScatterplotLayer<RenderedVehicle>({
          id: "vehicle-wait-outline",
          data: waiting,
          getPosition: (vehicle) => toLngLat(projection, vehicle.x, vehicle.y),
          getRadius: (vehicle) => iconSizeForLengthPx(vehicle.type, lengthPx(vehicle.type)) * 0.42,
          radiusUnits: "pixels",
          stroked: true,
          filled: false,
          getLineColor: (vehicle) => {
            const bucket = waitHeatBucket(vehicle.blockedWaitMs);
            const [r, g, b] = WAIT_HEAT_COLORS[Math.min(bucket, WAIT_HEAT_COLORS.length - 1)];
            return [r, g, b, bucket >= 4 ? 150 : 90];
          },
          getLineWidth: 1,
          lineWidthUnits: "pixels",
          pickable: false,
          updateTriggers: {
            getLineColor: waiting.map((vehicle) => vehicle.blockedWaitMs).join(","),
          },
        }),
      );
    }
  }
  return layers;
}

/* ------------------------------------------------------------------ */
/* Signals                                                             */
/* ------------------------------------------------------------------ */


export function buildSignalLayers(
  projection: Projection,
  model: MapModel,
  snapshot: PresentationSnapshot | null,
  plans: Map<number, SignalPlanEntry>,
  indexes: DirectedPathIndexes,
  zoom: number,
  housing: VehicleIconSet | null = null,
): Layer[] {
  // Signals are a street-zoom instrument. At far and mid zoom this returns
  // nothing at all: a city-wide field of coloured dots is debug state, and
  // congestion is carried by the road overlay instead. There is never a glyph
  // in the middle of a junction — heads sit on the real approaches.
  if (!snapshot || zoom < CLOSE_TIER_MINZOOM) {
    return [];
  }
  const opacity = signalTierOpacity(zoom);
  const crosswalks = zoom >= CROSSWALK_MINZOOM;

  interface Head {
    position: LngLat;
    color: readonly [number, number, number, number];
    /** Bearing of the approach, so the housing faces the traffic it controls. */
    bearing: number;
  }
  interface Bar {
    path: LngLat[];
  }
  const heads: Head[] = [];
  const bars: Bar[] = [];

  for (const signal of snapshot.signals) {
    const plan = plans.get(signal.intersectionId);
    if (!plan || plan.groupIncoming.length === 0) {
      continue;
    }
    const groupCount = plan.groupIncoming.length;
    const activeGroup =
      signal.stage === "all-red" ? -1 : ((signal.phaseIndex % groupCount) + groupCount) % groupCount;
    plan.groupIncoming.forEach((roads, groupIndex) => {
      // The active group shows its own colour; every other approach reads red.
      const base = groupIndex === activeGroup ? SIGNAL_COLORS[signal.stage] : SIGNAL_COLORS["all-red"];
      const color = [base[0], base[1], base[2], Math.round(base[3] * opacity)] as const;
      for (const roadId of roads) {
        const index = indexes[roadId];
        const road = model.city.roads[roadId];
        if (!index || !road || index.total < SIGNAL_STOP_BAR_OFFSET_M + 1) {
          continue;
        }
        const stopProgress = index.total - SIGNAL_STOP_BAR_OFFSET_M;
        const sample = samplePathIndex(index, stopProgress);
        const halfWidth = Math.max(1.4, (road.lanes * LANE_WIDTH_M) / 2);
        // Stop bar across this approach, sized to the approach's own lanes.
        const nx = -Math.sin(sample.heading);
        const ny = Math.cos(sample.heading);
        bars.push({
          path: [
            toLngLat(projection, sample.x - nx * halfWidth, sample.y - ny * halfWidth),
            toLngLat(projection, sample.x + nx * halfWidth, sample.y + ny * halfWidth),
          ],
        });
        if (crosswalks) {
          const offset = SIGNAL_STOP_BAR_OFFSET_M + 1.4;
          const walkProgress = Math.max(0, index.total - offset);
          const walk = samplePathIndex(index, walkProgress);
          bars.push({
            path: [
              toLngLat(projection, walk.x - nx * halfWidth, walk.y - ny * halfWidth),
              toLngLat(projection, walk.x + nx * halfWidth, walk.y + ny * halfWidth),
            ],
          });
        }
        // The head itself: kerbside of the approach, just before the stop line.
        const headSample = applyLaneOffset(
          samplePathIndex(index, Math.max(0, stopProgress - 1.5)),
          halfWidth + 1.2,
        );
        heads.push({
          position: toLngLat(projection, headSample.x, headSample.y),
          color,
          bearing: sample.heading,
        });
      }
    });
  }

  const layers: Layer[] = [];
  if (bars.length > 0) {
    layers.push(
      new PathLayer<Bar>({
        id: "signals-stopbars",
        data: bars,
        getPath: (bar) => bar.path,
        // Stop bars sit on a near-white road surface, so they read as a dark
        // neutral line rather than a white one that disappears into the casing.
        getColor: [120, 112, 98, Math.round(190 * opacity)],
        getWidth: crosswalks ? 2 : 3,
        widthUnits: "pixels",
        pickable: false,
      }),
    );
  }
  if (heads.length > 0) {
    // The head is a housing with ONE bright lamp — the active stage — plus dim
    // companions at the closest zoom. A large filled circle at the junction
    // (what this was) is instrumentation, not a traffic signal.
    // The housing is decoration; the lamps carry the state, so signals still
    // render when there is no sprite atlas (no DOM).
    if (housing) {
      layers.push(
        new IconLayer<Head>({
          id: "signals-housings",
          data: heads,
          iconAtlas: housing.atlas,
          iconMapping: housing.mapping,
          getIcon: () => "car",
          getPosition: (head) => head.position,
          getSize: 7,
          getAngle: (head) => (head.bearing * 180) / Math.PI,
          sizeUnits: "pixels",
          billboard: false,
          pickable: false,
        }),
      );
    }
    layers.push(
      new ScatterplotLayer<Head>({
        id: "signals-lamps",
        data: heads,
        getPosition: (head) => head.position,
        getRadius: 1.5,
        radiusUnits: "pixels",
        getFillColor: (head) => [...head.color],
        pickable: false,
      }),
    );
    if (zoom >= 16.8) {
      // Full housing: the two lamps that are not lit, barely there.
      layers.push(
        new ScatterplotLayer<Head>({
          id: "signals-lamps-idle",
          data: heads,
          getPosition: (head) => head.position,
          getRadius: 1.1,
          radiusUnits: "pixels",
          getFillColor: [90, 88, 82, 120],
          pickable: false,
        }),
      );
    }
  }
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
      // A closed bridge closes the whole LOGICAL crossing, not one OSM piece:
      // every directed road carrying the same bridge name is part of the same
      // structure, and the band must cover all of it or the closure looks like
      // a random 14 m fragment.
      const piece = model.streets.find((candidate) => candidate.roadIds.includes(roadId));
      const name = piece?.bridge?.name ?? "Bridge";
      for (const candidate of model.streets) {
        if ((candidate.bridge?.name ?? null) !== name || name === "Bridge") {
          continue;
        }
        for (const memberId of candidate.roadIds) {
          const memberPath = model.directedPaths[memberId];
          if (!memberPath || memberPath.length < 2) {
            continue;
          }
          const memberKey = `${memberPath[0][0]}|${memberPath[0][1]}|${memberPath[memberPath.length - 1][0]}|${memberPath[memberPath.length - 1][1]}`;
          if (seen.has(memberKey)) {
            continue;
          }
          seen.add(memberKey);
          closedBridgePaths.push(memberPath.map(([x, y]) => toLngLat(projection, x, y)));
        }
      }
      const mid = path[Math.floor(path.length / 2)];
      closedRoundels.push(toLngLat(projection, mid[0], mid[1]));
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
    // An event is a place, not an effect: a small static badge on the venue.
    // The pulsing ring and the violet egress arrows that used to be here read as
    // a game ability; the traffic emerging on the surrounding streets is the
    // real feedback, and the plate names the venue.
    layers.push(
      new ScatterplotLayer<{ position: LngLat }>({
        id: "event-badges",
        data: eventCenters,
        getPosition: (center) => center.position,
        getRadius: 4,
        radiusUnits: "pixels",
        filled: true,
        getFillColor: [176, 126, 68, 235],
        stroked: true,
        getLineColor: [255, 253, 249, 240],
        lineWidthUnits: "pixels",
        getLineWidth: 1.4,
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
