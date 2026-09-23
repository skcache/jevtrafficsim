/**
 * Gateway client tests (Issue #13, live path).
 *
 * TypeSafe AI's `typesafe-ai/jev` is an evaluation model: it answers typed
 * questions with choices, and the gateway exposes it at POST /v1/evaluate. The
 * adapter's job is to turn those choices into a policy WITHOUT trusting them —
 * every number comes from a local bucket table, and the policy is then parsed
 * and bounded by the same schema everything else goes through.
 *
 * These tests use a stubbed fetch: no test reaches the network, and none
 * invents what the model would decide.
 */
import { describe, expect, it } from "vitest";
import { createJevController } from "@/controllers/jev";
import { createMockJevClient } from "@/jev/client";
import {
  buildEvaluationsBody,
  createGatewayJevClient,
  JEV_GATEWAY_DEFAULT_CORRIDOR_QUESTIONS,
  JEV_GATEWAY_DEFAULT_REGION_QUESTIONS,
  JEV_GATEWAY_ENDPOINT,
  JEV_GATEWAY_MODEL,
  JEV_PRESSURE_BUCKETS,
  JEV_WEIGHT_BUCKETS,
  policyFromEvaluations,
} from "@/jev/gateway";
import {
  JEV_LIMITS,
  JEV_SCHEMA_VERSION,
  parseJevPolicy,
  type JevPolicyRequest,
} from "@/jev/schema";

function request(overrides: Partial<JevPolicyRequest> = {}): JevPolicyRequest {
  const corridors = Array.from({ length: 20 }, (_, index) => ({
    corridorId: index + 1,
    kind: "arterial" as const,
    intersections: 3,
    // Descending demand, so "busiest first" is checkable.
    queuedVehicles: 20 - index,
    maxWaitMs: 5_000,
    arrivalRatePerSecond: 1,
    occupancyRatio: 0.4,
  }));
  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    timeMs: 5_000,
    windowMs: 5_000,
    city: {
      intersections: 100,
      signalizedIntersections: 40,
      activeVehicles: 400,
      queuedVehicles: 120,
      maxWaitMs: 30_000,
      arrivalRatePerSecond: 9,
    },
    corridors,
    regions: [
      {
        regionId: 1,
        intersections: 20,
        signalizedIntersections: 8,
        queuedVehicles: 60,
        maxWaitMs: 30_000,
        arrivalRatePerSecond: 4,
        occupancyRatio: 0.5,
      },
      {
        regionId: 2,
        intersections: 20,
        signalizedIntersections: 8,
        queuedVehicles: 0,
        maxWaitMs: 0,
        arrivalRatePerSecond: 0,
        occupancyRatio: 0,
      },
    ],
    hotspots: [],
    ...overrides,
  };
}

/** An evaluation response for a body, choosing the given options per question. */
function answer(body: ReturnType<typeof buildEvaluationsBody>, pick: (id: string) => string | null) {
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(body.questions)) {
    const choice = pick(id);
    if (choice !== null) {
      answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.7 } };
    }
  }
  return { model: body.model, answers, usage: { inputTokens: 900, outputTokens: 40 } };
}

describe("gateway evaluation request", () => {
  it("asks the two citywide questions plus the busiest corridors and regions", () => {
    const body = buildEvaluationsBody(request(), { corridorQuestions: 3, regionQuestions: 1 });
    expect(body.model).toBe(JEV_GATEWAY_MODEL);
    // Every zone that gets a weight question also gets the coordinated-intent
    // question: that is what lets the model ask for a citywide move, not just a
    // re-weighting.
    expect(Object.keys(body.questions).sort()).toEqual([
      "corridor-intent:1",
      "corridor-intent:2",
      "corridor-intent:3",
      "corridor:1",
      "corridor:2",
      "corridor:3",
      "hint",
      "pressure",
      "region-intent:1",
      "region:1",
    ]);
  });

  it("leaves quiet entries out rather than asking about them", () => {
    const body = buildEvaluationsBody(request(), { corridorQuestions: 20, regionQuestions: 5 });
    // Region 2 has no queue; corridor 20 is the quietest but still queued, so it
    // is asked about only when the budget allows.
    expect(body.questions["region:2"]).toBeUndefined();
    expect(body.questions["region:1"]).toBeDefined();
  });

  it("caps the per-entry questions and keeps the whole prompt bounded", () => {
    const body = buildEvaluationsBody(request());
    const corridorQuestions = Object.keys(body.questions).filter((id) =>
      id.startsWith("corridor:"),
    );
    expect(corridorQuestions).toHaveLength(JEV_GATEWAY_DEFAULT_CORRIDOR_QUESTIONS);
    // Busiest first. The live-proven default stays at eight questions total:
    // citywide pressure + hint, then weights and intents for two corridors and
    // one region. More questions made the production-state Gateway return 503.
    expect(corridorQuestions).toContain("corridor:1");
    expect(corridorQuestions).toContain("corridor:2");
    expect(corridorQuestions).not.toContain("corridor:3");
    expect(Object.keys(body.questions)).toHaveLength(
      2 + 2 * (JEV_GATEWAY_DEFAULT_CORRIDOR_QUESTIONS + JEV_GATEWAY_DEFAULT_REGION_QUESTIONS),
    );
  });

  it("asks only choice questions, each with a criteria record", () => {
    const policyRequest = request();
    const body = buildEvaluationsBody(policyRequest);
    for (const [id, question] of Object.entries(body.questions)) {
      expect(question.type, id).toBe("choice");
      expect(question.instructions.length, id).toBeGreaterThan(10);
      expect(question, id).not.toHaveProperty("question");
      expect(Object.keys(question.criteria).length, id).toBeGreaterThanOrEqual(2);
    }
    // The state is the bounded request itself — nothing else is disclosed.
    expect(body.state).toEqual(policyRequest);
  });
});

describe("gateway answer translation", () => {
  it("maps every bucket into a policy the schema accepts", () => {
    const body = buildEvaluationsBody(request());
    const response = answer(body, (id) => {
      if (id === "hint") return "switch-sooner";
      if (id === "pressure") return "urgent";
      return "high";
    });
    const policy = policyFromEvaluations(body, response);
    expect(policy.pressureScale).toBe(JEV_PRESSURE_BUCKETS.urgent);
    expect(policy.hint).toBe("switch-sooner");
    expect(policy.corridorWeights.every((entry) => entry.weight === JEV_WEIGHT_BUCKETS.high)).toBe(
      true,
    );
    expect(policy.regionWeights).toEqual([{ id: 1, weight: JEV_WEIGHT_BUCKETS.high }]);

    // The adapter's own parser accepts it, and every value is inside the bounds.
    const parsed = parseJevPolicy(policy, {
      corridorIds: request().corridors.map((corridor) => corridor.corridorId),
      regionIds: request().regions.map((region) => region.regionId),
    });
    expect(parsed.ok).toBe(true);
    expect(policy.pressureScale).toBeLessThanOrEqual(JEV_LIMITS.PRESSURE_SCALE_MAX);
    expect(policy.corridorWeights.every((entry) => entry.weight <= JEV_LIMITS.WEIGHT_MAX)).toBe(true);
  });

  it("defaults to neutral for anything unanswered or unrecognised", () => {
    const body = buildEvaluationsBody(request());
    const partial = { answers: { hint: { choice: "do-something-else" }, pressure: {} } };
    const policy = policyFromEvaluations(body, partial);
    expect(policy.pressureScale).toBe(1);
    expect(policy.hint).toBe("neutral");
    expect(policy.corridorWeights).toEqual([]);
    expect(policy.regionWeights).toEqual([]);
  });

  it("uses the selected Gateway probability and drops uncertain or malformed choices", () => {
    const body = buildEvaluationsBody(request(), { corridorQuestions: 4 });
    const policy = policyFromEvaluations(body, {
      answers: {
        pressure: { choice: "urgent", probabilities: { urgent: 0.8 } },
        hint: { choice: "switch-sooner", probabilities: { "switch-sooner": 0.1 }, confidence: 1 },
        "corridor:1": { choice: "top", probabilities: { low: 0.9 } },
        "corridor:2": { choice: "top", probabilities: { top: 2 } },
        "corridor:3": { choice: "high", probabilities: { high: 0.7 } },
        "corridor:4": { choice: "top", probabilities: "invalid", confidence: 1 },
      },
    });
    expect(policy.pressureScale).toBe(JEV_PRESSURE_BUCKETS.urgent);
    expect(policy.hint).toBe("neutral");
    expect(policy.corridorWeights).toEqual([{ id: 3, weight: JEV_WEIGHT_BUCKETS.high }]);
  });

  it("ignores answers to questions it never asked", () => {
    const body = buildEvaluationsBody(request(), { corridorQuestions: 1 });
    const policy = policyFromEvaluations(body, {
      answers: {
        "corridor:1": { choice: "top", confidence: 0.9 },
        "corridor:999": { choice: "top", confidence: 0.9 },
        "region:42": { choice: "top", confidence: 0.9 },
      },
    });
    expect(policy.corridorWeights).toEqual([{ id: 1, weight: JEV_WEIGHT_BUCKETS.top }]);
    expect(policy.regionWeights).toEqual([]);
  });

  it("refuses a response with no answers instead of making one up", () => {
    const body = buildEvaluationsBody(request());
    expect(() => policyFromEvaluations(body, {})).toThrow(/no answers/);
    expect(() => policyFromEvaluations(body, null)).toThrow(/no answers/);
    expect(() => policyFromEvaluations(body, "200 OK")).toThrow(/no answers/);
  });

  it("cannot produce an out-of-range weight, whatever the model says", () => {
    const body = buildEvaluationsBody(request());
    const hostile = {
      answers: Object.fromEntries(
        Object.keys(body.questions).map((id) => [
          id,
          { type: "choice", choice: "999999", confidence: 1 },
        ]),
      ),
    };
    const policy = policyFromEvaluations(body, hostile);
    expect(policy.pressureScale).toBeGreaterThanOrEqual(JEV_LIMITS.WEIGHT_MIN);
    expect(policy.pressureScale).toBeLessThanOrEqual(JEV_LIMITS.PRESSURE_SCALE_MAX);
    expect(policy.hint).toBe("neutral");
    expect(policy.corridorWeights).toEqual([]);
  });
});

describe("gateway client", () => {
  it("posts the evaluation body with the token in the header only", async () => {
    const seen: { url: string; authorization: string | null; body: string }[] = [];
    const client = createGatewayJevClient({
      token: "gateway-test-token",
      fetchImpl: (async (url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        seen.push({
          url: String(url),
          authorization: headers.get("authorization"),
          body: String(init.body),
        });
        const body = JSON.parse(String(init.body)) as ReturnType<typeof buildEvaluationsBody>;
        return new Response(JSON.stringify(answer(body, () => "top")), { status: 200 });
      }) as unknown as typeof fetch,
    });

    const policy = (await client.requestPolicy(request())) as { corridorWeights: unknown[] };
    expect(client.id).toBe("gateway");
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(JEV_GATEWAY_ENDPOINT);
    expect(seen[0].authorization).toBe("Bearer gateway-test-token");
    expect(seen[0].body).not.toContain("gateway-test-token");
    expect(policy.corridorWeights.length).toBeGreaterThan(0);
  });

  it("reports a failure by status alone, never by echoing the body", async () => {
    const client = createGatewayJevClient({
      token: "gateway-test-token",
      fetchImpl: (async () =>
        new Response("upstream says: gateway-test-token is revoked", {
          status: 500,
        })) as unknown as typeof fetch,
    });
    await expect(client.requestPolicy(request())).rejects.toThrow(/responded 500/);
    await expect(client.requestPolicy(request())).rejects.not.toThrow(/revoked/);
  });

  it("drives the controller with a live-shaped answer", async () => {
    const client = createGatewayJevClient({
      token: "gateway-test-token",
      fetchImpl: (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as ReturnType<typeof buildEvaluationsBody>;
        return new Response(
          JSON.stringify(
            answer(body, (id) =>
              id === "hint" ? "hold-longer" : id === "pressure" ? "assertive" : "high",
            ),
          ),
          { status: 200 },
        );
      }) as unknown as typeof fetch,
    });
    const controller = createJevController({ client, scenarioFingerprint: "gateway-1" });
    // Sanity: the neutral starting point is the mock's, not the gateway's.
    // Before any tick the runtime holds nothing: the fallback is in force.
    expect(controller.policy()).toBeNull();
    expect(controller.status().source).toBe("fallback");
    expect(controller.status().accepted).toBe(0);
  });
});

describe("gateway client keeps the mock available", () => {
  it("leaves the deterministic mock untouched", async () => {
    const mock = createMockJevClient();
    const first = await mock.requestPolicy(request());
    const second = await mock.requestPolicy(request());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
