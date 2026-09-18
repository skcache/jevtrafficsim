/**
 * Copies MapLibre's worker bundle into public/ so the map's worker URL always
 * matches the installed maplibre-gl version.
 *
 * Why: under the Turbopack production build, maplibre-gl v6's own
 * `new Worker(new URL("./maplibre-gl-worker.mjs", import.meta.url))`
 * resolves to an EMPTY url, so the map never leaves its "style loading" state
 * (no sources load, nothing renders, no console error). We therefore point
 * MapLibre at a self-hosted copy via `setWorkerUrl("/maplibre/maplibre-gl-worker.mjs")`
 * and keep that copy in sync with node_modules on every dev/build run.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules", "maplibre-gl", "dist");
const target = join(root, "public", "maplibre");
const files = ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"];

if (!existsSync(source)) {
  console.warn("[sync-maplibre-worker] maplibre-gl not installed yet; skipping");
  process.exit(0);
}
mkdirSync(target, { recursive: true });
for (const file of files) {
  copyFileSync(join(source, file), join(target, file));
}
console.log(`[sync-maplibre-worker] copied ${files.join(", ")} -> public/maplibre/`);
