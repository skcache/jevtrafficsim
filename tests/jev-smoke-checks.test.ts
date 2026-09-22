import { describe, expect, it } from "vitest";
import { checkOversizedAnswer, checkRelayAnswer, checkSmokeRequest } from "../scripts/jev-smoke-checks";
import { checkLiveJevParticipation } from "../scripts/jev-participation-check";
import { policyLabel } from "../components/ui-model";
import type { JevPolicyRequest } from "../jev/schema";
import type { PresentationPolicy } from "../worker/presentation-snapshot";

const request: JevPolicyRequest = {
  schemaVersion: 1,
  timeMs: 5_000,
  windowMs: 5_000,
  city: {
    intersections: 1,
    signalizedIntersections: 1,
    activeVehicles: 0,
    queuedVehicles: 0,
    maxWaitMs: 0,
    arrivalRatePerSecond: 0,
  },
  corridors: [],
  regions: [],
  hotspots: [],
};
const policy = {
  schemaVersion: 1,
  pressureScale: 1,
  hint: "neutral",
  corridorWeights: [],
  regionWeights: [],
  corridorIntents: [],
  regionIntents: [],
};

describe("deployed relay release gate", () => {
  it("accepts a schema-valid request and policy", () => {
    expect(() => checkSmokeRequest(request, JSON.stringify(request))).not.toThrow();
    expect(() => checkRelayAnswer(200, { policy, clamped: [] }, request)).not.toThrow();
    expect(() => checkOversizedAnswer(413)).not.toThrow();
  });
  it("fails on non-200, absent or malformed policy", () => {
    expect(() => checkRelayAnswer(502, null, request)).toThrow("HTTP 502");
    expect(() => checkRelayAnswer(200, {}, request)).toThrow("invalid");
    expect(() => checkRelayAnswer(200, { policy: { ...policy, hint: "unsafe" } }, request)).toThrow("invalid");
  });
  it("requires an exact 413 for the oversized request", () => {
    expect(() => checkOversizedAnswer(200)).toThrow("expected 413");
    expect(() => checkOversizedAnswer(429)).toThrow("expected 413");
  });
  it("rejects credential-shaped content anywhere in the public response", () => {
    expect(() => checkRelayAnswer(200, { policy, note: "Bearer abcdefghijklmnop" }, request))
      .toThrow("credential-shaped");
  });
});

describe("completed-run Jev participation gate", () => {
  const live: PresentationPolicy = {
    source: "live", liveMs: 590_000, replayMs: 0, fallbackMs: 10_000,
    accepted: 3, rejected: 1, refreshes: 4,
  };
  it("passes an internally consistent live run with the public label", () => {
    expect(() => checkLiveJevParticipation(live, "Jev", 600_000)).not.toThrow();
    expect(() => checkLiveJevParticipation(live, "Jev", 600_100)).not.toThrow();
  });
  it("keeps fallback functional and visibly named, but fails the release gate", () => {
    const fallback: PresentationPolicy = {
      source: "fallback", liveMs: 0, replayMs: 0, fallbackMs: 600_000,
      accepted: 0, rejected: 3, refreshes: 3,
    };
    expect(policyLabel("jev", fallback)?.text).toBe("Adaptive fallback");
    expect(() => checkLiveJevParticipation(fallback, "Adaptive fallback", 600_000)).toThrow("no live");
    expect(() => checkLiveJevParticipation(fallback, "Jev", 600_000)).toThrow("public label");
  });
  it("rejects inconsistent policy and time accounting", () => {
    expect(() => checkLiveJevParticipation({ ...live, refreshes: 2 }, "Jev", 600_000))
      .toThrow("outcomes exceed");
    expect(() => checkLiveJevParticipation(live, "Jev", 599_000)).toThrow("governed time");
  });
});
