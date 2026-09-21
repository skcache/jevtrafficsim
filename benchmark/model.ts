/**
 * Node-side geography for the benchmark (Issue #12).
 *
 * The harness must run with no DOM, no React, no MapLibre and no worker: this
 * reads the SAME committed Chicago bytes the browser fetches and compiles them
 * with the SAME compiler the app uses, so a benchmark run and a live run are one
 * simulation over one city. There is no second simulation path here — this file
 * only replaces `fetch` with `readFileSync`.
 */
import { existsSync, readFileSync } from "node:fs";
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

/** Curated trips require Metro; the benchmark always runs the full city. */
export const BENCHMARK_SCALE_INDEX = 4;

/**
 * Locate `data/chicago/` by walking up from the working directory, so the
 * harness works the same under `pnpm benchmark` (tsx), under vitest, and from a
 * nested cwd — and so nothing here depends on ESM-only globals.
 */
export function resolveChicagoDataDir(startDir: string = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, "data", "chicago");
    if (existsSync(path.join(candidate, "metadata.json"))) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(
        `could not find data/chicago/metadata.json above ${startDir} — run the benchmark from the repository root`,
      );
    }
    dir = parent;
  }
}

export const CHICAGO_DATA_DIR = resolveChicagoDataDir();

function readJson<T>(dataDir: string, file: string): T {
  return JSON.parse(readFileSync(path.join(dataDir, file), "utf8")) as T;
}

/** Compile the frozen Chicago showcase exactly as the browser does. */
export function loadBenchmarkModel(dataDir: string = CHICAGO_DATA_DIR): MapModel {
  const scale = CHICAGO_SCALES[BENCHMARK_SCALE_INDEX] ?? "metro";
  const features: ChicagoFeatures = {
    buildings: readJson<ChicagoFeatureCollection>(dataDir, "buildings.geojson"),
    water: readJson<ChicagoFeatureCollection>(dataDir, "water.geojson"),
    parks: readJson<ChicagoFeatureCollection>(dataDir, "parks.geojson"),
    landmarks: readJson<ChicagoFeatureCollection>(dataDir, "landmarks.geojson"),
    blocks: readJson<ChicagoFeatureCollection>(dataDir, "blocks.geojson"),
  };
  return compileChicagoCity(
    readJson<ChicagoAsset>(dataDir, `${scale}.json`),
    features,
    readJson<ChicagoMetadata>(dataDir, "metadata.json"),
    BENCHMARK_SCALE_INDEX,
  );
}
