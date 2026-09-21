"use client";

/**
 * The payoff panel (Issue #15): one scenario, three runs.
 *
 * Fixed and Adaptive are the headless baselines for exactly the scenario the
 * user watched; the third column is the run they watched — labelled by who
 * really governed its signals ("Jev" only when the live policy actually did).
 * The panel refuses to put results side by side unless every fingerprint agrees
 * and no run was touched by hand: that guard is the whole point of the
 * experiment, so it is shown, not hidden.
 *
 * No winner is declared. Every cell is a field of a real run, formatted.
 */
import type { ChallengeResult } from "@/worker/challenge-result";
import { comparisonVerdictAll } from "@/worker/challenge-result";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
import type { BaselineState } from "@/store/ui-store";
import { comparisonRows, policyLabel } from "./ui-model";

export function ComparisonPanel({
  baselines,
  live,
  policy,
}: {
  baselines: BaselineState;
  live: ChallengeResult;
  policy: PresentationPolicy | null;
}) {
  const rows = comparisonRows(baselines.fixed, baselines.adaptive, live);
  const verdict = comparisonVerdictAll([baselines.fixed, baselines.adaptive, live]);
  const visible = policyLabel("jev", policy);

  // The third column is named for whoever actually drove the signals.
  const columns = ["Fixed", "Adaptive", visible?.text ?? "Jev"] as const;

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="label-micro">Same scenario · three runs</span>
        <span className="value-num text-micro text-ink-38">{live.fingerprint}</span>
      </div>

      {verdict.comparable ? (
        <>
          <table className="mt-2.5 w-full border-collapse">
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
          {visible?.detail !== null && visible !== null && (
            <p className="mt-2.5 border-t border-hairline pt-2 text-micro leading-relaxed text-ink-52">
              {visible.detail}
            </p>
          )}
        </>
      ) : (
        <p className="mt-2 text-meta leading-relaxed text-ink-52">
          This run cannot be shown beside the baselines: {verdict.reason}.
        </p>
      )}
    </div>
  );
}
