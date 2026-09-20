import type { Layer } from "@deck.gl/core";
import { IconLayer } from "@deck.gl/layers";
import { LineLayer } from "@deck.gl/layers";
import { PathLayer } from "@deck.gl/layers";
import { PolygonLayer } from "@deck.gl/layers";
import { ScatterplotLayer } from "@deck.gl/layers";
import type { MapModel } from "@/cities/map-model";
import { CONGESTION_COLORS } from "./congestion";
import type { RoadPressure } from "./congestion";
import { VEHICLE_LENGTH_M } from "./road-presentation";
import { roadVisualScaleAt } from "./road-presentation";
import { VEHICLE_MINZOOM } from "./zoom-grammar";
import type { PresentationSnapshot } from "@/worker/presentation-snapshot";
import type { RenderedVehicle } from "./interpolate";
import type { Projection } from "@/cities/map-model";
import { metricToLngLat } from "@/cities/map-model";
import { hatchSegments } from "./visuals";
import { iconSizeForLengthUnits } from "./vehicle-sprites";
import { EGO_SCALE } from "./scale";
import type { VehicleIconSet } from "./vehicle-icons";

export type LngLat = [number, number];

/** Local metres -> WGS84 through the model's projection. */
export function toLngLat(projection: Projection, x: number, y: number): LngLat {
  return metricToLngLat(projection, x, y);
}

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
  // Road ids are dense/index-aligned in the compiled Chicago model. Use
  // direct indexed lookup here: this function runs at display rate and should
  // not allocate a 5k-entry Map on every animation frame.
  const data = pressure
    .map((entry) => {
      const candidate = roads[entry.roadId];
      const road = candidate?.roadId === entry.roadId ? candidate : undefined;
      return { entry, road };
    })
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
      // Traffic mode is a centre stripe over the authored road, not a second
      // full-width road surface. This keeps the city readable while making
      // moving/slow/heavy background traffic visible at every challenge zoom.
      getWidth: (item) =>
        Math.max(2.2, Math.min(6.5, item.road.widthM * 0.34)) *
        roadVisualScaleAt(zoom),
      widthUnits: "meters",
      widthMinPixels: 1.25,
      widthMaxPixels: 28,
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
        // The ego is intentionally oversized enough to track at a glance,
        // while remaining a map-space object that grows naturally with zoom.
        getSize: iconSizeForLengthUnits(
          type,
          VEHICLE_LENGTH_M[type] * EGO_SCALE.lengthScale,
        ),
        getAngle: (vehicle) => (vehicle.headingRadians * 180) / Math.PI,
        sizeUnits: "meters",
        sizeMinPixels: EGO_SCALE.minPixelsByClass[type],
        sizeMaxPixels: EGO_SCALE.maxPixelsByClass[type],
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
        getWidth: 5.5,
        widthUnits: "meters",
        widthMinPixels: 4,
        widthMaxPixels: 30,
        capRounded: true,
        pickable: false,
      }),
      new PathLayer<LngLat[]>({
        id: "closed-roads-hatch",
        data: closedHatches,
        getPath: (path) => path,
        getColor: [255, 253, 249, 220],
        getWidth: 1.1,
        widthUnits: "meters",
        widthMinPixels: 1.2,
        widthMaxPixels: 7,
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
        getWidth: 7.5,
        widthUnits: "meters",
        widthMinPixels: 5,
        widthMaxPixels: 38,
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
        getRadius: 2.8,
        radiusUnits: "meters",
        radiusMinPixels: 4,
        radiusMaxPixels: 18,
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
        getRadius: 3.5,
        radiusUnits: "meters",
        radiusMinPixels: 5,
        radiusMaxPixels: 22,
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
        getWidth: 0.9,
        widthUnits: "meters",
        widthMinPixels: 1.2,
        widthMaxPixels: 6,
        pickable: false,
      }),
      new ScatterplotLayer<(typeof crashMarkers)[number]>({
        id: "crash-markers",
        data: crashMarkers,
        getPosition: (marker) => marker.position,
        getRadius: 4,
        radiusUnits: "meters",
        radiusMinPixels: 5,
        radiusMaxPixels: 24,
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