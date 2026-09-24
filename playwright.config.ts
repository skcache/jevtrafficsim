import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./browser-tests",
  timeout: 120_000,
  retries: 0,
  use: { ...devices["Desktop Chrome"], baseURL: "http://127.0.0.1:3100" },
  webServer: {
    command: "pnpm start --port 3100",
    url: "http://127.0.0.1:3100",
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
