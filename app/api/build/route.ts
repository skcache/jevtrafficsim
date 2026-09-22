/** Public, secret-free deployment identity for smoke tests and incident triage. */
export async function GET(): Promise<Response> {
  return Response.json({ commit: process.env.BUILD_COMMIT_SHA ?? "unknown" }, {
    headers: { "cache-control": "public, max-age=60" },
  });
}
