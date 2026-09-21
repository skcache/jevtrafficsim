"use client";

/**
 * The compact Fixed-vs-Adaptive panel (Issue #28).
 *
 * One scenario, two runs, one table. The panel refuses to compare runs whose
 * scenario fingerprints differ — that guard is the whole point of the feature,
 * so it is shown, not hidden.
 */
import type { ComparisonState } from "@/store/ui-store";
import { comparisonRows } from "./ui-model";

export function ComparisonPanel({ comparison }: { comparison: ComparisonState }) {
  const rows = comparisonRows(comparison.fixed, comparison.adaptive);
  return (
    <div className="rounded-control border border-hairline bg-surface-94 px-3 py-2.5">
      <div className="flex items-baseline justify-between">
        <span className="label-micro">Fixed vs Adaptive</span>
        <span className="value-num text-micro text-ink-38">{comparison.fingerprint}</span>
      </div>
      {comparison.verdict.comparable ? (
        <table className="mt-2 w-full border-collapse">
          <thead>
            <tr>
              <th className="w-2/5 pb-1 text-left label-micro text-ink-38"> </th>
              <th className="pb-1 text-right label-micro">Fixed</th>
              <th className="pb-1 text-right label-micro">Adaptive</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-hairline">
                <td className="py-1 text-meta text-ink-52">{row.label}</td>
                <td className="value-num py-1 text-right text-meta text-ink">{row.fixed}</td>
                <td className="value-num py-1 text-right text-meta text-ink">{row.adaptive}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="mt-2 text-meta leading-relaxed text-ink-52">{comparison.verdict.reason}</p>
      )}
    </div>
  );
}
