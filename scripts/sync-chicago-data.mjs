/**
 * Copies the frozen Chicago artifacts from data/chicago/ into public/chicago/
 * so the browser can fetch them from the same origin.
 *
 * Why a copy instead of serving data/ directly: `data/` is a source artifact
 * directory (produced once by tools/chicago-map), not a static asset tree, and
 * Next only serves public/. The copy is deterministic byte-for-byte, gitignored,
 * and refreshed on every dev/build run so the app can never drift from the
 * committed assets.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "data", "chicago");
const target = join(root, "public", "chicago");

if (!existsSync(source)) {
  console.error(
    "[sync-chicago-data] data/chicago is missing — the Chicago showcase assets are committed; restore them or re-run tools/chicago-map/extract_chicago.py",
  );
  process.exit(1);
}

mkdirSync(target, { recursive: true });
let copied = 0;
let bytes = 0;
for (const file of readdirSync(source).sort()) {
  const from = join(source, file);
  if (!statSync(from).isFile()) {
    continue;
  }
  copyFileSync(from, join(target, file));
  copied += 1;
  bytes += statSync(from).size;
}
console.log(
  `[sync-chicago-data] copied ${copied} files (${(bytes / 1e6).toFixed(2)} MB) -> public/chicago/`,
);
