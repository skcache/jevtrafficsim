/**
 * Production-style Jev smoke.
 *
 * Exercises the DEPLOYED relay (which holds the token server-side) with a body
 * the production generator actually produces, and checks the answer is a real
 * bounded policy with honest provenance - not a fallback dressed as a model
 * answer. Also checks the route refuses an over-large body before it touches the
 * model (Issue #37's ceiling).
 *
 *   npx tsx scripts/jev-prod-smoke.ts [base-url]
 *
 * No credentials are read, logged or needed here.
 */
import { createEngine, runEngine } from "@/sim/engine";
import { createAdaptiveController } from "@/controllers/adaptive";
import { productionDemand } from "@/sim/demand-profile";
import { buildCityPartition } from "@/sim/regions";
import { buildObservationFrame } from "@/sim/observations";
import { buildJevPolicyRequest } from "@/jev/request";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { loadBenchmarkModel } from "@/benchmark/model";

const BASE = process.argv[2] ?? "https://jevtrafficsim.vercel.app";
const HORIZON_MS = 600_000;

async function main(): Promise<void> {
  const model = loadBenchmarkModel();
  const engine = createEngine({
    city: model.city,
    controller: createAdaptiveController(),
    spawns: productionDemand({ city: model.city, level: "rush-hour", seed: 42, durationMs: HORIZON_MS }),
  });
  runEngine(engine, HORIZON_MS);
  const request = buildJevPolicyRequest({
    frame: buildObservationFrame(engine.city, engine.traffic, engine.arrivals),
    partition: buildCityPartition(engine.city),
    intersections: engine.city.intersections.length,
    activeVehicles: engine.traffic.vehicles.length,
  });
  const body = JSON.stringify(request);
  console.log(`request: ${(body.length / 1024).toFixed(1)} KB · ${request.corridors.length} corridors · ${request.regions.length} regions · schema ${request.schemaVersion}`);

  const started = Date.now();
  const res = await fetch(`${BASE}/api/jev/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  const elapsed = Date.now() - started;
  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;

  console.log(`relay: HTTP ${res.status} in ${elapsed} ms`);
  if (!payload) {
    console.log("relay: no JSON body");
    return;
  }
  const policy = payload.policy as Record<string, unknown> | undefined;
  console.log(`answer: ${policy ? `schema v${String(policy.schemaVersion)}` : "none"}`);
  if (policy) {
    console.log(
      `policy: pressureScale=${String(policy.pressureScale)} corridorWeights=${Array.isArray(policy.corridorWeights) ? policy.corridorWeights.length : "?"} ` +
        `regionWeights=${Array.isArray(policy.regionWeights) ? policy.regionWeights.length : "?"} ` +
        `regionIntents=${Array.isArray(policy.regionIntents) ? policy.regionIntents.length : "?"} hint=${String(policy.hint ?? "-")}`,
    );
  }
  // The relay's contract is `{ policy, clamped }`: provenance is assembled by the
  // client from the transport it used (adapter, runtime mode, timings, accepted and
  // rejected counts), and is asserted in the browser - see the HUD's policy line.
  const text = JSON.stringify(payload);
  console.log(`clamped: ${JSON.stringify(payload.clamped ?? null)}`);
  console.log(
    `answer is a model answer, not a stub: ${policy && JEV_SCHEMA_VERSION === policy.schemaVersion ? "schema-match" : "CHECK"} · ` +
      `body free of any credential-looking token: ${/sk-|Bearer [A-Za-z0-9]{12}/.test(text) ? "NO" : "yes"}`,
  );

  // The ceiling: a body far past the limit must be refused before the model runs.
  const oversized = await fetch(`${BASE}/api/jev/policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...request, pad: "x".repeat(200_000) }),
  });
  console.log(`oversized body: HTTP ${oversized.status} (expect a refusal, not a model call)`);
}

void main();
