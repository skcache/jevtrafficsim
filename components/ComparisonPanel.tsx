"use client";

/**
 * The payoff panel: a race first, an experiment underneath.
 *
 * A visitor wants one answer — who got there faster — so the top of this panel is
 * three trip times and one factual sentence. The statistical wall (waits,
 * percentiles, throughput, queued-time share) lives behind SEE DETAILS, because
 * nobody should have to understand p95 to enjoy the result.
 *
 * The fairness guard is untouched and still authoritative: results are only shown
 * side by side when every fingerprint agrees and no run was touched by hand. A
 * modified run gets the refusal, not a table.
 *
 * No winner score, no claim that any controller is universally better: the
 * sentence reports the difference this run measured, in whichever direction it
 * went.
 */
import { useState } from "react";
import type { ChallengeResult } from "@/worker/challenge-result";
import { comparisonVerdictAll } from "@/worker/challenge-result";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
import type { BaselineState } from "@/store/ui-store";
import { comparisonRows, policyLabel, raceDelta, raceEntries } from "./ui-model";

export function ComparisonPanel({
  baselines,
  live,
  policy,
}: {
  baselines: BaselineState;
  live: ChallengeResult;
  policy: PresentationPolicy | null;
}) {
  const [open, setOpen] = useState(false);
  const rows = comparisonRows(baselines.fixed, baselines.adaptive, live);
  const verdict = comparisonVerdictAll([baselines.fixed, baselines.adaptive, live]);
  const visible = policyLabel(live.controller, policy);
  const liveLabel = live.controller === "jev"
    ? visible?.text ?? "Checking Jev"
    : `Watched ${visible?.text ?? live.controller}`;

  if (!verdict.comparable) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <span className="label-micro">This run</span>
        </div>
        <p className="mt-2 text-meta leading-relaxed text-ink-52">
          This run cannot be shown beside the baselines: {verdict.reason}.
        </p>
        <p className="mt-1.5 text-micro leading-relaxed text-ink-38">
          The trip itself still happened — your time was {formatLive(live)}.
        </p>
      </div>
    );
  }

  const entries = raceEntries(baselines.fixed, baselines.adaptive, live, liveLabel);
  const delta = raceDelta(entries, liveLabel);
  const completedTimes = entries.filter((entry) => !entry.incomplete).map((entry) => entry.tripTimeMs);
  const fastestTimeMs = completedTimes.length > 0 ? Math.min(...completedTimes) : null;
  const columns = ["Fixed", "Adaptive", liveLabel] as const;

  return (
    <div data-jev-provenance={policy === null ? undefined : JSON.stringify(policy)} data-jev-label={liveLabel} data-simulated-ms={live.simulatedMs}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="label-micro">Who got there first</span>
      </div>

      <div className="mt-2.5 flex flex-col">
        {entries.map((entry, index) => {
          const fastest = !entry.incomplete && fastestTimeMs !== null && entry.tripTimeMs === fastestTimeMs;
          return (
            <div
              key={entry.key}
              className={`flex items-baseline justify-between gap-3 py-1.5 ${
                index === 0 ? "" : "border-t border-hairline"
              }`}
            >
              <span
                className={`text-meta uppercase tracking-wide ${
                  fastest ? "font-semibold text-ink" : "font-medium text-ink-52"
                }`}
              >
                {entry.label}
              </span>
              <span
                className={`value-num text-[22px] leading-none tracking-tight tabular-nums ${
                  fastest ? "font-semibold text-ink" : "font-medium text-ink-70"
                }`}
              >
                {entry.incomplete ? "—" : entry.formatted}
              </span>
            </div>
          );
        })}
      </div>

      {delta !== null && (
        <p className="mt-2.5 border-t border-hairline pt-2 text-ui leading-snug text-ink">
          {delta.text}
        </p>
      )}
      {visible?.detail !== null && visible !== null && (
        <p className="mt-1.5 text-micro leading-relaxed text-ink-52">{visible.detail}</p>
      )}

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="mt-3 text-micro font-medium uppercase tracking-wide text-ink-52 underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline"
      >
        {open ? "Hide details" : "See details"}
      </button>

      {open && (
        <div className="mt-2 border-t border-hairline pt-2">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="w-[30%] pb-1 text-left label-micro text-ink-38"> </th>
                {columns.map((column) => (
                  <th key={column} className="pb-1 pl-2 text-right label-micro">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-hairline">
                  <td className="py-[3px] text-meta text-ink-52">{row.label}</td>
                  <td className="value-num py-[3px] pl-2 text-right text-meta text-ink">{row.fixed}</td>
                  <td className="value-num py-[3px] pl-2 text-right text-meta text-ink">{row.adaptive}</td>
                  <td className="value-num py-[3px] pl-2 text-right text-meta text-ink">{row.jev}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-micro leading-relaxed text-ink-38">
            Same scenario, same demand, same incidents, same driver — only the signals differ.
            Scenario {live.fingerprint}, {baselines.incidentEntries} automatic incidents.
          </p>
        </div>
      )}
    </div>
  );
}

/** The watched run's own trip time, for the non-comparable case. */
function formatLive(live: ChallengeResult): string {
  const total = Math.max(0, Math.round(live.trip.tripTimeMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
