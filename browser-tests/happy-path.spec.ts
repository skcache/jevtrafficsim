import { expect, test, type Page } from "@playwright/test";
import type { PresentationPolicy } from "../worker/presentation-snapshot";
import { checkLiveJevParticipation } from "../scripts/jev-participation-check";

async function journey(page: Page, relayStatus: 200 | 503) {
  const assets = new Set<string>();
  page.on("response", (response) => {
    if (response.url().includes("/chicago/") && response.ok()) assets.add(new URL(response.url()).pathname);
  });
  await page.route("**/api/jev/policy", async (route) => {
    if (relayStatus === 503) {
      await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"unavailable"}' });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        policy: { schemaVersion: 1, pressureScale: 1, hint: "neutral", corridorWeights: [], regionWeights: [], corridorIntents: [], regionIntents: [] },
        clamped: [],
      }),
    });
  });

  const root = await page.goto("/?debug=1");
  expect(root?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Jev Traffic Simulator" })).toBeVisible();
  await expect.poll(() => assets.has("/chicago/metro.json")).toBe(true);
  await expect.poll(async () => page.evaluate(() => Boolean((window as Window & { __jevDebug?: { snapshot?: unknown } }).__jevDebug?.snapshot))).toBe(true);

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByLabel("Chicago trip")).toBeVisible();
  await page.getByRole("button", { name: "Enter City" }).click();
  await expect(page.getByText("Jev Traffic · Chicago")).toBeVisible();
  await expect.poll(async () => page.evaluate(() =>
    Boolean((window as Window & { __jevMap?: { vehicles: () => { x: number; y: number }[] } }).__jevMap?.vehicles()[0]),
  )).toBe(true);
  const first = await page.evaluate(() =>
    (window as Window & { __jevMap?: { vehicles: () => { x: number; y: number }[] } }).__jevMap!.vehicles()[0],
  );
  await page.evaluate((position) => {
    (window as Window & { __firstEgo?: { x: number; y: number } }).__firstEgo = position;
  }, first);
  await expect.poll(async () => page.evaluate(() => {
    const current = (window as Window & { __jevMap?: { vehicles: () => { x: number; y: number }[] } }).__jevMap?.vehicles()[0];
    return current ? Math.hypot(current.x - (window as Window & { __firstEgo?: { x: number; y: number } }).__firstEgo!.x,
      current.y - (window as Window & { __firstEgo?: { x: number; y: number } }).__firstEgo!.y) : 0;
  }), { timeout: 30_000 }).toBeGreaterThan(0.1);
  await expect(page.getByText("Who got there first")).toBeVisible({ timeout: 100_000 });
  await expect(page.getByRole("status", { name: "Trip" })).toBeHidden();
  await expect(page.getByText("Jev Traffic · Chicago")).toBeHidden();
  await expect(page.getByRole("button", { name: "+5× Traffic" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Following the car" })).toBeHidden();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeHidden();
  const panel = page.locator("[data-jev-provenance]");
  await expect(panel).toBeVisible();
  const payoffBox = await page.locator(".surface-overlay").filter({ hasText: "Run complete" }).boundingBox();
  expect(payoffBox).not.toBeNull();
  expect(Math.abs(payoffBox!.x + payoffBox!.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(3);
  const policy = JSON.parse((await panel.getAttribute("data-jev-provenance")) ?? "null") as PresentationPolicy;
  const label = (await panel.getAttribute("data-jev-label")) ?? "";
  const simulatedMs = Number(await panel.getAttribute("data-simulated-ms"));
  expect(assets.has("/chicago/metadata.json")).toBe(true);
  expect(assets.has("/chicago/metro.json")).toBe(true);
  return { policy, label, simulatedMs, first };
}

test("happy path completes and accounts for mocked live Jev without network quota", async ({ page }) => {
  // The browser contract is real; only the external model boundary is mocked.
  const result = await journey(page, 200);
  expect(result.policy.accepted).toBeGreaterThan(0);
  checkLiveJevParticipation(result.policy, result.label, result.simulatedMs);
  const identity = await page.request.get("/api/build");
  expect(identity.ok()).toBe(true);
  expect((await identity.json() as { commit: string }).commit).toMatch(/^[a-f0-9]{40}$/);
});

test("fallback-only still completes but fails the live-Jev release assertion", async ({ page }) => {
  const result = await journey(page, 503);
  expect(result.policy.accepted).toBe(0);
  expect(result.policy.liveMs).toBe(0);
  expect(result.label).toBe("Adaptive fallback");
  expect(() => checkLiveJevParticipation(result.policy, result.label, result.simulatedMs)).toThrow(/no live/);
});

test("mobile trip HUD and incident controls stay inside the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?debug=1");
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await page.getByRole("radio", { name: "Adaptive" }).click();
  await page.getByRole("button", { name: "Enter City" }).click();
  const hud = page.getByRole("status", { name: "Trip" });
  const lastControl = page.getByRole("button", { name: "Event Lets Out" });
  await expect(hud).toBeVisible();
  await expect(lastControl).toBeVisible();
  const hudBox = await hud.boundingBox();
  const firstControlBox = await page.getByRole("button", { name: "+5× Traffic" }).boundingBox();
  const lastControlBox = await lastControl.boundingBox();
  expect(hudBox && firstControlBox && lastControlBox).toBeTruthy();
  expect(lastControlBox!.x + lastControlBox!.width).toBeLessThanOrEqual(390);
  expect(hudBox!.y + hudBox!.height).toBeLessThan(firstControlBox!.y);
  await expect(page.getByText("Who got there first")).toBeVisible({ timeout: 100_000 });
  const payoff = page.locator(".surface-overlay").filter({ hasText: "Run complete" });
  const box = await payoff.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(844);
  await expect(lastControl).toBeHidden();
  await expect(page.getByRole("button", { name: "Zoom in" })).toBeHidden();
  await expect(page.getByText("Jev Traffic · Chicago")).toBeHidden();
});
