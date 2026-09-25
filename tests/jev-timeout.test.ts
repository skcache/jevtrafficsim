/**
 * Jev transport timeouts (issue #57).
 *
 * The defect: `readJevEnvironment` resolved `JEV_TIMEOUT_MS ?? 4 000` and passed
 * that same number into BOTH transports, so the gateway client's own 15 s default
 * could never apply and slow-but-healthy live calls became `timeout` fallbacks.
 * An explicit JEV_TIMEOUT_MS must still override everything - that is the
 * operator's knob - but absent it, each transport keeps its own honest default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { readJevEnvironment } from "@/app/api/jev/policy/route";
import { JEV_DEFAULT_TIMEOUT_MS } from "@/jev/client";
import { JEV_GATEWAY_TIMEOUT_MS } from "@/jev/gateway";

const saved = { token: process.env.JEV_TOKEN, model: process.env.JEV_MODEL, timeout: process.env.JEV_TIMEOUT_MS };

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("JEV_TOKEN", saved.token);
  restore("JEV_MODEL", saved.model);
  restore("JEV_TIMEOUT_MS", saved.timeout);
});

describe("jev transport timeouts", () => {
  it("gives the gateway its own default, not the generic relay default", () => {
    process.env.JEV_TOKEN = "test-token";
    process.env.JEV_MODEL = "typesafe-ai/jev";
    delete process.env.JEV_TIMEOUT_MS;
    const environment = readJevEnvironment();
    expect(environment?.gateway).not.toBeNull();
    expect(environment?.timeoutMs).toBe(JEV_GATEWAY_TIMEOUT_MS);
    // The regression this pins: the generic default is materially shorter.
    expect(JEV_GATEWAY_TIMEOUT_MS).toBeGreaterThan(JEV_DEFAULT_TIMEOUT_MS);
  });

  it("keeps the generic default for a direct endpoint relay", () => {
    process.env.JEV_TOKEN = "test-token";
    delete process.env.JEV_MODEL;
    delete process.env.JEV_TIMEOUT_MS;
    process.env.JEV_ENDPOINT = "https://example.invalid/v1/policy";
    const environment = readJevEnvironment();
    expect(environment?.gateway).toBeNull();
    expect(environment?.timeoutMs).toBe(JEV_DEFAULT_TIMEOUT_MS);
  });

  it("lets an explicit override win on either transport", () => {
    process.env.JEV_TOKEN = "test-token";
    process.env.JEV_MODEL = "typesafe-ai/jev";
    process.env.JEV_TIMEOUT_MS = "9000";
    expect(readJevEnvironment()?.timeoutMs).toBe(9000);
    delete process.env.JEV_MODEL;
    process.env.JEV_ENDPOINT = "https://example.invalid/v1/policy";
    expect(readJevEnvironment()?.timeoutMs).toBe(9000);
  });
});
