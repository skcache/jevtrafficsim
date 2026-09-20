/**
 * Static public challenge catalog.
 *
 * Keep this module dependency-light: React/UI and the worker protocol import it
 * to validate trip ids without pulling routing code into those bundles.
 */
import type { TrafficLevel } from "@/sim/types";

export const CHALLENGE_SCALE_INDEX = 4;
export const CHALLENGE_CITY_SIZE = "large" as const;

export interface CuratedTripAnchor {
  readonly label: string;
  readonly lon: number;
  readonly lat: number;
}

export interface CuratedTripCameraHints {
  readonly overviewPaddingM: number;
  readonly followZoom: number;
}

const TRIP_DEFINITIONS = [
  {
    id: "united-center-to-navy-pier",
    label: "United Center → Navy Pier",
    shortLabel: "United Center → Navy Pier",
    description: "West Side to the lakefront through the downtown core.",
    origin: { label: "United Center", lon: -87.6742, lat: 41.8806 },
    destination: { label: "Navy Pier", lon: -87.6055, lat: 41.8916 },
    camera: { overviewPaddingM: 520, followZoom: 16.7 },
  },
  {
    id: "soldier-field-to-merchandise-mart",
    label: "Soldier Field → Merchandise Mart",
    shortLabel: "Soldier Field → The Mart",
    description: "South Loop to River North, crossing the downtown river network.",
    origin: { label: "Soldier Field", lon: -87.6167, lat: 41.8623 },
    destination: { label: "Merchandise Mart", lon: -87.6355, lat: 41.888611 },
    camera: { overviewPaddingM: 460, followZoom: 16.8 },
  },
  {
    id: "union-station-to-magnificent-mile",
    label: "Union Station → Magnificent Mile",
    shortLabel: "Union Station → Mag Mile",
    description: "West Loop rail hub to North Michigan Avenue.",
    origin: { label: "Chicago Union Station", lon: -87.640278, lat: 41.878611 },
    destination: { label: "Magnificent Mile", lon: -87.623798, lat: 41.89368 },
    camera: { overviewPaddingM: 420, followZoom: 16.9 },
  },
  {
    id: "navy-pier-to-willis-tower",
    label: "Navy Pier → Willis Tower",
    shortLabel: "Navy Pier → Willis Tower",
    description: "Streeterville into the Loop and across the river.",
    origin: { label: "Navy Pier", lon: -87.6055, lat: 41.8916 },
    destination: { label: "Willis Tower", lon: -87.635831, lat: 41.878611 },
    camera: { overviewPaddingM: 420, followZoom: 16.9 },
  },
  {
    id: "millennium-park-to-united-center",
    label: "Millennium Park → United Center",
    shortLabel: "Millennium Park → United Center",
    description: "Loop grid to the Near West Side and arena district.",
    origin: { label: "Millennium Park", lon: -87.6229, lat: 41.8826 },
    destination: { label: "United Center", lon: -87.6742, lat: 41.8806 },
    camera: { overviewPaddingM: 480, followZoom: 16.8 },
  },
  {
    id: "united-center-to-soldier-field",
    label: "United Center → Soldier Field",
    shortLabel: "United Center → Soldier Field",
    description: "Arena-to-stadium cross-city run built to exercise major corridors.",
    origin: { label: "United Center", lon: -87.6742, lat: 41.8806 },
    destination: { label: "Soldier Field", lon: -87.6167, lat: 41.8623 },
    camera: { overviewPaddingM: 560, followZoom: 16.7 },
  },
] as const;

export type CuratedTripId = (typeof TRIP_DEFINITIONS)[number]["id"];

export interface CuratedTrip {
  readonly id: CuratedTripId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly origin: CuratedTripAnchor;
  readonly destination: CuratedTripAnchor;
  readonly camera: CuratedTripCameraHints;
}

export const CURATED_TRIPS: readonly CuratedTrip[] =
  TRIP_DEFINITIONS as unknown as readonly CuratedTrip[];

export const CURATED_TRIP_IDS = CURATED_TRIPS.map((trip) => trip.id) as readonly CuratedTripId[];

export const DEFAULT_CURATED_TRIP_ID: CuratedTripId = "united-center-to-navy-pier";

export interface CuratedTripSelection {
  readonly tripId: CuratedTripId;
  readonly trafficLevel: TrafficLevel;
  readonly seed: number;
}

export function isCuratedTripId(value: string): value is CuratedTripId {
  return (CURATED_TRIP_IDS as readonly string[]).includes(value);
}

export function curatedTripById(id: CuratedTripId): CuratedTrip {
  const trip = CURATED_TRIPS.find((entry) => entry.id === id);
  if (!trip) {
    throw new RangeError(`unknown curated trip id ${id}`);
  }
  return trip;
}
