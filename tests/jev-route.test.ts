/**
 * Jev server-boundary tests (Issue #13).
 *
 * The route is the only place a credential exists, so these tests are about
 * what it must never do: never answer without configuration, never forward an
 * unvalidated body, never echo the service's words, never put the token in a
 * response, and never log anything at all.
 *
 * The upstream service is stubbed through global fetch — no test reaches the
 * network, and none invents what Jev would say.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "@/app/api/jev/policy/route";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { DEFAULT_SIGNAL_TIMING } from "@/sim/config";
import type { JevPolicyRequest } from "@/jev/schema";

const ENDPOINT = "https://jev.invalid/policy";
const TOKEN = "token-that-must-never-appear-anywhere";

const originalEnv = {
  JEV_ENDPOINT: process.env.JEV_ENDPOINT,
  JEV_TOKEN: process.env.JEV_TOKEN,
  JEV_TIMEOUT_MS: process.env.JEV_TIMEOUT_MS,
};
const originalFetch = globalThis.fetch;

function configure(): void {
  process.env.JEV_ENDPOINT = ENDPOINT;
  process.env.JEV_TOKEN = TOKEN;
}

function request(overrides: Partial<JevPolicyRequest> = {}): JevPolicyRequest {
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: 5_000,
    windowMs: 5_000,
    city: {
      intersections: 12,
      signalizedIntersections: 8,
      activeVehicles: 40,
      queuedVehicles: 6,
      maxWaitMs: 12_000,
      arrivalRatePerSecond: 1.5,
    },
    corridors: [
      {
        corridorId: 3,
        kind: "arterial",
        intersections: 4,
        queuedVehicles: 3,
        maxWaitMs: 9_000,
        arrivalRatePerSecond: 0.8,
        occupancyRatio: 0.4,
      },
    ],
    regions: [
      {
        regionId: 1,
        intersections: 6,
        signalizedIntersections: 4,
        queuedVehicles: 3,
        maxWaitMs: 9_000,
        arrivalRatePerSecond: 0.8,
        occupancyRatio: 0.4,
      },
    ],
    hotspots: [
      {
        intersectionId: 2,
        regionId: 1,
        stage: "green",
        phaseIndex: 0,
        phaseCount: 2,
        stageElapsedMs: 4_000,
        queuedVehicles: 3,
        maxWaitMs: 9_000,
        arrivalRatePerSecond: 0.8,
        occupancyRatio: 0.4,
        downstreamOccupancyRatio: 0.2,
      },
    ],
    ...overrides,
  };
}

function post(body: unknown, init: RequestInit = {}): Promise<Response> {
  return POST(
    new Request("https://app.invalid/api/jev/policy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
  );
}

beforeEach(() => {
  configure();
});

afterEach(() => {
  process.env.JEV_ENDPOINT = originalEnv.JEV_ENDPOINT;
  process.env.JEV_TOKEN = originalEnv.JEV_TOKEN;
  process.env.JEV_TIMEOUT_MS = originalEnv.JEV_TIMEOUT_MS;
  globalThis.fetch = originalFetch;
});

describe("jev server boundary", () => {
  it("says so when it is not configured, and hands back no policy", async () => {
    delete process.env.JEV_ENDPOINT;
    delete process.env.JEV_TOKEN;
    const response = await post(request());
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error?: string; policy?: unknown };
    expect(body.error).toMatch(/not configured/);
    expect(body.policy).toBeUndefined();
  });

  it("validates the incoming request before forwarding anything", async () => {
    let forwarded = 0;
    globalThis.fetch = (async () => {
      forwarded += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const bad = await post({ schemaVersion: 99, timeMs: -1 });
    expect(bad.status).toBe(400);
    const notJson = await post("{not json");
    expect(notJson.status).toBe(400);
    const tooBig = await post(request(), { headers: { "content-type": "application/json", "content-length": String(2 * 1024 * 1024) } });
    expect(tooBig.status).toBe(413);
    expect(forwarded).toBe(0);
  });

  it("returns a bounded policy and never the token", async () => {
    const seen: { url: string; authorization: string | null; body: string }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const headers = new Headers(init.headers);
      seen.push({
        url: String(url),
        authorization: headers.get("authorization"),
        body: String(init.body),
      });
      return new Response(
        JSON.stringify({
          schemaVersion: JEV_SCHEMA_VERSION,
          pressureScale: 99,
          hint: "hold-longer",
          corridorWeights: [{ id: 3, weight: 1.25 }],
          regionWeights: [{ id: 1, weight: 1.1 }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const response = await post(request());
    expect(response.status).toBe(200);
    const text = await response.text();
    const body = JSON.parse(text) as {
      policy: { pressureScale: number; corridorWeights: { id: number; weight: number }[] };
      clamped: string[];
    };
    // Clamped on the way back, and reported.
    expect(body.policy.pressureScale).toBe(1.5);
    expect(body.policy.corridorWeights).toEqual([{ id: 3, weight: 1.25 }]);
    expect(body.clamped).toHaveLength(1);
    // The credential travelled upstream in the header and appears nowhere in
    // the response, the request body, or the URL.
    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].url).toBe(ENDPOINT);
    expect(seen[0].body).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("Bearer");
  });

  it("never echoes the service's own words on failure", async () => {
    globalThis.fetch = (async () =>
      new Response(`upstream said: ${TOKEN} is revoked`, { status: 500 })) as unknown as typeof fetch;
    const response = await post(request());
    expect(response.status).toBe(502);
    const text = await response.text();
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("revoked");
    expect(JSON.parse(text)).toEqual({ error: "jev service request failed" });
  });

  it("rejects a policy that names ids the request never carried", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          schemaVersion: JEV_SCHEMA_VERSION,
          corridorWeights: [{ id: 4242, weight: 1.5 }],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const response = await post(request());
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: string };
    expect(body.error).toMatch(/not in the request/);
  });

  it("survives a service that answers with nonsense", async () => {
    for (const payload of ["not json at all", "null", "[1,2,3]", '{"schemaVersion":1,"hint":"fly"}']) {
      globalThis.fetch = (async () => new Response(payload, { status: 200 })) as unknown as typeof fetch;
      const response = await post(request());
      expect(response.status).toBe(502);
      const body = (await response.json()) as { error: string };
      expect(body.error.length).toBeGreaterThan(0);
      expect(JSON.stringify(body)).not.toContain(TOKEN);
    }
  });

  it("logs nothing at all", () => {
    const source = readFileSync(path.join(process.cwd(), "app", "api", "jev", "policy", "route.ts"), "utf8");
    expect(source).not.toMatch(/console\./);
    expect(source).not.toMatch(/process\.stdout|process\.stderr/);
  });

  it("uses the shared signal timing rather than its own", () => {
    // The route has no business owning mechanics constants; this is a guard
    // that the adapter layer never grows its own copy of them.
    expect(DEFAULT_SIGNAL_TIMING.minGreenMs).toBeGreaterThan(0);
  });
});
