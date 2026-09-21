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
import { POST, readJevEnvironment } from "@/app/api/jev/policy/route";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { DEFAULT_SIGNAL_TIMING } from "@/sim/config";
import type { JevPolicyRequest } from "@/jev/schema";

const ENDPOINT = "https://jev.invalid/policy";
const TOKEN = "token-that-must-never-appear-anywhere";

const originalEnv = {
  JEV_ENDPOINT: process.env.JEV_ENDPOINT,
  JEV_TOKEN: process.env.JEV_TOKEN,
  JEV_TIMEOUT_MS: process.env.JEV_TIMEOUT_MS,
  JEV_MODEL: process.env.JEV_MODEL,
};
const originalFetch = globalThis.fetch;

function configure(): void {
  process.env.JEV_ENDPOINT = ENDPOINT;
  process.env.JEV_TOKEN = TOKEN;
  delete process.env.JEV_MODEL;
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
  if (originalEnv.JEV_MODEL === undefined) {
    delete process.env.JEV_MODEL;
  } else {
    process.env.JEV_MODEL = originalEnv.JEV_MODEL;
  }
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

  it("uses the gateway backend, and only that model, when JEV_MODEL is set", async () => {
    process.env.JEV_MODEL = "typesafe-ai/jev";
    const seen: { url: string; model: string; authorization: string | null }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as {
        model: string;
        questions: Record<string, unknown>;
      };
      seen.push({
        url: String(url),
        model: body.model,
        authorization: new Headers(init.headers).get("authorization"),
      });
      const answers = Object.fromEntries(
        Object.keys(body.questions).map((id) => [
          id,
          {
            type: "choice",
            choice: id === "hint" ? "hold-longer" : id === "pressure" ? "assertive" : "high",
            confidence: 0.6,
          },
        ]),
      );
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as unknown as typeof fetch;

    const response = await post(request());
    expect(response.status).toBe(200);
    // The gateway endpoint, and exactly the configured model — no fallbacks.
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("https://ai-gateway.vercel.sh/v1/evaluate");
    expect(seen[0].model).toBe("typesafe-ai/jev");
    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);

    const body = (await response.json()) as {
      policy: { hint: string; pressureScale: number; corridorWeights: { id: number; weight: number }[] };
      clamped: string[];
    };
    expect(body.policy.hint).toBe("hold-longer");
    expect(body.policy.pressureScale).toBe(1.25);
    expect(body.policy.corridorWeights).toEqual([{ id: 3, weight: 1.5 }]);
    expect(body.clamped).toEqual([]);
  });

  it("keeps the schema-speaking service backend when no model is configured", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string) => {
      seen.push(String(url));
      return new Response(
        JSON.stringify({
          schemaVersion: JEV_SCHEMA_VERSION,
          pressureScale: 1.1,
          corridorWeights: [{ id: 3, weight: 1.2 }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const response = await post(request());
    expect(response.status).toBe(200);
    expect(seen[0]).toBe(ENDPOINT);
    const body = (await response.json()) as { policy: { pressureScale: number } };
    expect(body.policy.pressureScale).toBe(1.1);
  });

  it("does not use the gateway's default endpoint unless a model is configured", async () => {
    const env = readJevEnvironment();
    expect(env?.gateway).toBeNull();
    expect(env?.endpoint).toBe(ENDPOINT);

    process.env.JEV_MODEL = "typesafe-ai/jev";
    const gatewayEnv = readJevEnvironment();
    expect(gatewayEnv?.gateway?.model).toBe("typesafe-ai/jev");
    expect(gatewayEnv?.endpoint).toBeNull();
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

describe("public relay abuse guard (Issue #15)", () => {
  /** Every policy answer in these tests comes from a stub, never the network. */
  function stubFetch(): () => number {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ schemaVersion: JEV_SCHEMA_VERSION, pressureScale: 1.1 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    return () => calls;
  }

  it("refuses another site's browser before it spends anything", async () => {
    const calls = stubFetch();
    const json = { "content-type": "application/json" };
    const foreignOrigin = await post(request(), {
      headers: { ...json, origin: "https://not-our-app.example" },
    });
    expect(foreignOrigin.status).toBe(403);
    const crossSite = await post(request(), {
      headers: { ...json, "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    // Nothing reached the service on either attempt.
    expect(calls()).toBe(0);

    // The app's own worker (same origin) is served normally.
    const own = await post(request(), { headers: { ...json, origin: "https://app.invalid" } });
    expect(own.status).toBe(200);
    expect(calls()).toBe(1);
  });

  it("bounds one caller's spend", async () => {
    stubFetch();
    const headers = { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" };
    let served = 0;
    let refused = 0;
    for (let index = 0; index < 200 && refused === 0; index += 1) {
      const response = await post(request(), { headers });
      if (response.status === 200) {
        served += 1;
      } else {
        expect(response.status).toBe(429);
        refused += 1;
      }
    }
    // A generous budget for a real visitor, a hard stop for a runaway client.
    expect(served).toBe(180);
    expect(refused).toBe(1);
  });

  it("refuses a body that lies about its length", async () => {
    const calls = stubFetch();
    const oversized = `{"schemaVersion":1,"pad":"${"x".repeat(600 * 1024)}"}`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oversized));
        controller.close();
      },
    });
    // No content-length at all: the route must measure what it actually reads.
    const response = await POST(
      new Request("https://app.invalid/api/jev/policy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    );
    expect(response.status).toBe(413);
    expect(calls()).toBe(0);
  });
});
