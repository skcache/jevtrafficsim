import { jevPolicyContext } from "../jev/request";
import { JEV_LIMITS, parseJevPolicy, validateJevPolicyRequest, type JevPolicyRequest } from "../jev/schema";

const CREDENTIAL_SHAPE = /\b(?:sk-[A-Za-z0-9_-]{8,}|vck_[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/i;

export function checkSmokeRequest(request: unknown, body: string): asserts request is JevPolicyRequest {
  const validated = validateJevPolicyRequest(request);
  if (!validated.ok) throw new Error(`generated request invalid: ${validated.error}`);
  if (Buffer.byteLength(body, "utf8") > JEV_LIMITS.REQUEST_BODY_BYTES) {
    throw new Error("generated request exceeds relay body limit");
  }
}

export function checkRelayAnswer(status: number, payload: unknown, request: JevPolicyRequest): void {
  if (status !== 200) throw new Error(`relay HTTP ${status}; expected 200`);
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("relay returned no policy object");
  }
  // Inspect the complete public document, not only the policy subtree. Never print it.
  if (CREDENTIAL_SHAPE.test(JSON.stringify(payload))) {
    throw new Error("relay response contains a credential-shaped value");
  }
  const policy = (payload as Record<string, unknown>).policy;
  const parsed = parseJevPolicy(policy, jevPolicyContext(request));
  if (!parsed.ok || parsed.value.clamped.length > 0) {
    throw new Error("relay returned an invalid or unbounded Jev policy");
  }
}

export function checkOversizedAnswer(status: number): void {
  if (status !== 413) throw new Error(`oversized request HTTP ${status}; expected 413`);
}
