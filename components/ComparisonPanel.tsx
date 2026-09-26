"use client";

/**
 * The payoff panel: a race first, an experiment underneath.
 *
 * A visitor wants one answer — who got there faster — so the top of this panel is
 * three trip times and one factual sentence. The statistical wall (waits,
 * percentiles, throughput, queued-time share) lives behind SEE DETAILS, because
 * nobody should have to understand p95 to enjoy the result.
 *
 * The fairness guard is untouched and still authoritative: `comparisonVerdictAll`
 * decides whether these three results are a comparison at all, and a refusal for
 * a different world or a repeated controller still shows no table.
 *
 * One refusal changed shape, by the owner's decision: a run that was changed by
 * hand keeps its numbers on screen, under a marker that says — in the run's own
 * words, and only when the run recorded them — what was changed and when, and
 * that the result is therefore not a like-for-like comparison. `alteredComparisonAllowed`
 * (the guard's own answer about the untouched counterfactual) is what permits it;
 * without it, the refusal stands exactly as it always has. The difference
 * sentence is not shown for an altered run: "faster than Adaptive" is a
 * comparison claim, and this panel is not allowed to make one here.
 *
 * No winner score, no claim that any controller is universally better: the
 * sentence reports the difference this run measured, in whichever direction it
 * went — and only where the run was left alone.
 */
import { useState } from "react";
import type { ChallengeResult } from "@/worker/challenge-result";
import { alteredComparisonAllowed, comparisonVerdictAll } from "@/worker/challenge-result";
import type { PresentationPolicy } from "@/worker/presentation-snapshot";
import type { BaselineState } from "@/store/ui-store";
import {
  ALTERED_COMPARISON_FOOTER,
  COMPARISON_FOOTER,
  alteredRunNotice,
  comparisonRows,
  policyLabel,
  raceDelta,
  raceEntries,
} from "./ui-model";

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
  const notice = alteredRunNotice(live);
  /**
   * The owner's rule, decided by the guard itself: an altered run's numbers are
   * shown, marked. `alteredComparisonAllowed` only says yes when the alteration
   * is the sole reason for the refusal, so every other refusal — a different
   * world, the same controller twice — still renders no numbers at all.
   */
  const alteredNumbers = alteredComparisonAllowed(baselines.fixed, baselines.adaptive, live);
  const visible = policyLabel(live.controller, policy);
  const liveLabel = live.controller === "jev"
    ? visible?.text ?? "Checking Jev"
    : `Watched ${visible?.text ?? live.controller}`;

  if (!verdict.comparable && !alteredNumbers) {
    return (
      <div>
        <span className="label-micro">This run</span>
        <p className="mt-2.5 text-ui leading-relaxed text-ink">
          No comparison for this run — {verdict.reason}.
        </p>
        <p className="mt-1.5 text-meta leading-relaxed text-ink-70">
          The trip still happened — your time was {formatLive(live)}.
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
    <div data-jev-provenance={policy === null ? undefined : JSON.stringify(policy)} data-jev-label={liveLabel} data-simulated-ms={live.simulatedMs} data-jev-altered={alteredNumbers ? "true" : undefined}>
      <span className="label-micro">Who got there first</span>

      {/* The honest marker, above the numbers it qualifies: what a human changed,
          when, and the one thing these columns are not. */}
      {alteredNumbers && notice !== null && (
        <div
          role="note"
          className="mt-3 rounded-control border border-hair-strong bg-ink/[0.035] px-3 py-2.5"
        >
          <p className="flex items-center gap-1.5 text-meta font-semibold text-ink">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[#b0392b]" aria-hidden="true" />
            {notice.title}
          </p>
          <p className="mt-1 text-meta leading-relaxed text-ink-70">
            {notice.detail} {notice.boundary}
          </p>
        </div>
      )}

      <div className="mt-3 flex flex-col">
        {entries.map((entry, index) => {
          const fastest = !entry.incomplete && fastestTimeMs !== null && entry.tripTimeMs === fastestTimeMs;
          return (
            <div
              key={entry.key}
              className={`flex items-baseline justify-between gap-3 py-2 ${
                index === 0 ? "" : "border-t border-hairline"
              }`}
            >
              <span
                className={`text-meta uppercase tracking-wide ${
                  fastest ? "font-semibold text-ink" : "font-medium text-ink-70"
                }`}
              >
                {entry.label}
              </span>
              <span
                className={`value-num text-[26px] leading-none tracking-tight tabular-nums ${
                  fastest ? "font-semibold text-ink" : "font-medium text-ink-70"
                }`}
              >
                {entry.incomplete ? "—" : entry.formatted}
              </span>
            </div>
          );
        })}
      </div>

      {/* No difference sentence for an altered run: naming a winner here would be
          a comparison claim the run cannot support. The marker above already
          says what the numbers are. */}
      {delta !== null && !alteredNumbers && (
        <p className="mt-3 border-t border-hairline pt-2.5 text-ui leading-snug text-ink">
          {delta.text}
        </p>
      )}
      {visible?.detail !== null && visible !== null && (
        <p className="mt-1.5 text-meta leading-relaxed text-ink-70">{visible.detail}</p>
      )}

      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="mt-3.5 text-meta font-medium text-ink-70 underline-offset-2 transition-colors duration-150 hover:text-ink hover:underline focus-visible:text-ink focus-visible:underline"
      >
        {open ? "Hide details" : "See details"}
      </button>

      {open && (
        <div className="mt-3 border-t border-hairline pt-3">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="w-[30%] pb-1.5 text-left label-micro"> </th>
                {columns.map((column) => (
                  <th key={column} className="pb-1.5 pl-2 text-right label-micro">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.label} className="border-t border-hairline">
                  <td className="py-1 text-meta text-ink-70">{row.label}</td>
                  <td className="value-num py-1 pl-2 text-right text-meta text-ink">{row.fixed}</td>
                  <td className="value-num py-1 pl-2 text-right text-meta text-ink">{row.adaptive}</td>
                  <td className="value-num py-1 pl-2 text-right text-meta text-ink">{row.jev}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2.5 text-meta leading-relaxed text-ink-70">
            {alteredNumbers ? ALTERED_COMPARISON_FOOTER : COMPARISON_FOOTER}
          </p>
          <p className="mt-1 text-micro leading-relaxed text-ink-38">
            Scenario {live.fingerprint}, {baselines.incidentEntries} automatic incidents.
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * What the comparison looks like while it is being prepared.
 *
 * The wait after arrival is real work, not a stall: the run's window has to
 * close before the citywide rows can be read from it (see SimChrome's
 * ARRIVED_FINISHING_TEXT). This is the panel's own shape, in grey — the same
 * micro-label, the same three race rows (label left, time right), the same
 * sentence line and the same disclosure underneath — so the eye already knows
 * what is coming. The rows are the real rows' own classes at the real rows'
 * measured height (43.5/44.5 px, 44 px pitch), so each number lands exactly
 * where its bar was — the panel as a whole shifts up a little, because the
 * arrival copy above the rows is replaced by the shorter run-complete label.
 *
 * Placeholders only: no spinner, no percentage, no invented progress. The whole
 * block is decorative (`aria-hidden`); the announcement lives in the chrome's
 * status region. `refusal` is the shape a refusal has — two sentences, not three
 * times — and it is also where an altered run's panel now opens: the marker's
 * title and paragraph sit in exactly that place before the rows arrive.
 */
export type ComparisonSkeletonVariant = "race" | "refusal";

export function ComparisonSkeleton({
  variant = "race",
}: {
  variant?: ComparisonSkeletonVariant;
} = {}) {
  return (
    <div
      aria-hidden="true"
      data-jev-skeleton={variant}
      className="mt-4 animate-pulse motion-reduce:animate-none"
    >
      <Placeholder className="h-[9px] w-28" />
      {variant === "refusal" ? (
        <div className="mt-3 flex flex-col gap-2.5">
          <Placeholder className="h-[11px] w-[82%]" />
          <Placeholder className="h-[11px] w-[54%]" />
        </div>
      ) : (
        <>
          <div className="mt-3 flex flex-col">
            {[0, 1, 2].map((row) => (
              <div
                key={row}
                className={`flex items-baseline justify-between gap-3 py-2 ${
                  row === 0 ? "" : "border-t border-hairline"
                }`}
              >
                <Placeholder className="h-[11px] w-24" />
                {/* 27.5px is the measured height of the real row's content:
                    the 26px value's line box plus the baseline the label sits
                    on, so the number lands exactly where its bar was. */}
                <Placeholder className="h-[27.5px] w-16" />
              </div>
            ))}
          </div>
          <div className="mt-3 border-t border-hairline pt-2.5">
            <Placeholder className="h-[11px] w-3/4" />
          </div>
        </>
      )}
      <Placeholder className="mt-3.5 h-[11px] w-16" />
    </div>
  );
}

/** One grey bar of the skeleton — the same material the trip HUD uses. */
function Placeholder({ className }: { className: string }) {
  return <span className={`block rounded-full bg-ink/10 ${className}`} />;
}

/** The watched run's own trip time, for the non-comparable case. */
function formatLive(live: ChallengeResult): string {
  const total = Math.max(0, Math.round(live.trip.tripTimeMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
