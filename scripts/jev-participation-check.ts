import type { PresentationPolicy } from "../worker/presentation-snapshot";
import { policyLabel } from "../components/ui-model";
import { SIMULATION_TIMESTEP_MS } from "../sim/config";

/**
 * Check a completed public run against the PURE JEV EXECUTION CONTRACT.
 *
 * A run labelled Jev means one thing: Jev-derived policy controlled 100% of the
 * simulated signal-decision time. This is the release assertion, so every part
 * of that claim is checked here, and an artifact that cannot state one of them
 * fails rather than being assumed clean:
 *
 *   - no fallback time and no Adaptive decision tick, ever
 *   - no simulated instant left ungoverned
 *   - the run was not invalidated (Jev was never lost mid-run)
 *   - the governed time accounts for the run's own simulated window
 *   - the public label agrees with the run's provenance
 */
export function checkLiveJevParticipation(
  policy: PresentationPolicy | null,
  publicLabel: string,
  simulatedMs: number,
): void {
  if (policy === null) throw new Error("run has no Jev provenance");
  const counts = [policy.accepted, policy.rejected, policy.refreshes];
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("invalid policy request accounting");
  }
  if (policy.accepted + policy.rejected > policy.refreshes) {
    throw new Error("policy outcomes exceed requests");
  }
  const times = [policy.liveMs, policy.replayMs, policy.invalidMs ?? 0, policy.fallbackMs];
  // The runtime closes its accounting at the run's final instant. An artifact
  // that predates that closure may leave one tick open, which is allowed.
  const accountedMs = times.reduce((sum, value) => sum + value, 0);
  const tailMs = simulatedMs - accountedMs;
  if (times.some((value) => !Number.isFinite(value) || value < 0) ||
      !Number.isFinite(simulatedMs) || simulatedMs <= 0 ||
      (tailMs !== 0 && tailMs !== SIMULATION_TIMESTEP_MS)) {
    throw new Error("governed time does not match run time");
  }
  const expectedLabel = policyLabel("jev", policy)?.text;
  if (publicLabel !== expectedLabel) throw new Error("public label disagrees with provenance");
  if (policy.accepted === 0 && publicLabel === "Jev") {
    throw new Error("zero accepted policies presented as Jev");
  }
  // A run that LOST Jev mid-way is not a completed Jev result, whatever else it
  // reports; a run still waiting for its first policy is not a Jev run at all.
  if (policy.invalidation !== undefined && policy.invalidation !== null) {
    throw new Error("the run was invalidated: not a completed Jev result");
  }
  if (policy.source !== "live" || policy.replayMs !== 0 || policy.accepted <= 0 || policy.liveMs <= 0) {
    throw new Error("no live Jev participation");
  }
  // NO ADAPTIVE ANYWHERE: not a millisecond of time, not a single tick.
  if (policy.fallbackMs !== 0) throw new Error("fallback time in a Jev run");
  if (policy.adaptiveTicks !== 0) throw new Error("an Adaptive controller decided ticks");
  // NO UNGOVERNED TIME — and a run that cannot state the number cannot pass.
  if (policy.invalidMs === undefined) throw new Error("run does not state its ungoverned time");
  if (policy.invalidMs !== 0) throw new Error("ungoverned time in a Jev run");
}
