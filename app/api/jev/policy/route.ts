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

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return Response.json({ error: "request body is too large" }, { status: 413 });
  }

  let body: unknown;
  try {
    body = await request.json();
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
