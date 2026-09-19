/**
 * deck.gl dynamic layers (Task 11 polish pass): vehicles, signals and incident
 * overlays, rebuilt each animation frame from the bounded 5 Hz presentation
 * snapshot (interpolated). The GPU draws everything — no DOM per vehicle.
 *
 * Presentation rule: the basemap supplies context; simulation state supplies
 * meaning. Vehicles carry class identity, congestion lives on the road, and
 * signals communicate right-of-way directly at the stop line.
 */
import type { Layer } from "@deck.gl/core";
import { IconLayer, LineLayer, PathLayer, PolygonLayer, ScatterplotLayer } from "@deck.gl/layers";
import type { DirectedPathIndexes } from "./map-geometry";
import { applyLaneOffset } from "./map-geometry";
import type { MapModel } from "@/cities/map-model";
import { CONGESTION_COLORS, type RoadPressure } from "./congestion";
import {
  VEHICLE_LENGTH_M,
  carriagewayPairs,
  directionalLanes,
  laneCentreOffsetMetres,
  LANE_WIDTH_M,
  stopLineSetbackMetres,
  widthMetresForRoad,
  widthPxAt,
} from "./road-presentation";
import {
  SIGNAL_HEAD_MINZOOM,
  SIGNAL_STATE_MINZOOM,
  VEHICLE_MINZOOM,
} from "./zoom-grammar";
import { samplePathIndex } from "@/cities/paths";
import { deriveApproachGroups } from "@/sim/signals";
import type { RoadId } from "@/sim/types";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { RenderedVehicle } from "./interpolate";
import { metricToLngLat, type Projection } from "@/cities/map-model";
import {
  hatchSegments,
  signalGateBackingWidthPx,
  signalGateWidthPx,
  signalTierOpacity,
} from "./visuals";
import { iconSizeForLengthUnits } from "./vehicle-sprites";
import { roadPresentationClass } from "./road-hierarchy";
import {
  signalSpriteForStage,
  type SignalSpriteId,
  type SignalSpriteSet,
} from "./signal-sprites";
import type { VehicleIconSet } from "./vehicle-icons";

export type LngLat = [number, number];

/** Local metres -> WGS84 through the model's projection. */
export function toLngLat(projection: Projection, x: number, y: number): LngLat {
  return metricToLngLat(projection, x, y);
}

export interface SignalArm {
  /** One representative directed road for a physical approach arm. */
  readonly roadId: number;
  /** Travel bearing into the intersection, radians. */
  readonly bearing: number;
  /** Centre of this direction's lane group, metres to the right of centreline. */
  readonly laneOffsetM: number;
  /** Half-width of the incoming lane group, not the entire two-way road. */
  readonly halfWidthM: number;
}

export interface SignalPlanEntry {
  readonly intersectionId: number;
  readonly x: number;
  readonly y: number;
  /** Mean bearing (radians) of each phase group, in phase order. */
  readonly groupBearings: readonly number[];
  /** Raw simulation roads, preserved for phase semantics/debugging. */
  readonly groupIncoming: readonly (readonly number[])[];
  /**
   * Presentation arms for each phase group. Several raw OSM roads that arrive
   * from effectively the same bearing collapse to one arm, preventing the
   * black "signal hedgehog" clusters that made intersections unreadable.
   */
  readonly groupArms: readonly (readonly SignalArm[])[];
}

function roadBearing(model: MapModel, roadId: RoadId): number {
  const road = model.city.roads[roadId];
  const from = model.city.intersections[road.from];
  const to = model.city.intersections[road.to];
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function meanBearing(model: MapModel, roads: readonly RoadId[]): number {
  let sx = 0;
  let sy = 0;
  for (const roadId of roads) {
    const bearing = roadBearing(model, roadId);
    sx += Math.cos(bearing);
    sy += Math.sin(bearing);
  }
  return Math.atan2(sy, sx);
}

// OSM often splits one physical approach into several near-parallel directed
// pieces. 24° is wide enough to collapse those artifacts while keeping true
// orthogonal/Y-junction approaches distinct.
const SIGNAL_ARM_MERGE_RAD = (24 * Math.PI) / 180;

function bearingDistance(a: number, b: number): number {
  const full = Math.PI * 2;
  const diff = Math.abs(a - b) % full;
  return Math.min(diff, full - diff);
}

function presentationArms(
  model: MapModel,
  roads: readonly RoadId[],
  pairs: ReturnType<typeof carriagewayPairs>,
): SignalArm[] {
  const candidates = roads
    .filter((roadId) => {
      if (!model.city.roads[roadId]) {
        return false;
      }
      const pieceIndex = pairs.pieceOf[roadId] ?? -1;
      const piece = pieceIndex >= 0 ? model.streets[pieceIndex] : undefined;
      return !piece || roadPresentationClass(piece) !== "hidden";
    })
    .map((roadId) => {
      const lanes = directionalLanes(model, roadId);
      return {
        roadId,
        bearing: roadBearing(model, roadId),
        laneOffsetM: laneCentreOffsetMetres(model, roadId, pairs),
        halfWidthM: Math.max(1.5, (lanes * LANE_WIDTH_M) / 2),
        carriagewayWidthM: widthMetresForRoad(model, roadId, pairs),
        lanes,
      };
    })
    .sort((a, b) => a.bearing - b.bearing || a.roadId - b.roadId);

  const clusters: typeof candidates[] = [];
  for (const candidate of candidates) {
    const target = clusters.find((cluster) =>
      cluster.some((member) => bearingDistance(member.bearing, candidate.bearing) <= SIGNAL_ARM_MERGE_RAD),
    );
    if (target) {
      target.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }

  return clusters
    .map((cluster) =>
      [...cluster].sort(
        (a, b) =>
          b.carriagewayWidthM - a.carriagewayWidthM ||
          b.lanes - a.lanes ||
          a.roadId - b.roadId,
      )[0],
    )
    .map(({ roadId, bearing, laneOffsetM, halfWidthM }) => ({
      roadId,
      bearing,
      laneOffsetM,
      halfWidthM,
    }));
}

/** Precomputed per-intersection phase geometry (built once per compiled scale). */
export function buildSignalPlans(model: MapModel): Map<number, SignalPlanEntry> {
  const plans = new Map<number, SignalPlanEntry>();
  const pairs = carriagewayPairs(model);
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
      groupArms: groups.map((roads) => presentationArms(model, roads, pairs)),
    });
  }
  return plans;
}

const SIGNAL_GATE_COLORS: Record<SignalSpriteId, [number, number, number, number]> = {
  "signal-red": [188, 63, 52, 235],
  "signal-yellow": [207, 146, 45, 235],
  "signal-green": [55, 137, 83, 235],
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
 * Vehicle visibility is binary by zoom: once the camera is close enough to
 * render individual traffic, every active vehicle is drawn. Deterministic
 * sub-sampling made cars appear/disappear while zooming and destroyed the sense
 * of one coherent traffic system.
 */
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
  const visible = vehicles;
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
        // Physical vehicle size in map metres. This is the missing zoom
        // contract: a 4.6 m car grows on screen as the camera descends instead
        // of staying a ~14 px annotation forever.
        getSize: iconSizeForLengthUnits(type, VEHICLE_LENGTH_M[type]),
        getAngle: (vehicle) => (vehicle.headingRadians * 180) / Math.PI,
        sizeUnits: "meters",
        sizeMinPixels: type === "bicycle" ? 10 : type === "truck" ? 18 : 14,
        sizeMaxPixels: type === "bicycle" ? 34 : type === "truck" ? 80 : 56,
        billboard: false,
        pickable: false,
      }),
    );
  }
  // Waiting is encoded by queue position and the road-level congestion layer.
  // No circles, halos or heat rings are drawn around vehicles: those made the
  // fleet read like debug particles instead of cars, trucks and bicycles.
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
  sprites: SignalSpriteSet | null = null,
): Layer[] {
  if (!snapshot || zoom < SIGNAL_STATE_MINZOOM) {
    return [];
  }
  const opacity = signalTierOpacity(zoom);

  interface Head {
    position: LngLat;
    sprite: SignalSpriteId;
  }
  interface Bar {
    path: LngLat[];
    sprite: SignalSpriteId;
  }
  interface Glyph {
    cx: number;
    cy: number;
    bearing: number;
    bar: Bar;
    head: Head | null;
  }

  const raw: Glyph[] = [];
  for (const signal of snapshot.signals) {
    const plan = plans.get(signal.intersectionId);
    if (!plan || plan.groupIncoming.length === 0) {
      continue;
    }
    const groupCount = plan.groupIncoming.length;
    const activeGroup =
      signal.stage === "all-red" ? -1 : ((signal.phaseIndex % groupCount) + groupCount) % groupCount;

    plan.groupArms.forEach((arms, groupIndex) => {
      const sprite = signalSpriteForStage(signal.stage, groupIndex === activeGroup);
      for (const arm of arms) {
        const index = indexes[arm.roadId];
        const setbackM = stopLineSetbackMetres(directionalLanes(model, arm.roadId));
        if (!index || index.total < setbackM + 1) {
          continue;
        }

        const stopProgress = index.total - setbackM;
        const sample = samplePathIndex(index, stopProgress);
        const laneCenter = applyLaneOffset(sample, arm.laneOffsetM);
        const nx = -Math.sin(sample.heading);
        const ny = Math.cos(sample.heading);
        const bar: Bar = {
          sprite,
          path: [
            toLngLat(
              projection,
              laneCenter.x - nx * arm.halfWidthM,
              laneCenter.y - ny * arm.halfWidthM,
            ),
            toLngLat(
              projection,
              laneCenter.x + nx * arm.halfWidthM,
              laneCenter.y + ny * arm.halfWidthM,
            ),
          ],
        };

        let head: Head | null = null;
        if (zoom >= SIGNAL_HEAD_MINZOOM) {
          const headSample = applyLaneOffset(
            samplePathIndex(index, Math.min(index.total, stopProgress + 0.35)),
            arm.laneOffsetM + arm.halfWidthM + 1.65,
          );
          head = {
            position: toLngLat(projection, headSample.x, headSample.y),
            sprite,
          };
        }
        raw.push({ cx: laneCenter.x, cy: laneCenter.y, bearing: sample.heading, bar, head });
      }
    });
  }

  // Chicago OSM can encode one physical signalized approach as several nearby
  // logical nodes. Rendering every node produces the stacked red/green ladders
  // visible in the screenshots. Collapse only near-identical DIRECTIONAL
  // approaches; opposite directions remain distinct.
  const deduped: Glyph[] = [];
  const directionGap = (a: number, b: number) => {
    const full = Math.PI * 2;
    const d = Math.abs(a - b) % full;
    return Math.min(d, full - d);
  };
  const stateRank: Record<SignalSpriteId, number> = {
    "signal-red": 3,
    "signal-yellow": 2,
    "signal-green": 1,
  };
  for (const glyph of raw) {
    const match = deduped.find(
      (candidate) =>
        Math.hypot(candidate.cx - glyph.cx, candidate.cy - glyph.cy) <= 12 &&
        directionGap(candidate.bearing, glyph.bearing) <= (18 * Math.PI) / 180,
    );
    if (!match) {
      deduped.push(glyph);
      continue;
    }
    // When duplicate logical nodes disagree for a frame, use the restrictive
    // state. One physical stop line must never simultaneously look red+green.
    if (stateRank[glyph.bar.sprite] > stateRank[match.bar.sprite]) {
      match.bar = glyph.bar;
      match.head = glyph.head;
    }
  }

  const bars = deduped.map((glyph) => glyph.bar);
  const heads = deduped.flatMap((glyph) => (glyph.head ? [glyph.head] : []));
  const layers: Layer[] = [];

  if (bars.length > 0) {
    layers.push(
      new PathLayer<Bar>({
        id: "signals-state-gate-backing",
        data: bars,
        getPath: (bar) => bar.path,
        getColor: [52, 55, 58, Math.round(205 * opacity)],
        getWidth: signalGateBackingWidthPx(zoom),
        widthUnits: "pixels",
        capRounded: true,
        pickable: false,
        updateTriggers: { getWidth: zoom },
      }),
      new PathLayer<Bar>({
        id: "signals-state-gates",
        data: bars,
        getPath: (bar) => bar.path,
        getColor: (bar) => {
          const [r, g, b, a] = SIGNAL_GATE_COLORS[bar.sprite];
          return [r, g, b, Math.round(a * opacity)];
        },
        getWidth: signalGateWidthPx(zoom),
        widthUnits: "pixels",
        capRounded: true,
        pickable: false,
        updateTriggers: { getWidth: zoom },
      }),
    );
  }

  if (heads.length > 0 && sprites) {
    layers.push(
      new IconLayer<Head>({
        id: "signals-heads",
        data: heads,
        iconAtlas: sprites.atlas,
        iconMapping: sprites.mapping,
        getIcon: (head) => head.sprite,
        getPosition: (head) => head.position,
        // Signal heads are semantic instrumentation, not literal street
        // furniture. Size them in map space so they grow as the camera descends,
        // with generous pixel bounds so the state remains obvious.
        getSize: 7.5,
        getAngle: 0,
        opacity,
        sizeUnits: "meters",
        sizeMinPixels: 30,
        sizeMaxPixels: 72,
        billboard: true,
        pickable: false,
      }),
    );
  }

  return layers;
}

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

export interface IncidentExtras {
  /** DOM plates rendered by the map component (bridges, events). */
  readonly plates: readonly { id: string; kind: string; x: number; y: number; label: string }[];
  /**
   * Metric anchor of the first active crash, if any. Crashes draw as deck
   * geometry (no DOM plate), so this is what lets the dev camera hook frame one
   * for a screenshot. Never rendered.
   */
  readonly crash: { x: number; y: number } | null;
}

export function buildIncidentLayers(
  snapshot: PresentationSnapshot | null,
  model: MapModel,
): { layers: Layer[]; extras: IncidentExtras } {
  const projection = model.projection;
  const layers: Layer[] = [];
  const plates: { id: string; kind: string; x: number; y: number; label: string }[] = [];
  if (!snapshot) {
    return { layers, extras: { plates, crash: null } };
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
        const closureLabel = name.length > 28 ? "Road closed" : `${name} closed`;
        plates.push({ id: `bridge-${name}`, kind: "bridge-closed", x: mid[0], y: mid[1], label: closureLabel });
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
        getColor: [176, 57, 43, 175],
        getWidth: 5,
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
        getColor: [176, 57, 43, 195],
        getWidth: 7,
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
        getRadius: 4,
        radiusUnits: "pixels",
        getFillColor: [255, 253, 249, 250],
        stroked: true,
        getLineColor: [176, 57, 43, 250],
        lineWidthUnits: "pixels",
        getLineWidth: 1.5,
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
        // Sized to read at neighborhood zoom: a 4 px dot vanished into the
        // basemap, and an incident marker nobody can see is not a marker.
        getRadius: 5,
        radiusUnits: "pixels",
        filled: true,
        getFillColor: [176, 126, 68, 240],
        stroked: true,
        getLineColor: [255, 253, 249, 245],
        lineWidthUnits: "pixels",
        getLineWidth: 2,
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
        getRadius: 6,
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

  return { layers, extras: { plates, crash: crashMarkers[0] ? { x: crashMarkers[0].x, y: crashMarkers[0].y } : null } };
}
