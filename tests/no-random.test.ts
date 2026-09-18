import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_DIRS = ["sim", "controllers"].map((dir) => path.join(process.cwd(), dir));

function simSources(): Array<{ file: string; content: string }> {
  const sources: Array<{ file: string; content: string }> = [];
  for (const dir of SOURCE_DIRS) {
    for (const file of readdirSync(dir)) {
      if (file.endsWith(".ts")) {
        sources.push({
          file: `${path.basename(dir)}/${file}`,
          content: readFileSync(path.join(dir, file), "utf8"),
        });
      }
    }
  }
  return sources;
}

describe("sim/ + controllers/ environment discipline", () => {
  it("contains no Math.random calls", () => {
    for (const { file, content } of simSources()) {
      expect(content.includes("Math.random"), `${file} must not call Math.random`).toBe(
        false,
      );
    }
  });

  it("contains no wall-clock or timer APIs", () => {
    const forbidden = ["setInterval", "setTimeout", "Date.now", "performance.now"];
    for (const { file, content } of simSources()) {
      for (const token of forbidden) {
        expect(
          content.includes(token),
          `${file} must not use ${token} — the caller owns time`,
        ).toBe(false);
      }
    }
  });

  it("contains no worker, canvas, or DOM machinery (Task 11 boundary)", () => {
    const forbidden = [
      "requestAnimationFrame",
      "postMessage",
      "new Worker",
      "getContext",
      "HTMLCanvasElement",
      "CanvasRenderingContext",
      "requestIdleCallback",
    ];
    for (const { file, content } of simSources()) {
      for (const token of forbidden) {
        expect(
          content.includes(token),
          `${file} must not use ${token} — rendering/worker code lives outside sim/ + controllers/`,
        ).toBe(false);
      }
    }
  });

  it("keeps pure showcase modules free of browser/map/react imports", () => {
    // cities/ and the pure render helpers may be imported by the worker, so
    // they must stay presentation-library free. MapLibre/deck.gl belong to
    // the component layer only.
    const pureFiles = [
      "cities/paths.ts",
      "cities/showcase-city.ts",
      "cities/showcase-city-data.ts",
      "render/interpolate.ts",
      "render/showcase-geometry.ts",
      "render/showcase-geojson.ts",
      "render/visuals.ts",
      "components/ui-model.ts",
    ];
    const forbidden = /from\s+["'](react|react-dom|next\/|maplibre-gl|\@deck\.gl|zustand|motion)/;
    for (const file of pureFiles) {
      const content = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(forbidden.test(content), `${file} must stay pure (no UI/map libraries)`).toBe(false);
      expect(content.includes("Math.random"), `${file} must not call Math.random`).toBe(false);
    }
  });

  it("imports no framework, browser, or UI modules", () => {
    const forbidden =
      /from\s+["'](react|react-dom|zustand|next\/|\@\/app|\@\/components|\@\/render|\@\/worker|\@\/store)/;
    for (const { file, content } of simSources()) {
      expect(forbidden.test(content), `${file} must stay framework-independent`).toBe(
        false,
      );
      expect(content.includes("require("), `${file} must not use require`).toBe(false);
    }
  });
});
