/**
 * Test support for the frozen Chicago assets: loads the committed artifacts
 * from `data/chicago/` and compiles them exactly as the browser does. No
 * network, no Python, no fixtures — the same bytes the app ships.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CHICAGO_SCALES,
  compileChicagoCity,
  type ChicagoAsset,
  type ChicagoFeatureCollection,
  type ChicagoFeatures,
  type ChicagoMetadata,
} from "@/cities/chicago";
import type { MapModel } from "@/cities/map-model";

const DATA_DIR = path.join(process.cwd(), "data", "chicago");

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(DATA_DIR, file), "utf8")) as T;
}

let metadataCache: ChicagoMetadata | null = null;
let featuresCache: ChicagoFeatures | null = null;
const assetCache = new Map<number, ChicagoAsset>();

export function chicagoMetadata(): ChicagoMetadata {
  metadataCache ??= readJson<ChicagoMetadata>("metadata.json");
  return metadataCache;
}

export function chicagoFeatures(): ChicagoFeatures {
  if (!featuresCache) {
    featuresCache = {
      buildings: readJson<ChicagoFeatureCollection>("buildings.geojson"),
      water: readJson<ChicagoFeatureCollection>("water.geojson"),
      parks: readJson<ChicagoFeatureCollection>("parks.geojson"),
      landmarks: readJson<ChicagoFeatureCollection>("landmarks.geojson"),
    };
  }
  return featuresCache;
}

export function chicagoAsset(scaleIndex: number): ChicagoAsset {
  const cached = assetCache.get(scaleIndex);
  if (cached) {
    return cached;
  }
  const name = CHICAGO_SCALES[scaleIndex] ?? CHICAGO_SCALES[2];
  const asset = readJson<ChicagoAsset>(`${name}.json`);
  assetCache.set(scaleIndex, asset);
  return asset;
}

/** The compiled presentation model for one scale (identical to the browser's). */
export function chicagoModel(scaleIndex: number): MapModel {
  return compileChicagoCity(
    chicagoAsset(scaleIndex),
    chicagoFeatures(),
    chicagoMetadata(),
    scaleIndex,
  );
}
