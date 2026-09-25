/**
 * The Jev client seam (Issue #13): one narrow interface, three implementations,
 * and no knowledge of any SDK.
 *
 *   JevClient             request in, raw response out. The adapter validates
 *                         whatever comes back; a client never decides policy.
 *   createMockJevClient   deterministic, in-process, no network. Used by tests
 *                         and by benchmark runs so a Jev run is reproducible.
 *   createHttpJevClient   the SERVER-side client. It takes its endpoint and
 *                         bearer token as arguments — it never reads the
 *                         environment itself — so only server code ever holds a
 *                         credential (see app/api/jev/policy/route.ts and the
 *                         benchmark CLI, both of which read env).
 *   createRelayJevClient  the BROWSER-side client. It talks to our own route and
 *                         carries no credential of any kind, which is why the
 *                         client bundle, the worker payload and browser state
 *                         can hold none: there is none to hold.
 *
 * A client may answer synchronously (the mock does) or with a promise (both
 * HTTP paths do). The controller applies a synchronous answer immediately and
 * an asynchronous one when it arrives; it never blocks a tick on the network.
 */
import type { JevPolicyRequest } from "./schema";

export interface JevClient {
  /** Stable id for logs and run metadata: "mock" | "http" | "relay". */
  readonly id: string;
  /**
   * Ask for a policy. The response is UNVALIDATED by design — the adapter owns
   * validation and bounds, so a client can be as dumb as possible.
   */
  requestPolicy(request: JevPolicyRequest): unknown | Promise<unknown>;
}

/**
 * Deterministic stand-in for the service, for tests and benchmark runs.
 *
 * Its default answer is a pure function of the request: it leans on the busiest
 * corridor and region it was shown and holds greens slightly longer. That
 * exercises every part of the seam — id validation, bounded weights, hint
 * translation — without pretending to be Jev's judgement. `id` is "mock" and
 * callers are expected to say so out loud.
 */
export interface MockJevClientOptions {
  /** Override the answer. Must stay deterministic. */
  readonly respond?: (request: JevPolicyRequest) => unknown;
}

export function createMockJevClient(options: MockJevClientOptions = {}): JevClient {
  const respond = options.respond ?? defaultMockResponse;
  return {
    id: "mock",
    requestPolicy: (request) => respond(request),
  };
}

/** The default mock answer: busy corridor/region weighted, greens held longer. */
function defaultMockResponse(request: JevPolicyRequest): unknown {
  const busiestCorridor = request.corridors
    .filter((corridor) => corridor.queuedVehicles > 0 || corridor.maxWaitMs > 0)
    .sort((a, b) => b.queuedVehicles - a.queuedVehicles || a.corridorId - b.corridorId)[0];
  const busiestRegion = request.regions
    .filter((region) => region.queuedVehicles > 0 || region.maxWaitMs > 0)
    .sort((a, b) => b.queuedVehicles - a.queuedVehicles || a.regionId - b.regionId)[0];
  return {
    schemaVersion: request.schemaVersion,
    pressureScale: 1.1,
    hint: "hold-longer",
    corridorWeights: busiestCorridor ? [{ id: busiestCorridor.corridorId, weight: 1.5 }] : [],
    regionWeights: busiestRegion ? [{ id: busiestRegion.regionId, weight: 1.25 }] : [],
  };
}

export interface HttpJevClientOptions {
  /** Service endpoint, e.g. https://jev.example.com/policy. */
  readonly endpoint: string;
  /** Bearer token. SERVER-SIDE ONLY — never pass a browser-reachable value. */
  readonly token: string;
  readonly timeoutMs?: number;
  /** Injected for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

export const JEV_DEFAULT_TIMEOUT_MS = 4_000;

/**
 * The browser's budget for asking OUR relay route, which then calls the model
 * gateway. It must exceed the server's own gateway budget (15 s) or the browser
 * aborts a request the server is still working on and records a fallback the
 * deployment never actually needed - measured: aborted at 4 004 ms against a
 * healthy call (issue #57).
 */
export const JEV_RELAY_TIMEOUT_MS = 20_000;

/**
 * Server-side HTTP client. Callers pass credentials in; this module never reads
 * process.env, and the token is only ever placed in the Authorization header —
 * never in the body, a URL, a log line or an error message.
 */
export function createHttpJevClient(options: HttpJevClientOptions): JevClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createHttpJevClient needs a fetch implementation");
  }
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  return {
    id: "http",
    requestPolicy: async (request) => {
      const response = await fetchImpl(options.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // Status only: response bodies can echo credentials back.
        throw new Error(`jev service responded ${response.status}`);
      }
      return (await response.json()) as unknown;
    },
  };
}

export interface RelayJevClientOptions {
  /** Same-origin route that holds the credential. */
  readonly url?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export const JEV_RELAY_PATH = "/api/jev/policy";

/**
 * Browser-side client: it asks OUR route, which holds the credential. No token
 * is read, stored or sent here, so nothing about this path can leak one.
 */
export function createRelayJevClient(options: RelayJevClientOptions = {}): JevClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createRelayJevClient needs a fetch implementation");
  }
  const url = options.url ?? JEV_RELAY_PATH;
  const timeoutMs = options.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
  return {
    id: "relay",
    requestPolicy: async (request) => {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = (await response.json().catch(() => null)) as
        | { policy?: unknown; error?: string }
        | null;
      if (!response.ok || body === null || body.policy === undefined) {
        throw new Error(body?.error ?? `jev relay responded ${response.status}`);
      }
      return body.policy;
    },
  };
}
