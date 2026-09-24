// Metric formulas shared by UI and server. Every metric is a ratio of SUMS; callers pass
// totals, never pre-computed per-row ratios. Division by zero returns null (UI shows "—").
// Reference: docs/product/06-metrics.md.

export type Num = number | null;

function ratio(num: number, den: number, scale = 1): Num {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return null;
  return (num / den) * scale;
}

/** Revenue per 1000 page loads, $. Main metric for comparing networks within a geo. */
export const revPer1kLoads = (revenue: number, pageLoads: number): Num => ratio(revenue, pageLoads, 1000);
/** Revenue per 1000 uniques, $. Compares sites and bundles. */
export const rpm = (revenue: number, uniques: number): Num => ratio(revenue, uniques, 1000);
/** CPM on own impressions, $. Meaningful only within one format. */
export const cpm = (revenue: number, impsOwn: number): Num => ratio(revenue, impsOwn, 1000);
/** Revenue per 1000 viewable impressions, $. BANNER / NATIVE. */
export const viewableCpm = (revenue: number, views: number): Num => ratio(revenue, views, 1000);
/** Viewable share of own impressions, 0..1. */
export const viewRate = (views: number, impsOwn: number): Num => ratio(views, impsOwn);
/** Filled share of page loads, 0..1. */
export const fillRate = (impsOwn: number, pageLoads: number): Num => ratio(impsOwn, pageLoads);
/** (own − network) / own, 0..1; negative means the advertiser counts more. */
export const discrepancy = (impsOwn: number, impsNetwork: number): Num => ratio(impsOwn - impsNetwork, impsOwn);
/** Advertiser impressions per own impression (fixed deals). */
export const dealMultiplier = (impsReported: number, impsOwn: number): Num => ratio(impsReported, impsOwn);
/** Cost per bought unique, $. */
export const costPerUnique = (cost: number, uniquesBought: number): Num => ratio(cost, uniquesBought);
/** revenue − cost, $. */
export const margin = (revenue: number, cost: number): number => revenue - cost;
/** (revenue − cost) / cost, percent. Undefined without cost. */
export const romi = (revenue: number, cost: number): Num => ratio(revenue - cost, cost, 100);
/** Pageviews per unique. */
export const depth = (pageviews: number, uniques: number): Num => ratio(pageviews, uniques);
/** Share of a total, 0..1. */
export const share = (part: number, total: number): Num => ratio(part, total);

export type DeltaMode = "percent" | "pp" | "abs";

/**
 * Change against the previous equal period. Percent metrics (ROMI, rates) use percentage
 * points; counts and money use percent change. Null when the base is zero or missing.
 */
export function delta(current: Num, previous: Num, mode: DeltaMode): Num {
  if (current == null || previous == null) return null;
  if (mode === "pp" || mode === "abs") return current - previous;
  return previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;
}

/** True when a value deviates from the slice mean by more than 20% — the only case cells get a heat fill. */
export function isNotableDeviation(value: Num, mean: Num, threshold = 0.2): boolean {
  if (value == null || mean == null || mean === 0) return false;
  return Math.abs(value - mean) / Math.abs(mean) > threshold;
}

export type DiscrepancyLevel = "ok" | "warning" | "negative";
/** ±10% neutral, 10–25% warning, beyond — negative. */
export function discrepancyLevel(value: Num): DiscrepancyLevel {
  if (value == null) return "ok";
  const a = Math.abs(value);
  return a <= 0.1 ? "ok" : a <= 0.25 ? "warning" : "negative";
}
