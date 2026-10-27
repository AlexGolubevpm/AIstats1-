import { fmtMoney } from "@/lib/format";
import type { Metric } from "@/server/domain/hypotheses";

/** A metric value in the unit the owner reads it in. */
export function fmtMetric(metric: Metric | null, v: number | null): string {
  if (v == null) return "—";
  if (metric === "view_rate" || metric === "cost_share") return `${(v * 100).toFixed(1)}%`;
  if (metric === "rev_per_1k" || metric === "rpm" || metric === "cost_per_1k") return `$${v.toFixed(4)}`;
  return fmtMoney(v);
}

/** Relative change from the baseline, and whether it is for the better (costs are better lower). */
export function metricDelta(metric: Metric | null, base: number | null, res: number | null) {
  const delta = base != null && res != null && base !== 0 ? (res - base) / Math.abs(base) : null;
  const better = delta != null && (metric === "cost_per_1k" || metric === "cost_share" ? delta < 0 : delta > 0);
  return { delta, better };
}
