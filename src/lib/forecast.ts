// Month projection from the days seen so far (docs/product/06-metrics.md#forecast, ADR 0008).
// Pure: the page feeds it daily totals, it returns every day of the month — actual or projected —
// and the month's expected result "at the current pace of the last N complete days".
import { daysInMonth, flatPerDay, type BillingPeriod, type PaymentBasis } from "@/server/domain/deals";

/** `complete` — the day has AdSpyglass data; a day with only deal accruals or Metrika rows is not a complete day for the pace. */
export interface DayInput { date: string; revenue: number | null; cost: number | null; opex?: number; complete?: boolean }
export type DayKind = "actual" | "today" | "forecast";
export interface DayOut { date: string; kind: DayKind; revenue: number | null; cost: number | null; opex: number; margin: number | null; cumRevenue: number; cumMargin: number }
export interface Projection {
  month: string;
  days: DayOut[];
  /** Per-day pace from the last `lookback` complete days (yesterday and back), and how many days were actually available. */
  rate: { revenue: number; cost: number; daysUsed: number };
  actual: { revenue: number; cost: number; opex: number; margin: number; days: number };
  projected: { revenue: number; cost: number; opex: number; margin: number; romi: number | null } | null;
  daysLeft: number;
}

const DAY = 86_400_000;
const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * `days` may include days before the month (they only feed the pace). A day counts as complete
 * when it is before `today` and has revenue; today itself is partial and is projected like the
 * days after it. A month that is over has no forecast part.
 */
export function projectMonth(i: { month: string; today: string; days: DayInput[]; lookback: number; opexByDay?: Record<string, number> }): Projection {
  const first = `${i.month}-01`, count = daysInMonth(first), last = addDays(first, count - 1);
  const byDate = new Map(i.days.map((d) => [d.date, d]));
  const complete = i.days.filter((d) => d.date < i.today && d.revenue != null && !Number.isNaN(d.revenue) && d.complete !== false).sort((a, b) => a.date.localeCompare(b.date));
  const used = complete.slice(-Math.max(1, i.lookback));
  const rate = used.length
    ? { revenue: used.reduce((a, d) => a + (d.revenue ?? 0), 0) / used.length, cost: used.reduce((a, d) => a + (d.cost ?? 0), 0) / used.length, daysUsed: used.length }
    : { revenue: 0, cost: 0, daysUsed: 0 };
  const days: DayOut[] = [];
  let cumRevenue = 0, cumMargin = 0;
  const actual = { revenue: 0, cost: 0, opex: 0, margin: 0, days: 0 };
  let daysLeft = 0;
  for (let k = 0; k < count; k++) {
    const date = addDays(first, k), src = byDate.get(date), opex = i.opexByDay?.[date] ?? src?.opex ?? 0;
    const isPast = date < i.today, has = src?.revenue != null && !Number.isNaN(src.revenue);
    let kind: DayKind, revenue: number | null, cost: number | null;
    if (isPast) { kind = "actual"; revenue = has ? src!.revenue : null; cost = has ? src!.cost ?? 0 : null; }
    else { kind = date === i.today ? "today" : "forecast"; daysLeft++; revenue = rate.daysUsed ? rate.revenue : null; cost = rate.daysUsed ? rate.cost : null; }
    const margin = revenue == null ? null : revenue - (cost ?? 0) - opex;
    cumRevenue += revenue ?? 0; cumMargin += margin ?? 0;
    if (kind === "actual" && has) { actual.revenue += revenue!; actual.cost += cost!; actual.margin += margin!; actual.days++; }
    if (kind === "actual") actual.opex += opex;
    days.push({ date, kind, revenue, cost, opex, margin, cumRevenue, cumMargin });
  }
  const opexTotal = days.reduce((a, d) => a + d.opex, 0);
  const projected = daysLeft === 0
    ? { revenue: actual.revenue, cost: actual.cost, opex: opexTotal, margin: actual.revenue - actual.cost - opexTotal, romi: actual.cost ? ((actual.revenue - actual.cost) / actual.cost) * 100 : null }
    : rate.daysUsed
      ? (() => { const revenue = actual.revenue + rate.revenue * daysLeft, cost = actual.cost + rate.cost * daysLeft;
          return { revenue, cost, opex: opexTotal, margin: revenue - cost - opexTotal, romi: cost ? ((revenue - cost) / cost) * 100 : null }; })()
      : null;
  return { month: i.month, days, rate, actual: { ...actual }, projected, daysLeft: last >= i.today ? daysLeft : 0 };
}

export const LOOKBACKS = [3, 7, 14] as const;
export type Lookback = (typeof LOOKBACKS)[number];
export const parseLookback = (v: string | undefined, fallback: Lookback = 7): Lookback => (LOOKBACKS.includes(Number(v) as Lookback) ? (Number(v) as Lookback) : fallback);

// ---------- Months ahead (ADR 0020) ----------

export const HORIZONS = [3, 6, 12] as const;
export type Horizon = (typeof HORIZONS)[number];
export const parseHorizon = (v: string | number | undefined, fallback: Horizon = 6): Horizon => (HORIZONS.includes(Number(v) as Horizon) ? (Number(v) as Horizon) : fallback);

export const shiftMonth = (m: string, k: number) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1)).toISOString().slice(0, 7);

/** A fix deal as the plan sees it: its dates, its model and, for the per-load / CPM ones, a revenue per day. */
export interface PlanDeal {
  id: string; title: string; sites: string; status: "ACTIVE" | "DRAFT"; basis: PaymentBasis; price: string; billingPeriod: BillingPeriod;
  startsAt: string; endsAt: string | null;
  /** Per-load / CPM: the deal's revenue per day (its recent accruals, else price × its sites' loads). */
  perDay?: number;
  /** The per-day figure is an estimate from the sites' loads (the deal has not accrued yet). */
  estimate?: boolean;
}

/** What a deal brings in a month: flat ones day by day as billed (flatPerDay), the others at their per-day revenue. */
export function dealMonthAmount(deal: PlanDeal, month: string): number {
  const first = `${month}-01`, last = addDays(first, daysInMonth(first) - 1);
  const from = deal.startsAt > first ? deal.startsAt : first, to = deal.endsAt && deal.endsAt < last ? deal.endsAt : last;
  if (from > to) return 0;
  const flat = deal.basis === "FLAT_DAILY" || deal.basis === "FLAT_PERIOD";
  const termDays = deal.endsAt ? Math.round((Date.parse(`${deal.endsAt}T00:00:00Z`) - Date.parse(`${deal.startsAt}T00:00:00Z`)) / DAY) + 1 : null;
  let sum = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) sum += flat ? flatPerDay(deal.basis, deal.price, deal.billingPeriod, termDays, d).toNumber() : deal.perDay ?? 0;
  return sum;
}

export interface PlanScenario { revenueGrowth: number; costGrowth: number; includeDrafts: boolean }
export type PlanItemKind = "REVENUE" | "COST" | "SAVING";

/** The months a planned line applies to among `months`: its start month, or every month from it (up to `until`) when it repeats. */
export function planItemMonths(item: { month: string; recurring: boolean; until: string | null }, months: string[]): string[] {
  if (!item.recurring) return months.filter((m) => m === item.month);
  return months.filter((m) => m >= item.month && (!item.until || m <= item.until));
}
export interface PlanDealLine {
  id: string; title: string; sites: string; amount: number; draft: boolean; estimate: boolean; edited: boolean; defaultAmount: number;
  /** Where the default comes from: the contract, or the rate an earlier month's edit set. */
  source: "contract" | "carried";
}
export interface PlanMonthRow {
  month: string; days: number;
  rotation: number; deals: number; draftDeals: number; itemsRevenue: number; itemsCost: number; itemsSaving: number;
  revenue: number; trafficCost: number; cost: number; opex: number; opexCarried: boolean;
  margin: number; romi: number | null; cumMargin: number;
  /** The base: AdSpyglass alone — no direct deals, no planned lines; what the month brings if nothing new is done. */
  baseMargin: number; cumBaseMargin: number;
  /** What the month would hold without its own edits (carried from the month before), and which lines are edited. */
  defaults: { rotation: number; trafficCost: number };
  edited: { rotation: boolean; trafficCost: boolean };
  dealLines: PlanDealLine[];
}

/** Edits of a month, by line: `rotation`, `traffic_cost`, `deal:<id>` → the month's amount. */
export type MonthOverrides = Record<string, Record<string, number>>;
export const dealLine = (id: string) => `deal:${id}`;

/** Days of `month` the deal runs (inside its start and end). */
export function dealActiveDays(deal: Pick<PlanDeal, "startsAt" | "endsAt">, month: string): number {
  const first = `${month}-01`, last = addDays(first, daysInMonth(first) - 1);
  const from = deal.startsAt > first ? deal.startsAt : first, to = deal.endsAt && deal.endsAt < last ? deal.endsAt : last;
  return from > to ? 0 : Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;
}

/**
 * The months after the current one as a chain (ADR 0020, 2026-10-30): each line of a month is, by default, the
 * month before it per day × this month's days (× the scenario growth); an edit sets the month's amount and from
 * then on the next months carry its rate. The first month carries `base` — this month's AdSpyglass rotation and
 * traffic cost per day. Fix deals follow their contract (flat exact, per-load at their per-day revenue) until a
 * month edits them; an edited deal carries its edited rate over the days it runs. Drafts only when the scenario
 * says so; operating expenses as entered, else the last month that has any; planned lines as entered.
 */
export function projectMonths(i: {
  months: string[]; current: string; base: { rotation: number; cost: number }; scenario: PlanScenario;
  deals: PlanDeal[]; opexByMonth: Record<string, number>; items: { month: string; kind: PlanItemKind; amount: number }[];
  overrides?: MonthOverrides; cumStart?: number; cumBaseStart?: number;
}): PlanMonthRow[] {
  let cum = i.cumStart ?? 0, cumBase = i.cumBaseStart ?? 0;
  let rotRate = i.base.rotation, costRate = i.base.cost;
  const dealRate = new Map<string, number>();
  const known = Object.keys(i.opexByMonth).filter((m) => i.opexByMonth[m] > 0).sort();
  return i.months.map((month) => {
    const days = daysInMonth(`${month}-01`);
    const ov = i.overrides?.[month] ?? {};
    const defaults = { rotation: rotRate * (1 + i.scenario.revenueGrowth) * days, trafficCost: costRate * (1 + i.scenario.costGrowth) * days };
    const rotation = ov.rotation ?? defaults.rotation, trafficCost = ov.traffic_cost ?? defaults.trafficCost;
    rotRate = rotation / days; costRate = trafficCost / days;
    const dealLines: PlanDealLine[] = i.deals.map((d) => {
      const active = dealActiveDays(d, month);
      const carried = dealRate.get(d.id);
      const defaultAmount = active === 0 ? 0 : carried != null ? carried * active : dealMonthAmount(d, month);
      const edit = active > 0 ? ov[dealLine(d.id)] : undefined;
      const amount = edit ?? defaultAmount;
      if (edit != null) dealRate.set(d.id, edit / active);
      return { id: d.id, title: d.title, sites: d.sites, amount, draft: d.status === "DRAFT", estimate: Boolean(d.estimate) && d.basis !== "FLAT_DAILY" && d.basis !== "FLAT_PERIOD" && edit == null && carried == null,
        edited: edit != null, defaultAmount, source: carried != null ? "carried" as const : "contract" as const, active };
    // Every deal that runs in the month stays listed — one set to 0 («не будет») too, so it can be brought back.
    }).filter((d) => d.active > 0).map(({ active: _a, ...d }) => d).sort((a, b) => b.amount - a.amount);
    const deals = dealLines.filter((d) => !d.draft).reduce((a, d) => a + d.amount, 0);
    const draftDeals = dealLines.filter((d) => d.draft).reduce((a, d) => a + d.amount, 0);
    const itemsRevenue = i.items.filter((x) => x.month === month && x.kind === "REVENUE").reduce((a, x) => a + x.amount, 0);
    const itemsCost = i.items.filter((x) => x.month === month && x.kind === "COST").reduce((a, x) => a + x.amount, 0);
    const itemsSaving = i.items.filter((x) => x.month === month && x.kind === "SAVING").reduce((a, x) => a + x.amount, 0);
    const entered = i.opexByMonth[month] ?? 0;
    const carriedFrom = entered > 0 ? null : known.filter((m) => m < month).pop() ?? null;
    const opex = entered > 0 ? entered : carriedFrom ? i.opexByMonth[carriedFrom] : 0;
    const revenue = rotation + deals + (i.scenario.includeDrafts ? draftDeals : 0) + itemsRevenue;
    const cost = Math.max(0, trafficCost + itemsCost - itemsSaving);
    const margin = revenue - cost - opex;
    const baseMargin = rotation - trafficCost - opex;
    cum += margin; cumBase += baseMargin;
    return { month, days, rotation, deals, draftDeals, itemsRevenue, itemsCost, itemsSaving, revenue, trafficCost, cost, opex, opexCarried: carriedFrom != null, margin,
      romi: cost ? ((revenue - cost) / cost) * 100 : null, cumMargin: cum, baseMargin, cumBaseMargin: cumBase,
      defaults, edited: { rotation: ov.rotation != null, trafficCost: ov.traffic_cost != null }, dealLines };
  });
}

