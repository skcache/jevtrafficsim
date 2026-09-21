/**
 * Baseline worker (Issue #15): the two deterministic baselines for the scenario
 * the user is watching, computed OFF the interactive thread.
 *
 * The product's experiment is one scenario run three ways: the visible Jev run
 * plus Fixed and Adaptive on exactly the same world. The baselines are headless
 * and much slower than real time, so running them in the simulation worker would
 * starve the live renderer. This worker is that separate path — the SAME
 * comparison code the interactive worker calls (`runComparison`), in its own
 * thread, so the trip on screen never stalls.
 *
 * It posts exactly one message per request and keeps no state.
 */
import { loadChicagoCity } from "@/cities/chicago-assets";
import { METRO_SCALE_INDEX } from "@/cities/chicago-trips";
import { runComparison } from "@/worker/challenge-compare";
import { parseBaselinesCommand, type BaselinesCommand, type BaselinesEvent } from "@/worker/protocol";

const scope = self as unknown as { onmessage: ((event: MessageEvent) => void) | null; postMessage: (message: unknown) => void };

function post(event: BaselinesEvent): void {
  scope.postMessage(event);
}

async function run(command: BaselinesCommand): Promise<void> {
  try {
    // The curated challenges are defined against the Metro graph, so the
    // baselines load exactly the geography the live run is playing.
    const model = await loadChicagoCity(METRO_SCALE_INDEX);
    const outcome = runComparison(model, {
      tripId: command.tripId,
      trafficLevel: command.trafficLevel,
      driver: command.driver,
      seed: command.seed,
      durationMs: command.durationMs,
    });
    post({
      type: "BASELINES_RESULT",
      fingerprint: outcome.fingerprint,
      driver: outcome.driver,
      tripId: outcome.tripId,
      trafficLevel: outcome.trafficLevel,
      fixed: outcome.fixed,
      adaptive: outcome.adaptive,
      incidentEntries: outcome.incidentEntries,
    });
  } catch (error) {
    post({
      type: "BASELINES_ERROR",
      message: `baseline run failed: ${String((error as Error)?.message ?? error)}`,
    });
  }
}

scope.onmessage = (event: MessageEvent) => {
  let command: BaselinesCommand;
  try {
    command = parseBaselinesCommand(event.data);
  } catch (error) {
    post({
      type: "BASELINES_ERROR",
      message: String((error as Error)?.message ?? error),
    });
    return;
  }
  void run(command);
};
