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
import { createHttpJevClient, JEV_DEFAULT_TIMEOUT_MS } from "@/jev/client";
import { jevPolicyContext } from "@/jev/request";
import { parseJevPolicy, validateJevPolicyRequest } from "@/jev/schema";

/** Requests are bounded by construction; refuse anything wildly larger. */
const MAX_BODY_BYTES = 512 * 1024;

interface JevEnvironment {
  readonly endpoint: string;
  readonly token: string;
  readonly timeoutMs: number;
}

function readJevEnvironment(): JevEnvironment | null {
  const endpoint = process.env.JEV_ENDPOINT?.trim();
  const token = process.env.JEV_TOKEN?.trim();
  if (!endpoint || !token) {
    return null;
  }
  const configured = Number(process.env.JEV_TIMEOUT_MS ?? JEV_DEFAULT_TIMEOUT_MS);
  return {
    endpoint,
    token,
    timeoutMs: Number.isFinite(configured) && configured > 0 ? configured : JEV_DEFAULT_TIMEOUT_MS,
  };
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

  const client = createHttpJevClient(environment);
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
