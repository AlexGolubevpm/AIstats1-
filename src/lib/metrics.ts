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
/** CTR — clicks per impression (ours). ADOK counts clicks per row, so it exists wherever impressions do. */
export const ctr = (clicks: number, impsOwn: number): Num => ratio(clicks, impsOwn);
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

// ---------- «Закупка T1/T2»: may the bid go up? (ADR 0023, docs/product/06-metrics.md#bid) ----------

export interface BidInput {
  /** Popunder revenue on T1/T2 traffic, $. */ popRevenue: number;
  /** All ADOK revenue on T1/T2 traffic, $ (context: a bought load also earns banners). */ allRevenue: number;
  /** T1/T2 page loads (country cut). */ loads: number;
  /** What the paid sources' T1/T2 traffic cost, $. */ cost: number;
  /** T1/T2 loads of the paid sources. */ paidLoads: number;
}
export type BidVerdict = "raise" | "edge" | "hold" | "no_data";
export interface BidAdvice {
  popPer1k: Num; allPer1k: Num; costPer1k: Num;
  /** Popunder revenue minus the price, per 1000 bought loads. */ popMarginPer1k: Num;
  /** The price of 1000 loads popunder alone still pays with the target margin. */ maxBid: Num;
  /** maxBid against today's price: +0.25 = the bid may go up 25%. */ headroom: Num;
  verdict: BidVerdict;
}

/**
 * Compares the price of 1000 bought T1/T2 loads with the popunder revenue they bring. A bought load
 * is assumed to earn like the site's average T1/T2 load (same pages, same waterfall). Ratios of sums.
 */
export function bidAdvice(x: BidInput, targetMargin = 0.2): BidAdvice {
  const popPer1k = revPer1kLoads(x.popRevenue, x.loads), allPer1k = revPer1kLoads(x.allRevenue, x.loads), costPer1k = ratio(x.cost, x.paidLoads, 1000);
  const maxBid = popPer1k == null ? null : popPer1k * (1 - targetMargin);
  const popMarginPer1k = popPer1k == null || costPer1k == null ? null : popPer1k - costPer1k;
  const headroom = maxBid == null || costPer1k == null || costPer1k <= 0 ? null : maxBid / costPer1k - 1;
  const verdict: BidVerdict = headroom == null ? "no_data" : headroom > 0.05 ? "raise" : headroom >= -0.05 ? "edge" : "hold";
  return { popPer1k, allPer1k, costPer1k, popMarginPer1k, maxBid, headroom, verdict };
}

export interface BidDay { loads: number; popRevenue: number; cost: number; paidLoads: number }
/**
 * What happened on dearer days: days with a known price are split at the median price of 1000 loads;
 * the dearer half against the cheaper one — price, loads a day and popunder revenue per 1000 loads.
 * Null below 4 such days.
 */
export function bidElasticity(days: BidDay[]): { priceChange: Num; loadsChange: Num; popPer1kChange: Num; days: number } | null {
  const priced = days.filter((d) => d.paidLoads > 0 && d.cost > 0 && d.loads > 0).map((d) => ({ ...d, price: d.cost / d.paidLoads }));
  if (priced.length < 4) return null;
  priced.sort((a, b) => a.price - b.price);
  const half = Math.floor(priced.length / 2), low = priced.slice(0, half), high = priced.slice(priced.length - half);
  const sum = (xs: typeof priced, k: "loads" | "popRevenue" | "cost" | "paidLoads") => xs.reduce((a, d) => a + d[k], 0);
  const price = (xs: typeof priced) => ratio(sum(xs, "cost"), sum(xs, "paidLoads"), 1000);
  const per1k = (xs: typeof priced) => revPer1kLoads(sum(xs, "popRevenue"), sum(xs, "loads"));
  const ch = (a: Num, b: Num) => (a == null || b == null || b === 0 ? null : a / b - 1);
  return { priceChange: ch(price(high), price(low)), loadsChange: ch(sum(high, "loads") / high.length, sum(low, "loads") / low.length), popPer1kChange: ch(per1k(high), per1k(low)), days: priced.length };
}
