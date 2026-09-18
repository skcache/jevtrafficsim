/**
 * Chicago asset loading (Phase 1).
 *
 * The frozen artifacts live in `data/chicago/` and are copied into `public/`
 * by `scripts/sync-chicago-data.mjs` on every dev/build run, so the browser
 * fetches them from the same origin. No network calls, no Python, no runtime
 * GIS — and the same bytes in dev, test and production.
 */
import {
  CHICAGO_SCALES,
  compileChicagoCity,
  type ChicagoAsset,
  type ChicagoFeatureCollection,
  type ChicagoFeatures,
  type ChicagoMetadata,
} from "./chicago";
import type { MapModel } from "./map-model";

export const CHICAGO_DATA_BASE = "/chicago";

export interface ChicagoBundle {
  readonly asset: ChicagoAsset;
  readonly metadata: ChicagoMetadata;
  readonly features: ChicagoFeatures;
}

const bundleCache = new Map<number, Promise<ChicagoBundle>>();

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`chicago asset ${url} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

/** Loads metadata + one scale + the static features (cached per scale). */
export function loadChicagoBundle(scaleIndex: number): Promise<ChicagoBundle> {
  const cached = bundleCache.get(scaleIndex);
  if (cached) {
    return cached;
  }
  const scale = CHICAGO_SCALES[scaleIndex] ?? CHICAGO_SCALES[2];
  const promise = (async () => {
    const [metadata, asset, buildings, water, parks, landmarks] = await Promise.all([
      fetchJson<ChicagoMetadata>(`${CHICAGO_DATA_BASE}/metadata.json`),
      fetchJson<ChicagoAsset>(`${CHICAGO_DATA_BASE}/${scale}.json`),
      fetchJson<ChicagoFeatureCollection>(`${CHICAGO_DATA_BASE}/buildings.geojson`),
      fetchJson<ChicagoFeatureCollection>(`${CHICAGO_DATA_BASE}/water.geojson`),
      fetchJson<ChicagoFeatureCollection>(`${CHICAGO_DATA_BASE}/parks.geojson`),
      fetchJson<ChicagoFeatureCollection>(`${CHICAGO_DATA_BASE}/landmarks.geojson`),
    ]);
    return { asset, metadata, features: { buildings, water, parks, landmarks } };
  })();
  bundleCache.set(scaleIndex, promise);
  return promise;
}

/** Loads and compiles one scale into the presentation model. */
export async function loadChicagoCity(scaleIndex: number): Promise<MapModel> {
  const bundle = await loadChicagoBundle(scaleIndex);
  return compileChicagoCity(bundle.asset, bundle.features, bundle.metadata, scaleIndex);
}
