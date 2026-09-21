/**
 * Jev server boundary (Issue #13).
 *
 * The browser (or its worker) posts a Jev policy request here; this route — and
 * only this route — holds the service credential and talks to Jev. That is what
 * keeps the secret out of the client bundle, out of the worker payload, out of
 * browser state and out of logs:
 *
 *   - the credential comes from the environment (JEV_ENDPOINT / JEV_TOKEN),
 *     server-side only;
 *   - the token travels in an Authorization header, never in a body, a URL or a
 *     message we log;
 *   - failure responses carry a status and a short message, never the service's
 *     own words, because an upstream error body can echo credentials back;
 *   - the request is validated here before anything is forwarded, and the
 *     response is validated and bounded before it is handed back.
 *
 * When the environment is not configured the route says so (503) and returns no
 * policy. It never fabricates one, and it never falls back to a replay or a
 * cached answer — that is Issue #14's territory.
 */
import { createHttpJevClient, JEV_DEFAULT_TIMEOUT_MS, type JevClient } from "@/jev/client";
import { createGatewayJevClient, JEV_GATEWAY_ENDPOINT } from "@/jev/gateway";
import { jevPolicyContext } from "@/jev/request";
import { parseJevPolicy, validateJevPolicyRequest } from "@/jev/schema";

/** Requests are bounded by construction; refuse anything wildly larger. */
const MAX_BODY_BYTES = 512 * 1024;

/**
 * Abuse guard for the public relay (Issue #15).
 *
 * Two things keep this endpoint from being a free model proxy: the request must
 * be first-party, and each caller gets a budget. Neither is a security boundary
 * on its own — a scripted client can forge headers, and this counter lives in
 * one serverless instance — so both are deliberately small and dependency-free
 * rather than pretending to be more than they are. The real bound is the
 * contract: only the Jev question set is ever forwarded (see jev/gateway.ts),
 * so a caller cannot turn this into a general completion endpoint.
 *
 * A caller that trips the budget gets 429, the runtime falls back to Adaptive,
 * and the run continues. Nothing is retried or queued server-side.
 */
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 180;
/** Hard cap on tracked callers, so the counter cannot grow without bound. */
const RATE_LIMIT_MAX_KEYS = 4_096;

interface RateWindow {
  count: number;
  resetAtMs: number;
}

const rateWindows = new Map<string, RateWindow>();

/** The caller's identity for rate limiting: the platform's client IP. */
export function callerKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  return request.headers.get("x-real-ip")?.trim() || "unknown";
}

/**
 * True when the caller may spend one request. Fixed window, per instance: the
 * point is to bound a runaway client, not to account for every caller on earth.
 */
export function allowRequest(key: string, nowMs: number): boolean {
  for (const [existing, window] of rateWindows) {
    if (window.resetAtMs <= nowMs) {
      rateWindows.delete(existing);
    }
  }
  const window = rateWindows.get(key);
  if (window === undefined) {
    if (rateWindows.size >= RATE_LIMIT_MAX_KEYS) {
      return false;
    }
    rateWindows.set(key, { count: 1, resetAtMs: nowMs + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (window.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }
  window.count += 1;
  return true;
}

/**
 * First-party only, when the request says where it came from.
 *
 * Browsers attach provenance to a cross-site POST, and this route is for our own
 * worker: an `Origin` that is not us is refused, and a `Sec-Fetch-Site` that
 * says another site is refused even without an Origin. A request with neither
 * (a script, a health check, the deployed smoke) is allowed through to the rate
 * limit — refusing it would only break legitimate server-side callers, since
 * headers are trivially forged anyway.
 */
export function firstParty(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== "" && origin !== "null") {
    try {
      return new URL(origin).host === new URL(request.url).host;
    } catch {
      return false;
    }
  }
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "same-site" && site !== "none") {
    return false;
  }
  return true;
}

export interface JevEnvironment {
  readonly token: string;
  readonly timeoutMs: number;
  /** Set when this deployment talks to the Vercel AI Gateway. */
  readonly gateway: {
    readonly endpoint: string;
    readonly model: string;
    /** Minimum usable answer confidence; undefined = the adapter's default. */
    readonly minConfidence: number | undefined;
  } | null;
  /** Set when this deployment talks to a service speaking the policy schema. */
  readonly endpoint: string | null;
}

/**
 * Two supported backends, chosen by configuration alone:
 *
 *   JEV_MODEL set    -> TypeSafe AI's evaluation model through the Vercel AI
 *                       Gateway (its own URL; JEV_GATEWAY_URL overrides it for a
 *                       self-hosted proxy). One model, no fallbacks.
 *   JEV_ENDPOINT set -> a service that speaks the Jev policy schema directly
 *
 * The two are never mixed: JEV_MODEL selects the gateway and JEV_ENDPOINT is
 * ignored for it, so a deployment cannot accidentally send gateway-shaped
 * questions to a schema-speaking service. Only the configured backend is ever
 * called, and without a token there is no client at all — the route answers 503
 * rather than inventing a policy.
 */
/** One named, optional confidence floor; the adapter owns the default. */
function readMinConfidence(): number | undefined {
  const raw = process.env.JEV_MIN_CONFIDENCE?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

export function readJevEnvironment(): JevEnvironment | null {
  const token = process.env.JEV_TOKEN?.trim();
  if (!token) {
    return null;
  }
  const configured = Number(process.env.JEV_TIMEOUT_MS ?? JEV_DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configured) && configured > 0 ? configured : JEV_DEFAULT_TIMEOUT_MS;

  const model = process.env.JEV_MODEL?.trim();
  if (model) {
    return {
      token,
      timeoutMs,
      gateway: {
        endpoint: process.env.JEV_GATEWAY_URL?.trim() || JEV_GATEWAY_ENDPOINT,
        model,
        minConfidence: readMinConfidence(),
      },
      endpoint: null,
    };
  }

  const endpoint = process.env.JEV_ENDPOINT?.trim();
  if (!endpoint) {
    return null;
  }
  return { token, timeoutMs, gateway: null, endpoint };
}

/** The one place a client is built from configuration. */
export function jevClientFromEnvironment(environment: JevEnvironment): JevClient {
  if (environment.gateway) {
    return createGatewayJevClient({
      token: environment.token,
      endpoint: environment.gateway.endpoint,
      model: environment.gateway.model,
      timeoutMs: environment.timeoutMs,
      minConfidence: environment.gateway.minConfidence,
    });
  }
  return createHttpJevClient({
    endpoint: environment.endpoint ?? "",
    token: environment.token,
    timeoutMs: environment.timeoutMs,
  });
}

export async function POST(request: Request): Promise<Response> {
  const environment = readJevEnvironment();
  if (environment === null) {
    return Response.json({ error: "jev is not configured" }, { status: 503 });
  }

  if (!firstParty(request)) {
    return Response.json({ error: "cross-origin requests are not allowed" }, { status: 403 });
  }

  if (!allowRequest(callerKey(request), Date.now())) {
    return Response.json({ error: "too many policy requests" }, { status: 429 });
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "request body is too large" }, { status: 413 });
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: "request body could not be read" }, { status: 400 });
  }
  // The declared length is a claim; this is the actual size.
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
    return Response.json({ error: "request body is too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return Response.json({ error: "request body must be JSON" }, { status: 400 });
  }

  const validated = validateJevPolicyRequest(body);
  if (!validated.ok) {
    return Response.json({ error: validated.error }, { status: 400 });
  }

  const client = jevClientFromEnvironment(environment);
  try {
    const raw = await client.requestPolicy(validated.value);
    const parsed = parseJevPolicy(raw, jevPolicyContext(validated.value));
    if (!parsed.ok) {
      return Response.json({ error: parsed.error }, { status: 502 });
    }
    return Response.json({ policy: parsed.value.policy, clamped: parsed.value.clamped });
  } catch {
    return Response.json({ error: "jev service request failed" }, { status: 502 });
  }
}
