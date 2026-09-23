import { fileURLToPath } from "node:url";
import path from "node:path";
import { defineConfig } from "vitest/config";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Parallel CI runs several real Chicago simulation workloads at once.
    // Keep a finite hang guard without treating normal runner contention as a failure.
    testTimeout: 15_000,
  },
});
