// Fixed deals: amount per payment basis, forecast, billing periods, and distribution of a
// period amount back to days so every page and MCP sees the same daily grain.
// Reference: docs/product/04-finance-and-deals.md.
import Decimal from "decimal.js";

export type PaymentBasis = "PER_1000_LOADS" | "CPM_ADVERTISER" | "CPM_OWN" | "FLAT_DAILY" | "FLAT_PERIOD";
export type BillingPeriod = "MONTH" | "WEEK" | "TERM";
export type PeriodStatus = "OPEN" | "INVOICED" | "PAID" | "PARTIAL" | "DISPUTED" | "WRITTEN_OFF";

export interface Counters { pageLoads: number; impsOwn: number; impsReported?: number | null; days: number }

/**
 * Amount due for counters under a payment basis. For CPM_ADVERTISER without advertiser numbers
 * (forecast) our own impressions are used as the best estimate.
 */
export function calcAmount(basis: PaymentBasis, price: Decimal.Value, c: Counters, periodDays?: number): Decimal {
  const p = new Decimal(price);
  switch (basis) {
    case "PER_1000_LOADS": return p.mul(c.pageLoads).div(1000).toDecimalPlaces(4);
    case "CPM_OWN": return p.mul(c.impsOwn).div(1000).toDecimalPlaces(4);
    case "CPM_ADVERTISER": return p.mul(c.impsReported ?? c.impsOwn).div(1000).toDecimalPlaces(4);
    case "FLAT_DAILY": return p.mul(c.days).toDecimalPlaces(4);
    case "FLAT_PERIOD": return periodDays ? p.mul(c.days).div(periodDays).toDecimalPlaces(4) : p;
  }
}

/** Which counter the amount is proportional to: used to spread a period amount over days. */
export function weightOf(basis: PaymentBasis, c: { pageLoads: number; impsOwn: number }): number {
  switch (basis) {
    case "PER_1000_LOADS": return c.pageLoads;
    case "CPM_OWN":
    case "CPM_ADVERTISER": return c.impsOwn;
    default: return 1; // flat: evenly by day
  }
}

export interface Cell { date: string; siteId: string; countryCode: string; weight: number }

/**
 * Splits `amount` over cells proportionally to weight at 4 decimals; the rounding remainder
 * goes to the last day so the sum matches the period exactly. Zero total weight → even split.
 */
export function distribute(amount: Decimal.Value, cells: Cell[]): (Cell & { amount: Decimal })[] {
  if (!cells.length) return [];
  const total = new Decimal(amount);
  const w = cells.reduce((a, c) => a + Math.max(0, c.weight), 0);
  const sorted = [...cells].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? -1 : 1));
  let assigned = new Decimal(0);
  const out = sorted.map((c) => {
    const share = w > 0 ? total.mul(Math.max(0, c.weight)).div(w) : total.div(cells.length);
    const v = share.toDecimalPlaces(4, Decimal.ROUND_DOWN);
    assigned = assigned.add(v);
    return { ...c, amount: v };
  });
  const rest = total.sub(assigned);
  if (!rest.isZero()) {
    const lastDate = out[out.length - 1].date;
    const target = out.filter((c) => c.date === lastDate).reduce((a, b) => (b.weight > a.weight ? b : a));
    target.amount = target.amount.add(rest);
  }
  return out;
}

export interface GeoScope { geoScope: string[]; geoExclude: boolean }
export function inGeoScope(d: GeoScope, country: string): boolean {
  if (!d.geoScope.length) return true;
  const hit = d.geoScope.includes(country);
  return d.geoExclude ? !hit : hit;
}

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (s: string) => Date.parse(`${s}T00:00:00Z`);

/** Billing periods that are fully closed on or before `today` (exclusive). */
export function closedPeriods(d: { startsAt: string; endsAt: string | null; billingPeriod: BillingPeriod }, today: string): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = [];
  const end = d.endsAt && d.endsAt < today ? d.endsAt : iso(ms(today) - DAY);
  if (d.billingPeriod === "TERM") {
    if (d.endsAt && d.endsAt < today) out.push({ from: d.startsAt, to: d.endsAt });
    return out;
  }
  let from = d.startsAt;
  while (from <= end) {
    const f = new Date(ms(from));
    const to = d.billingPeriod === "MONTH"
      ? iso(Date.UTC(f.getUTCFullYear(), f.getUTCMonth() + 1, 1) - DAY)
      : iso(ms(from) + (6 - ((f.getUTCDay() + 6) % 7)) * DAY); // week ends on Sunday
    const cut = d.endsAt && d.endsAt < to ? d.endsAt : to;
    if (cut > end) break;
    out.push({ from, to: cut });
    from = iso(ms(cut) + DAY);
  }
  return out;
}

export function periodsOverlap(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  return a.from <= b.to && b.from <= a.to;
}

export function addDays(s: string, n: number): string { return iso(ms(s) + n * DAY); }

/** Revenue state a period gives to its days. */
export function revenueStateOf(status: PeriodStatus): "FORECAST" | "INVOICED" | "CONFIRMED" {
  if (status === "PAID" || status === "PARTIAL" || status === "WRITTEN_OFF") return "CONFIRMED";
  if (status === "INVOICED") return "INVOICED";
  return "FORECAST";
}

/** Amount that counts as revenue for a period in its current status. DISPUTED counts as forecast of the invoice. */
export function effectiveAmount(p: { status: PeriodStatus; amountInvoiced: Decimal.Value | null; amountPaid: Decimal.Value | null; amountCalculated: Decimal.Value | null }): Decimal {
  const v = (x: Decimal.Value | null) => (x == null ? null : new Decimal(x));
  switch (p.status) {
    case "PAID": case "PARTIAL": case "WRITTEN_OFF": return v(p.amountPaid) ?? v(p.amountInvoiced) ?? new Decimal(0);
    case "INVOICED": case "DISPUTED": return v(p.amountInvoiced) ?? v(p.amountCalculated) ?? new Decimal(0);
    default: return v(p.amountCalculated) ?? new Decimal(0);
  }
}

export class DealRuleError extends Error {
  constructor(public code: string, message: string, public field?: string) { super(message); }
}

/** Status after recording a payment; underpayment needs an explicit choice. */
export function statusAfterPayment(invoiced: Decimal.Value, paid: Decimal.Value, remainder: "open" | "write_off" | undefined, reason?: string): PeriodStatus {
  const inv = new Decimal(invoiced), got = new Decimal(paid);
  if (got.lessThan(0)) throw new DealRuleError("negative", "Сумма не может быть отрицательной", "amountPaid");
  if (got.greaterThanOrEqualTo(inv)) return "PAID";
  if (!remainder) throw new DealRuleError("remainder_required", "Сумма меньше выставленной: выберите, что делать с остатком", "remainder");
  if (remainder === "write_off" && !reason?.trim()) throw new DealRuleError("reason_required", "Укажите причину списания", "writeOffReason");
  return remainder === "write_off" ? "WRITTEN_OFF" : "PARTIAL";
}

/** Invoiced amount must match calculation unless a reason is given (becomes "overridden" in history). */
export function checkInvoiceAmount(calculated: Decimal.Value, invoiced: Decimal.Value, reason?: string | null): void {
  const diff = new Decimal(invoiced).sub(calculated).abs();
  if (diff.greaterThan("0.01") && !reason?.trim()) {
    throw new DealRuleError("override_reason", "Сумма отличается от расчёта — укажите причину", "overrideReason");
  }
}
