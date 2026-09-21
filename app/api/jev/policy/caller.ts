/**
 * Caller identity for the Jev relay's abuse guard (Issue #37).
 *
 * ## The bug this replaces
 *
 * The limiter keyed on the FIRST entry of `x-forwarded-for`. That header is a
 * list the caller can start: `X-Forwarded-For: 1.2.3.4` arrived as
 * `1.2.3.4, <the real client>`, so a scripted client minted a fresh bucket on
 * every request and the budget bounded nothing. The identity was chosen from a
 * plausible-sounding header order rather than from the platform's contract.
 *
 * ## What the platform actually guarantees
 *
 * Verified against Vercel's own shipped code, not from memory or convention:
 *
 *   - `@vercel/functions` `ipAddress()` reads exactly ONE header, `x-real-ip`,
 *     and does no `x-forwarded-for` parsing at all.
 *   - `@vercel/firewall` `checkRateLimit()` — Vercel's own rate limiter —
 *     defaults its key to `requestHeaders.get("x-real-ip")`.
 *
 * So `x-real-ip` is the platform's client address, and it is what the platform
 * itself trusts when it enforces limits. `x-forwarded-for` is treated here as
 * caller-controlled text with no role in identity: it is not read, not parsed
 * and not consulted as a fallback.
 *
 * ## Failure behaviour
 *
 * Anything that is missing or unparseable resolves to ONE shared bucket rather
 * than a per-request key. A caller cannot mint fresh buckets by omitting,
 * emptying or filling a header with junk — the worst case is that unidentified
 * callers share a budget, which fails closed. That is also the local-development
 * path: `next dev` has no edge in front of it, so local runs share that bucket.
 */
import { isIP } from "node:net";

/** The one bucket every unidentifiable caller shares. Never per-request. */
export const SHARED_CALLER_BUCKET = "unidentified";

/** The platform's client address header; see the file header for the evidence. */
export const CLIENT_IP_HEADER = "x-real-ip";

/**
 * The rate-limit key for one request.
 *
 * A valid IP (v4 or v6) from the platform header is used verbatim — the same
 * value Vercel's own rate limiter would key on. Everything else is the shared
 * bucket. No header text is ever logged or returned to the caller.
 */
export function callerIdentity(request: Request): string {
  const raw = request.headers.get(CLIENT_IP_HEADER)?.trim();
  if (raw === undefined || raw === "") {
    return SHARED_CALLER_BUCKET;
  }
  return isIP(raw) === 0 ? SHARED_CALLER_BUCKET : raw;
}

/** True when this request carried a platform identity. Diagnostics only. */
export function hasPlatformIdentity(request: Request): boolean {
  return callerIdentity(request) !== SHARED_CALLER_BUCKET;
}
