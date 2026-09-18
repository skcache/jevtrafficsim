import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SIM_DIR = path.join(process.cwd(), "sim");

function simSources(): Array<{ file: string; content: string }> {
  return readdirSync(SIM_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({
      file,
      content: readFileSync(path.join(SIM_DIR, file), "utf8"),
    }));
}

describe("sim/ environment discipline", () => {
  it("contains no Math.random calls", () => {
    for (const { file, content } of simSources()) {
      expect(content.includes("Math.random"), `${file} must not call Math.random`).toBe(
        false,
      );
    }
  });

  it("imports no framework, browser, or UI modules", () => {
    const forbidden = /from\s+["'](react|react-dom|zustand|next\/|\@\/app|\@\/components|\@\/render)/;
    for (const { file, content } of simSources()) {
      expect(forbidden.test(content), `${file} must stay framework-independent`).toBe(
        false,
      );
      expect(content.includes("require("), `${file} must not use require`).toBe(false);
    }
  });
});
