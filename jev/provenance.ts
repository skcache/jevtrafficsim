/**
 * Jev provenance (Issue #38): one authoritative, typed account of what produced
 * a Jev result.
 *
 * The credibility rule this exists for: an artifact must be readable on its own.
 * A hostile reader with no repository context has to be able to tell, from the
 * JSON alone, whether a `controller: "jev"` record came from the real service, a
 * deterministic stand-in, a replay, or the Adaptive fallback — and a mock run
 * must never be able to present itself as a live one.
 *
 * Every producer of a Jev result goes through `jevProvenance`: the controller's
 * own `meta()` (which knows its adapter, mode and governed time), plus the trace
 * reference when a recorded run is being replayed. Nothing here changes what the
 * simulation does — it only makes what happened impossible to misread.
 */
import {
  adapterFromId,
  adapterInvolvesModel,
  provenanceLabel,
  type JevAdapter,
  type JevTrace,
  type JevTraceRecordedRun,
} from "./trace";

export { adapterFromId, adapterInvolvesModel, provenanceLabel };
export type { JevAdapter };

/**
 * What a recorded run was, kept inside the trace it produced (Issue #38).
 *
 * A trace records only ACCEPTED policies, so without this a replay would launder
 * the original run's refusals and fallback time into a pristine-looking result.
 * Recorded at `--trace-out` time from the live run's own meta().
 */
export type JevRecordedRun = JevTraceRecordedRun;

/** The trace a replay consumed, without copying its policy events. */
export interface JevTraceReference {
  readonly version: number;
  /** The client string inside the trace (its own account of the original). */
  readonly client: string;
  readonly scenarioFingerprint: string;
  readonly events: number;
}

export interface JevProvenance {
  readonly controller: "jev";
  /** Primary presentation token: "jev-mock" | "jev-gateway" | "jev-schema-service" | "jev-replay". */
  readonly label: string;
  readonly adapter: JevAdapter;
  readonly mode: "live" | "replay";
  /**
   * False when no model participated in THIS execution. For a replay it follows
   * the recorded run: replaying a gateway trace is still model-derived policy,
   * replayed offline (see `recorded`).
   */
  readonly modelInvolved: boolean;
  readonly accepted: number;
  readonly rejected: number;
  readonly refreshes: number;
  readonly expiries: number;
  readonly traceEvents: number;
  readonly liveMs: number;
  readonly replayMs: number;
  readonly fallbackMs: number;
  /**
   * The part of the governed time a policy covered AFTER its freshness window,
   * or null when the producing code predates the field (unknown, never zero).
   * A held run is still the model's policy deciding, but no fresh opinion
   * arrived in time — an artifact must be able to say so.
   */
  readonly heldMs: number | null;
  /** Why the safety net covered the run, when it did. Null = it never did. */
  readonly fallbackReason: string | null;
  /**
   * The fallback time per classified cause, in simulated ms (absent when the
   * producer predates the field). This is the answer to "why did it fall back",
   * measured rather than asserted.
   */
  readonly fallbackCauses?: Readonly<Record<string, number>>;
  /**
   * How many refresh WINDOWS ended live, were held, or needed the safety net
   * (absent when the producer predates the field). The totals above say how much
   * time each source governed; these say how many refreshes went each way, which
   * is the difference between "one long fallback" and "twenty short ones".
   */
  readonly refreshOutcomes?: Readonly<Record<string, number>>;
  /** Why each non-live refresh window was not live, by classified reason. */
  readonly refreshReasons?: Readonly<Record<string, number>>;
  /** Refusals that named a policy field, by field (bounded field names only). */
  readonly refreshFields?: Readonly<Record<string, number>>;
  /** Present on a replay: which trace was consumed. */
  readonly trace: JevTraceReference | null;
  /** Present on a replay: what the recorded run actually was. */
  readonly recorded: JevRecordedRun | null;
}

/**
 * The fields the builder needs, structurally: whatever the controller's meta()
 * produces. Declared here rather than imported so provenance has no dependency
 * on the controller layer.
 */
export interface JevRunMeta {
  readonly kind: "jev";
  readonly mode: "live" | "replay";
  readonly adapter: JevAdapter;
  readonly recorded: JevTraceRecordedRun | null;
  readonly accepted: number;
  readonly rejected: number;
  readonly refreshes: number;
  readonly expiries: number;
  readonly traceEvents: number;
  readonly liveMs: number;
  readonly replayMs: number;
  readonly fallbackMs: number;
  /** Optional so a producer that cannot know it says so instead of "zero". */
  readonly heldMs?: number | null;
  /** The classified cause behind the fallback, when one governed. */
  readonly fallbackReason?: string | null;
  /** Simulated ms of fallback per cause, when the producer knows it. */
  readonly fallbackCauseMs?: Readonly<Record<string, number>>;
  /** The cause that covered the most fallback time, when the producer knows it. */
  readonly dominantFallbackCause?: string | null;
  /**
   * The per-refresh record's counters, when the producer has them (see
   * jev/telemetry.ts). Only counts are taken from it: a provenance document is
   * deterministic by contract, and the per-event wall-clock instants are not.
   */
  readonly telemetry?: {
    readonly outcomes: Readonly<Record<string, number>>;
    readonly reasons: Readonly<Record<string, number>>;
    readonly fields: Readonly<Record<string, number>>;
  } | null;
}

/** Build the provenance record from the controller's account of its own run. */
export function jevProvenance(
  meta: JevRunMeta,
  trace: JevTrace | null = null,
): JevProvenance {
  const adapter: JevAdapter = meta.mode === "replay" ? "replay" : meta.adapter;
  const telemetry = meta.telemetry ?? null;
  return {
    controller: "jev",
    label: provenanceLabel(adapter),
    adapter,
    mode: meta.mode,
    // A replay of a model-derived run is still model-derived policy (replayed
    // offline); only the trace's own account can say so when the block is absent.
    modelInvolved: meta.mode === "replay"
      ? adapterInvolvesModel(meta.recorded?.adapter ?? adapterFromId(trace?.client) ?? "schema-service")
      : adapterInvolvesModel(adapter),
    accepted: meta.accepted,
    rejected: meta.rejected,
    refreshes: meta.refreshes,
    expiries: meta.expiries,
    traceEvents: meta.traceEvents,
    liveMs: meta.liveMs,
    replayMs: meta.replayMs,
    fallbackMs: meta.fallbackMs,
    heldMs:
      typeof meta.heldMs === "number" && Number.isFinite(meta.heldMs) ? meta.heldMs : null,
    fallbackReason: meta.dominantFallbackCause ?? meta.fallbackReason ?? null,
    ...(meta.fallbackCauseMs === undefined || meta.fallbackCauseMs === null
      ? {}
      : { fallbackCauses: { ...meta.fallbackCauseMs } }),
    ...(telemetry === null
      ? {}
      : {
          refreshOutcomes: { ...telemetry.outcomes },
          ...(Object.keys(telemetry.reasons).length === 0
            ? {}
            : { refreshReasons: { ...telemetry.reasons } }),
          ...(Object.keys(telemetry.fields).length === 0
            ? {}
            : { refreshFields: { ...telemetry.fields } }),
        }),
    trace:
      trace === null
        ? null
        : {
            version: trace.version,
            client: trace.client,
            scenarioFingerprint: trace.scenarioFingerprint,
            events: trace.events.length,
          },
    recorded: meta.recorded,
  };
}

/** One line, for stdout and logs: the label first, then what it means. */
export function provenanceLine(provenance: JevProvenance): string {
  const parts = [
    `${provenance.label} (mode=${provenance.mode}, adapter=${provenance.adapter}` +
      `, model=${provenance.modelInvolved ? "yes" : "no"})`,
    `accepted ${provenance.accepted}, rejected ${provenance.rejected},` +
      ` refreshes ${provenance.refreshes}, expiries ${provenance.expiries}`,
    `governed: live ${(provenance.liveMs / 1000).toFixed(1)}s,` +
      ` replay ${(provenance.replayMs / 1000).toFixed(1)}s,` +
      ` fallback ${(provenance.fallbackMs / 1000).toFixed(1)}s`,
  ];
  // Held time and the reason a fallback ran are part of the same account: a run
  // whose policy went stale is not the same artifact as a freshly-driven one,
  // and "it fell back" without a cause is not an answer.
  if (provenance.heldMs !== null && provenance.heldMs > 0) {
    parts.push(`held ${(provenance.heldMs / 1000).toFixed(1)}s past the refresh window`);
  }
  if (provenance.fallbackReason !== null) {
    parts.push(`fallback reason: ${provenance.fallbackReason}`);
  }
  // How many refresh WINDOWS went each way, and why the ones that did not go
  // live did not. A reason with no count beside it cannot say whether it
  // happened once or twenty times, which is the whole point of the record.
  const outcomes = provenance.refreshOutcomes;
  if (outcomes !== undefined && (outcomes.held ?? 0) + (outcomes.fallback ?? 0) > 0) {
    const reasons = Object.entries(provenance.refreshReasons ?? {})
      .map(([reason, count]) => `${reason} x${count}`)
      .join(", ");
    parts.push(
      `windows: ${outcomes.live ?? 0} live, ${outcomes.held ?? 0} held,` +
        ` ${outcomes.fallback ?? 0} fallback${reasons.length === 0 ? "" : ` (${reasons})`}`,
    );
  }
  const refusedFields = Object.entries(provenance.refreshFields ?? {})
    .map(([field, count]) => `${field} x${count}`)
    .join(", ");
  if (refusedFields.length > 0) {
    parts.push(`refused fields: ${refusedFields}`);
  }
  if (provenance.trace !== null) {
    parts.push(
      `trace: ${provenance.trace.events} events from client "${provenance.trace.client}"` +
        ` for scenario ${provenance.trace.scenarioFingerprint}`,
    );
  }
  if (provenance.recorded !== null) {
    parts.push(
      `recorded run: ${provenanceLabel(provenance.recorded.adapter)}` +
        ` (accepted ${provenance.recorded.accepted}, rejected ${provenance.recorded.rejected},` +
        ` fallback ${(provenance.recorded.fallbackMs / 1000).toFixed(1)}s)`,
    );
  }
  return parts.join(" · ");
}
