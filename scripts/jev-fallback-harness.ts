/**
 * Fallback-free completion harness (owner report).
 *
 *   "why does this keep happening and why is jev still being used for fallback…
 *    please track where Jev falls back and why. Also we should make sure when
 *    testing the fallback shit, we allow the run to complete without doing
 *    fallbacks."
 *
 * This is the repeatable answer. It drives EVERY curated Chicago trip to the
 * full horizon through the same world seam the app and the benchmark use
 * (`worker/challenge-compare.ts`), with the same controller the app runs, and
 * reports what the run's OWN record says (jev/telemetry.ts):
 *
 *   per route   refreshes, windows by outcome (live / held / fallback),
 *               liveMs / heldMs / fallbackMs, the public provenance label
 *   per reason  how many windows each classified reason cost, and the simulated
 *               time it covered
 *   per failure WHICH refresh it was (`index` at `atSimMs`), what happened
 *               (`reason`), which policy `field`/`bound` was involved, and the
 *               run's own one-sentence `detail`
 *
 * ## The gate, stated exactly
 *
 * A run passes when it needed the Adaptive safety net for no FAILURE:
 *
 *   - zero windows with outcome `fallback`   (no refresh fell through)
 *   - zero fallback time attributed to a failure cause
 *     (everything except the structural `first-policy` / `unconfigured` gap)
 *   - at least one live window, and the trip actually completed
 *
 * The ONE fallback the gate allows is the structural opening gap: the policy a
 * refresh produces is in force from the tick AFTER it is accepted (the rule
 * that makes live and replayed runs identical), so the sim time between the
 * first request and its answer is covered by the fallback whatever the service
 * does. It is reported separately and by name (`structuralMs`) — never hidden,
 * never renamed, and never allowed to grow: a gap that costs a real failure
 * fails the gate like any other.
 *
 * Anything that fails is reported WHERE and WHY, from the run's own record. The
 * harness never retries a window, never tunes a bound and never edits a result.
 *
 * ## Clients, and the live quota
 *
 *   --client mock      deterministic stand-in. NO network, NO model, NO
 *                      credential. The default: iterate here.
 *   --client gateway   TypeSafe AI's jev through the Vercel AI Gateway, the
 *                      same client the relay route builds (JEV_TOKEN, and
 *                      JEV_MODEL to override the model).
 *   --client relay     the DEPLOYED relay route (`/api/jev/policy`), posted to
 *                      exactly as the browser posts to it: no credential here,
 *                      the deployment holds it.
 *
 * Live runs spend real quota, so they are capped: `--live-run-budget` (default
 * 3) routes per invocation, refused with a message rather than silently run.
 * Everything else about the harness is identical between clients, so a mock
 * iteration and a live confirmation are the same measurement of the same run.
 *
 *   # iterate: all six trips, no network
 *   pnpm tsx scripts/jev-fallback-harness.ts
 *
 *   # confirm live on three trips (JEV_TOKEN from the environment)
 *   pnpm tsx --env-file=.env.local scripts/jev-fallback-harness.ts \
 *     --client gateway --trips soldier-field-to-navy-pier,united-center-to-willis-tower,willis-tower-to-near-west-side
 *
 *   # confirm the DEPLOYED relay path end to end (no credential needed)
 *   pnpm tsx scripts/jev-fallback-harness.ts --client relay --base-url https://jevtrafficsim.vercel.app \
 *     --trips soldier-field-to-navy-pier
 *
 *   # negative control: a deliberately slow stand-in must FAIL the gate
 *   pnpm tsx scripts/jev-fallback-harness.ts --mock-latency 6000 --pace 8
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { CURATED_TRIP_IDS, type CuratedTripId } from "@/cities/chicago-trips";
import { createJevController, type JevController } from "@/controllers/jev";
import { createGatewayJevClient } from "@/jev/gateway";
import {
  JevClientError,
  createMockJevClient,
  createRelayJevClient,
  type JevClient,
  type JevClientFailure,
} from "@/jev/client";
import { jevProvenance, provenanceLine, type JevProvenance } from "@/jev/provenance";
import { JEV_SCHEMA_VERSION } from "@/jev/schema";
import { JEV_REFRESH_REASONS, type JevRefreshEvent, type JevRefreshReason, type JevRefreshTelemetry } from "@/jev/telemetry";
import type { DriverStrategy } from "@/sim/driver";
import type { TrafficLevel } from "@/sim/types";
import type { ScenarioRun } from "@/worker/challenge-compare";
import { buildScenarioRun } from "@/worker/challenge-compare";
import { LIVE_RUN_HORIZON_MS } from "@/worker/protocol";
import { loadBenchmarkModel } from "@/benchmark/model";

/* ------------------------------------------------------------- options --- */

type ClientChoice = "mock" | "gateway" | "relay";

/** A class of failure the stand-in can be told to produce, for control runs. */
const MOCK_FAILURES = ["timeout", "rate-limited", "upstream-5xx", "transport", "malformed-json", "schema-invalid"] as const;

const USAGE = `Jev fallback-free completion harness

Usage: pnpm tsx scripts/jev-fallback-harness.ts [options]

  --client <mock|gateway|relay>  how Jev gets its policy (default mock)
  --trips <id,...>               curated trip ids (default: all ${CURATED_TRIP_IDS.length})
  --traffic <everyday|rush-hour> traffic level (default rush-hour)
  --driver <tourist|local>       driver strategy (default tourist)
  --seed <n>                     scenario seed (default 42)
  --horizon <ms>                 simulated run length (default ${LIVE_RUN_HORIZON_MS})
  --pace <simPerWall>            live clients: simulated ms per wall ms (default 8, the
                                 app's playback). Mock runs unpaced unless asked.
  --mock-latency <ms>            stand-in answers after this wall delay (default 0)
  --mock-fail <class>            stand-in refuses everything, in one class
                                 (${MOCK_FAILURES.join(" | ")}): a negative control
  --base-url <url>               deployed origin for --client relay
  --timeout <ms>                 one request's deadline (default: the client's own)
  --live-run-budget <n>          routes a LIVE client may run per invocation (default 3)
  --require-completion           also fail the gate when a curated trip did not finish
                                 inside the horizon (reported separately either way)
  --json <path>                  write the whole report as JSON
  --no-gate                      report only; never fail
  --help                         this text

Trips: ${CURATED_TRIP_IDS.join(", ")}`;

interface Options {
  readonly client: ClientChoice;
  readonly trips: readonly CuratedTripId[];
  readonly trafficLevel: TrafficLevel;
  readonly driver: DriverStrategy;
  readonly seed: number;
  readonly horizonMs: number;
  readonly paceRatio: number | null;
  readonly mockLatencyMs: number;
  /** A stand-in that cannot be used, in this class; null for a healthy one. */
  readonly mockFail: string | null;
  readonly baseUrl: string;
  readonly timeoutMs: number | null;
  readonly liveRunBudget: number;
  readonly jsonPath: string | null;
  readonly gate: boolean;
  /** Also fail the gate when a trip did not finish inside the horizon. */
  readonly requireCompletion: boolean;
}

class UsageError extends Error {}

function arg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return null;
  }
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError(`${name} needs a value`);
  }
  return value;
}

function intArg(name: string, fallback: number, min: number): number {
  const raw = arg(name);
  if (raw === null) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) {
    throw new UsageError(`${name} must be an integer >= ${min} (received "${raw}")`);
  }
  return value;
}

function parseMockFail(): string | null {
  const raw = arg("--mock-fail");
  if (raw === null) {
    return null;
  }
  if (!(MOCK_FAILURES as readonly string[]).includes(raw)) {
    throw new UsageError(`--mock-fail must be one of ${MOCK_FAILURES.join(", ")} (received "${raw}")`);
  }
  return raw;
}

function parseOptions(): Options {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    throw new UsageError(USAGE);
  }
  const client = arg("--client") ?? "mock";
  if (client !== "mock" && client !== "gateway" && client !== "relay") {
    throw new UsageError(`--client must be mock, gateway or relay (received "${client}")`);
  }
  const trafficLevel = arg("--traffic") ?? "rush-hour";
  if (trafficLevel !== "everyday" && trafficLevel !== "rush-hour") {
    throw new UsageError(`--traffic must be everyday or rush-hour (received "${trafficLevel}")`);
  }
  const driver = arg("--driver") ?? "tourist";
  if (driver !== "tourist" && driver !== "local") {
    throw new UsageError(`--driver must be tourist or local (received "${driver}")`);
  }
  const tripArg = arg("--trips");
  const trips = (tripArg === null ? [...CURATED_TRIP_IDS] : tripArg.split(",").map((entry) => entry.trim()))
    .filter((entry) => entry.length > 0);
  const unknown = trips.filter((id) => !(CURATED_TRIP_IDS as readonly string[]).includes(id));
  if (unknown.length > 0) {
    throw new UsageError(`unknown trip id(s): ${unknown.join(", ")}\nKnown: ${CURATED_TRIP_IDS.join(", ")}`);
  }
  const paceArg = arg("--pace");
  const paceRatio = paceArg === null ? null : Number(paceArg);
  if (paceRatio !== null && (!Number.isFinite(paceRatio) || paceRatio <= 0)) {
    throw new UsageError("--pace must be a positive number of simulated ms per wall ms");
  }
  const timeoutArg = arg("--timeout");
  const timeoutMs = timeoutArg === null ? null : Number(timeoutArg);
  if (timeoutMs !== null && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
    throw new UsageError("--timeout must be a positive number of ms");
  }
  return {
    client,
    trips: trips as CuratedTripId[],
    trafficLevel,
    driver,
    seed: intArg("--seed", 42, 0),
    horizonMs: intArg("--horizon", LIVE_RUN_HORIZON_MS, 1_000),
    paceRatio,
    mockLatencyMs: intArg("--mock-latency", 0, 0),
    mockFail: parseMockFail(),
    baseUrl: arg("--base-url") ?? "https://jevtrafficsim.vercel.app",
    timeoutMs,
    liveRunBudget: intArg("--live-run-budget", 3, 1),
    jsonPath: arg("--json"),
    gate: !process.argv.includes("--no-gate"),
    requireCompletion: process.argv.includes("--require-completion"),
  };
}

/* -------------------------------------------------------------- clients --- */

/**
 * A deterministic stand-in that answers after a wall delay, for control runs.
 * Its id stays "mock": the adapter vocabulary describes what produced a policy,
 * and a delayed stand-in is still the stand-in — never a service.
 */
function delayedMockClient(delayMs: number): JevClient {
  if (delayMs <= 0) {
    return createMockJevClient();
  }
  const inner = createMockJevClient();
  return {
    id: "mock",
    requestPolicy: (request) =>
      new Promise((resolve) => {
        setTimeout(() => resolve(inner.requestPolicy(request)), delayMs);
      }),
  };
}

/**
 * The negative control: a stand-in that cannot be used, in a chosen class. It
 * exists so the gate can be shown to FAIL — a harness that has never failed has
 * not been tested. Its id stays "mock": the adapter vocabulary describes what
 * produced policies, and this produced none.
 */
function failingMockClient(kind: string): JevClient {
  return {
    id: "mock",
    requestPolicy: () => {
      if (kind === "schema-invalid") {
        return { schemaVersion: JEV_SCHEMA_VERSION, pressureScale: "high" };
      }
      if (kind === "malformed-json") {
        return null;
      }
      const failure = kind === "upstream-5xx" ? "upstream-error" : kind;
      throw new JevClientError(
        failure as JevClientFailure,
        `mock stand-in refused every request (${kind})`,
      );
    },
  };
}

function buildClient(options: Options): JevClient {
  switch (options.client) {
    case "mock":
      return options.mockFail === null
        ? delayedMockClient(options.mockLatencyMs)
        : failingMockClient(options.mockFail);
    case "relay":
      return createRelayJevClient({
        url: `${options.baseUrl.replace(/\/$/, "")}/api/jev/policy`,
        ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
      });
    case "gateway": {
      const token = process.env.JEV_TOKEN?.trim();
      if (!token) {
        throw new UsageError(
          "a live gateway run needs JEV_TOKEN in the environment — nothing is fabricated without it " +
            "(pass --env-file=.env.local, or use --client mock to iterate)",
        );
      }
      return createGatewayJevClient({
        token,
        ...(process.env.JEV_MODEL?.trim() === undefined || process.env.JEV_MODEL?.trim() === ""
          ? {}
          : { model: process.env.JEV_MODEL.trim() }),
        ...(options.timeoutMs === null ? {} : { timeoutMs: options.timeoutMs }),
      });
    }
  }
}

/* ------------------------------------------------------------ reporting --- */

interface RouteReport {
  readonly tripId: CuratedTripId;
  readonly label: string;
  readonly line: string;
  readonly provenance: JevProvenance;
  readonly telemetry: JevRefreshTelemetry;
  readonly refreshes: number;
  readonly accepted: number;
  readonly rejected: number;
  readonly liveMs: number;
  readonly heldMs: number;
  readonly fallbackMs: number;
  /** The part of `fallbackMs` the structural opening gap covered. */
  readonly structuralFallbackMs: number;
  /** The part of `fallbackMs` any FAILURE caused. Must be zero to pass. */
  readonly failureFallbackMs: number;
  readonly dominantFallbackCause: string | null;
  readonly simulatedMs: number;
  /** The horizon the run was asked for, so "did not finish" names its bound. */
  readonly horizonMs: number;
  readonly tripCompleted: boolean;
  readonly tripTimeMs: number;
  /** How far the protagonist got, and how much of its time it spent stopped. */
  readonly tripDistanceM: number;
  readonly tripStoppedMs: number;
  readonly reasonMs: Readonly<Partial<Record<JevRefreshReason, number>>>;
  readonly failures: readonly JevRefreshEvent[];
  readonly latencyP50Ms: number;
  readonly latencyMaxMs: number;
}

/** Causes that are the structure of a live run, not a failure of anything. */
const STRUCTURAL_CAUSES = new Set(["first-policy", "unconfigured"]);

function summarizeLatency(events: readonly JevRefreshEvent[]): { p50: number; max: number } {
  const values = events
    .map((event) => event.latencyMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) {
    return { p50: 0, max: 0 };
  }
  return { p50: values[Math.floor(values.length / 2)], max: values[values.length - 1] };
}

function reportFor(
  tripId: CuratedTripId,
  controller: JevController,
  result: {
    readonly simulatedMs: number;
    readonly trip: {
      readonly completed: boolean;
      readonly tripTimeMs: number;
      readonly distanceM: number;
      readonly stoppedMs: number;
    };
  },
  horizonMs: number,
): RouteReport {
  const meta = controller.meta();
  const provenance = jevProvenance(meta);
  const telemetry = meta.telemetry;
  const causes = meta.fallbackCauseMs;
  let structural = 0;
  for (const cause of STRUCTURAL_CAUSES) {
    structural += causes[cause as keyof typeof causes] ?? 0;
  }
  const latency = summarizeLatency(telemetry.recent);
  return {
    tripId,
    label: provenance.label,
    line: provenanceLine(provenance),
    provenance,
    telemetry,
    refreshes: meta.refreshes,
    accepted: meta.accepted,
    rejected: meta.rejected,
    liveMs: meta.liveMs,
    heldMs: meta.heldMs,
    fallbackMs: meta.fallbackMs,
    structuralFallbackMs: structural,
    failureFallbackMs: Math.max(0, meta.fallbackMs - structural),
    dominantFallbackCause: meta.dominantFallbackCause,
    simulatedMs: result.simulatedMs,
    horizonMs,
    tripCompleted: result.trip.completed,
    tripTimeMs: result.trip.tripTimeMs,
    tripDistanceM: result.trip.distanceM,
    tripStoppedMs: result.trip.stoppedMs,
    reasonMs: telemetry.reasonMs,
    failures: telemetry.recent.filter((event) => event.outcome !== "live"),
    latencyP50Ms: latency.p50,
    latencyMaxMs: latency.max,
  };
}

/**
 * Everything the gate checks, per route. The two lists are kept apart on
 * purpose: "the safety net was needed" and "the trip did not finish" are
 * different failures with different owners, and a report that merged them would
 * be exactly the kind of thing this harness exists to prevent.
 */
export interface RouteVerdict {
  readonly fallbackProblems: readonly string[];
  readonly completionProblems: readonly string[];
}

export function routeVerdict(report: RouteReport): RouteVerdict {
  const fallbackProblems: string[] = [];
  const completionProblems: string[] = [];
  if (report.telemetry.outcomes.fallback > 0) {
    fallbackProblems.push(
      `${report.telemetry.outcomes.fallback} refresh window(s) had no policy in force at all`,
    );
  }
  if (report.failureFallbackMs > 0) {
    fallbackProblems.push(
      `${report.failureFallbackMs} ms of fallback time were caused by a failure` +
        (report.dominantFallbackCause === null ? "" : ` (dominant cause: ${report.dominantFallbackCause})`),
    );
  }
  if (report.telemetry.outcomes.live < 1 || report.accepted < 1) {
    fallbackProblems.push("no policy was ever accepted: this was not a Jev run");
  }
  if (!report.tripCompleted) {
    completionProblems.push(
      `the trip did not finish inside the ${secs(report.simulatedMs)} horizon` +
        ` (ego ${(report.tripDistanceM / 1000).toFixed(2)} km in, ${secs(report.tripStoppedMs)} stopped)`,
    );
  }
  return { fallbackProblems, completionProblems };
}

/* ----------------------------------------------------------------- run ---- */

const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

async function main(): Promise<void> {
  const options = parseOptions();
  const isLive = options.client !== "mock";
  if (isLive && options.trips.length > options.liveRunBudget) {
    throw new UsageError(
      `this invocation would spend ${options.trips.length} live runs and the budget is ` +
        `${options.liveRunBudget} (--live-run-budget). Narrow --trips, or raise the budget ` +
        "explicitly if the quota really allows it.",
    );
  }
  const paceRatio = options.paceRatio ?? (isLive ? 8 : 0);
  const client = buildClient(options);
  const model = loadBenchmarkModel();

  console.log(
    `\nJev fallback-free harness · client=${options.client}${options.client === "mock" && options.mockLatencyMs > 0 ? ` (+${options.mockLatencyMs}ms)` : ""}` +
      `${options.mockFail === null ? "" : ` · stand-in failure=${options.mockFail}`}` +
      ` · traffic=${options.trafficLevel} · driver=${options.driver} · seed=${options.seed}` +
      ` · horizon=${secs(options.horizonMs)} · pace=${paceRatio === 0 ? "unpaced" : `${paceRatio}x`}` +
      ` · trips=${options.trips.length}`,
  );

  const reports: RouteReport[] = [];
  for (const tripId of options.trips) {
    const startedAt = Date.now();
    // ONE controller per route, captured through the seam the app uses, so the
    // run the record describes is the run the world produced.
    let controller: JevController | null = null;
    const run: ScenarioRun = buildScenarioRun(
      model,
      {
        tripId,
        trafficLevel: options.trafficLevel,
        driver: options.driver,
        seed: options.seed,
        durationMs: options.horizonMs,
      },
      {
        controllers: {
          jev: (context) => {
            controller = createJevController({
              client,
              scenarioFingerprint: context.fingerprint,
            });
            return controller;
          },
        },
      },
    );
    const result =
      // A synchronous stand-in needs no event loop; anything live must be
      // paced, exactly like the app, or the run would outrun its own answers.
      options.client === "mock" && options.mockLatencyMs === 0 && paceRatio === 0
        ? run.runUnder("jev")
        : await run.runUnderAsync("jev", { paceRatio });
    if (controller === null) {
      throw new Error("the seam never asked for a jev controller");
    }
    const report = reportFor(tripId, controller, result, options.horizonMs);
    reports.push(report);
    const verdict = routeVerdict(report);
    const wallMs = Date.now() - startedAt;
    console.log(
      `\n[fallback ${verdict.fallbackProblems.length === 0 ? "PASS" : "FAIL"}` +
        ` · trip ${verdict.completionProblems.length === 0 ? "PASS" : "FAIL"}] ${tripId}` +
        ` · ${secs(wallMs)} wall · ${(report.simulatedMs / Math.max(1, wallMs)).toFixed(1)}x achieved` +
        ` · ${report.tripCompleted ? `completed in ${secs(report.tripTimeMs)}` : "NOT COMPLETED"}`,
    );
    for (const problem of verdict.fallbackProblems) {
      console.log(`       fallback: ${problem}`);
    }
    for (const problem of verdict.completionProblems) {
      console.log(`       completion: ${problem}`);
    }
  }

  /* ------------------------------------------------------------ summary --- */
  console.log("\n=== per-route summary ===");
  console.log(
    [
      "trip".padEnd(32),
      "windows live/held/fb".padEnd(20),
      "liveMs".padStart(8),
      "heldMs".padStart(8),
      "fallback".padStart(9),
      "struct".padStart(8),
      "fail".padStart(7),
      "accepted".padStart(9),
      "p50/maxRTT".padStart(13),
      "label",
    ].join(" "),
  );
  for (const report of reports) {
    const outcomes = report.telemetry.outcomes;
    console.log(
      [
        report.tripId.padEnd(32),
        `${outcomes.live}/${outcomes.held}/${outcomes.fallback}`.padEnd(20),
        secs(report.liveMs).padStart(8),
        secs(report.heldMs).padStart(8),
        secs(report.fallbackMs).padStart(9),
        secs(report.structuralFallbackMs).padStart(8),
        secs(report.failureFallbackMs).padStart(7),
        String(report.accepted).padStart(9),
        `${report.latencyP50Ms}/${report.latencyMaxMs}ms`.padStart(13),
        report.label,
      ].join(" "),
    );
  }

  const reasons = new Map<JevRefreshReason, { windows: number; ms: number }>();
  for (const report of reports) {
    for (const [reason, count] of Object.entries(report.telemetry.reasons)) {
      const entry = reasons.get(reason as JevRefreshReason) ?? { windows: 0, ms: 0 };
      entry.windows += count;
      entry.ms += report.reasonMs[reason as JevRefreshReason] ?? 0;
      reasons.set(reason as JevRefreshReason, entry);
    }
  }
  console.log("\n=== per-reason counts (all routes) ===");
  if (reasons.size === 0) {
    console.log("  (no refresh window was anything but live)");
  } else {
    for (const reason of JEV_REFRESH_REASONS) {
      const entry = reasons.get(reason);
      if (entry !== undefined) {
        console.log(`  ${reason.padEnd(20)} windows ${String(entry.windows).padStart(4)} · ${secs(entry.ms)} of fallback`);
      }
    }
  }

  // WHERE it happened, and WHY: the run's own rows, one per non-live window.
  const nonLive = reports.flatMap((report) =>
    report.failures.map((event) => ({ tripId: report.tripId, event })),
  );
  console.log("\n=== every non-live refresh window ===");
  if (nonLive.length === 0) {
    console.log("  (every refresh window in every route produced the policy in force)");
  } else {
    for (const { tripId, event } of nonLive) {
      console.log(
        `  ${tripId.padEnd(32)} #${String(event.index).padStart(3)} at sim ${secs(event.atSimMs).padStart(9)}` +
          ` -> ${event.outcome.padEnd(8)} reason=${(event.reason ?? "none").padEnd(19)}` +
          (event.field === null ? "" : ` field=${event.field} bound=${event.bound}`) +
          `\n      ${event.detail}`,
      );
    }
  }

  console.log("\n=== provenance lines (what a result says about itself) ===");
  for (const report of reports) {
    console.log(`  ${report.tripId}: ${report.line}`);
  }

  if (options.jsonPath !== null) {
    const out = path.resolve(options.jsonPath);
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          client: options.client,
          mockLatencyMs: options.mockLatencyMs,
          mockFail: options.mockFail,
          trafficLevel: options.trafficLevel,
          driver: options.driver,
          seed: options.seed,
          horizonMs: options.horizonMs,
          paceRatio,
          routes: reports.map((report) => ({
            ...report,
            provenance: report.provenance,
            telemetry: report.telemetry,
            failures: report.failures,
          })),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    console.log(`\nreport written to ${out}`);
  }

  const fallbackFailed = reports.filter((report) => routeVerdict(report).fallbackProblems.length > 0);
  const completionFailed = reports.filter(
    (report) => routeVerdict(report).completionProblems.length > 0,
  );
  if (fallbackFailed.length === 0) {
    console.log(
      `\nGATE: fallback-free on ${reports.length}/${reports.length} routes — ZERO fallback windows and ` +
        "ZERO failure-attributed fallback time everywhere.",
    );
    const structural = reports.reduce((sum, report) => sum + report.structuralFallbackMs, 0);
    console.log(
      `      the only fallback time in the run is the structural opening gap: ${secs(structural)} total` +
        " (the policy a refresh produces is in force from the tick after it is accepted).",
    );
  } else {
    console.log(
      `\nGATE: ${fallbackFailed.length}/${reports.length} routes needed the safety net for a failure: ` +
        fallbackFailed.map((report) => report.tripId).join(", "),
    );
  }
  if (completionFailed.length > 0) {
    // Reported, in its own words, always. It is a DIFFERENT failure from a
    // fallback — a trip that did not finish is not the safety net running — and
    // whether it should also fail the gate is a separate question, answered by
    // --require-completion rather than by quietly dropping the check.
    console.log(
      `\nCOMPLETION: ${completionFailed.length}/${reports.length} routes did not finish the trip inside the horizon:`,
    );
    for (const report of completionFailed) {
      console.log(`      ${report.tripId}: ${routeVerdict(report).completionProblems.join("; ")}`);
    }
  }
  if (options.gate && (fallbackFailed.length > 0 || (options.requireCompletion && completionFailed.length > 0))) {
    process.exitCode = 1;
  }
}

/** Importable for tests without running anything (see the guard below). */
export { main as runJevFallbackHarness };

if (process.argv[1]?.includes("jev-fallback-harness") === true) {
  void main().catch((error: unknown) => {
    if (error instanceof UsageError) {
      console.error(error.message);
      process.exitCode = 2;
      return;
    }
    console.error(
      `jev fallback harness failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
