/**
 * Simulation receipts (Issue #40, Phase 5).
 *
 * The performance refactor touched the data structures every metric reads, so
 * "the result did not change" has to be a check, not a promise. `scripts/receipts.ts`
 * serializes everything observable about a run — the ChallengeResult, the final
 * SimulationMetrics, every arrival in order with its times, the incident
 * outcomes, the frozen incident plan, the population counts and the scenario
 * fingerprint — into one canonical JSON body with a SHA-256 prefix.
 *
 * The fixtures were written BEFORE the refactor, against the pre-#40 engine, and
 * are committed unchanged. A single field moving anywhere in that body changes
 * the hash and fails here.
 *
 *   npx tsx scripts/receipts.ts write tests/fixtures/sim-receipts.json   # regenerate (only on purpose)
 *   npx tsx scripts/receipts.ts show  tests/fixtures/sim-receipts.json   # list hashes
 *
 * Only two cases run in the suite (a full 600 s run each): one Fixed, one
 * Adaptive. The remaining four stay in the fixture and are checked by the
 * script, so the fast path stays fast and the evidence stays complete.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RECEIPT_CASES, runReceiptCase, type Receipt } from "../scripts/receipts";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/sim-receipts.json", import.meta.url), "utf8"),
) as { horizonMs: number; receipts: readonly { name: string; hash: string; body: string }[] };

const pinned = new Map(fixture.receipts.map((receipt) => [receipt.name, receipt]));

/** The cases the suite runs in full: one per baseline controller. */
const SUITE_CASES = ["soldier-adaptive-rush", "soldier-fixed-rush"] as const;

describe("deterministic simulation receipts", () => {
  it("pins the horizon the receipts were recorded at", () => {
    expect(fixture.horizonMs).toBe(600_000);
    expect(fixture.receipts).toHaveLength(RECEIPT_CASES.length);
    for (const testCase of RECEIPT_CASES) {
      expect(pinned.has(testCase.name)).toBe(true);
    }
  });

  for (const name of SUITE_CASES) {
    it(
      `${name}: identical ChallengeResult, metrics, arrivals and incidents`,
      { timeout: 300_000 },
      () => {
        const testCase = RECEIPT_CASES.find((candidate) => candidate.name === name);
        expect(testCase).toBeDefined();
        const expected = pinned.get(name);
        expect(expected).toBeDefined();

        const receipt: Receipt = runReceiptCase(testCase!);
        expect(receipt.hash).toBe(expected!.hash);
        // The hash is the claim; these are the readable form of it, so a failure
        // shows what moved instead of only "a hex string differs".
        expect(JSON.parse(receipt.body)).toEqual(JSON.parse(expected!.body));
        expect(receipt.body).toBe(expected!.body);
      },
    );
  }

  it("records the populations each receipt describes", () => {
    for (const name of SUITE_CASES) {
      const body = JSON.parse(pinned.get(name)!.body) as {
        population: { spawned: number; active: number; arrived: number; pending: number };
        arrivals: readonly unknown[];
        incidents: readonly { status: string }[];
        vehicleCount: number;
      };
      // The refactor split live state from history, so both populations are
      // pinned: the arrival list must still cover every arrived vehicle.
      expect(body.vehicleCount).toBe(body.population.spawned);
      expect(body.arrivals.length).toBeGreaterThan(100);
      expect(body.population.arrived).toBeGreaterThan(100);
      expect(body.population.active + body.population.arrived + body.population.pending).toBe(
        body.population.spawned,
      );
      expect(body.incidents.length).toBeGreaterThan(0);
    }
  });
});
