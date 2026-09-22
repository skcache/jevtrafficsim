import type { PresentationPolicy } from "../worker/presentation-snapshot";
import { policyLabel } from "../components/ui-model";
import { SIMULATION_TIMESTEP_MS } from "../sim/config";

/** Check a completed public run, without changing its Adaptive safety fallback. */
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
  const times = [policy.liveMs, policy.replayMs, policy.fallbackMs];
  // The runtime accounts each interval at the next observation. At RUN_COMPLETE
  // the engine has stepped once past the last observation, leaving one tick.
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
  if (policy.source === "replay" || policy.replayMs !== 0 || policy.accepted <= 0 || policy.liveMs <= 0) {
    throw new Error("no live Jev participation");
  }
}
