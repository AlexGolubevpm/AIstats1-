// Forecast page: the month so far and its projection at the current pace (docs/product/03-pages.md#forecast).
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { dealMonthAmount, planItemMonths, projectMonth, projectMonths, shiftMonth, type MonthOverrides, type PlanItemKind, type Horizon, type Lookback, type PlanDeal, type PlanMonthRow, type Projection } from "@/lib/forecast";
import { readForecastPlan, type ForecastPlan } from "@/server/services/forecast-plan";
import { daysInMonth, flatPerDay, type BillingPeriod, type PaymentBasis } from "@/server/domain/deals";
import { D, iso } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const LIVE = Prisma.sql`(SELECT id FROM "Site" WHERE status <> 'ARCHIVED')`;
const addDays = (s: string, k: number) => iso(new Date(D(s).getTime() + k * 86_400_000));
const monthOf = (s: string) => s.slice(0, 7);
const prevMonth = (m: string) => iso(new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 2, 1))).slice(0, 7);

export interface SiteForecast { id: string; domain: string; actual: number; rate: number; projected: number | null; prevMonth: number; delta: number | null; margin: number | null }
export interface MonthForecast {
  projection: Projection;
  sites: SiteForecast[];
  prev: { month: string; revenue: number; cost: number; opex: number; margin: number } | null;
  /** Revenue of running flat deals on the days still ahead: known in advance, already inside the pace. */
  knownDeals: number;
  /** Per-day pace of the rotation (AdSpyglass revenue, direct fix deals left out) and of the traffic cost over the last complete days. */
  pace: { rotation: number; cost: number; daysUsed: number };
  /**
   * This month per day as /forecast projects it — the facts so far plus the pace for the days ahead, over the days
   * with data and the days ahead (a day without data is a hole, not a zero): what the next month starts from (ADR 0020).
   */
  monthRate: { rotation: number; cost: number };
}

export async function monthForecast(today = iso(new Date()), lookback: Lookback = 7, month = monthOf(today)): Promise<MonthForecast> {
  const first = `${month}-01`, last = addDays(first, daysInMonth(first) - 1);
  const from = addDays(first, -21), to = last < today ? last : today; // extra days before the month only feed the pace (lookback ≤ 14 plus gaps)
  const pm = prevMonth(month), pmFirst = `${pm}-01`, pmLast = addDays(pmFirst, daysInMonth(pmFirst) - 1);
  const [days, opex, perSite, prevSites, prevOpex, deals, srcDays] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT date, SUM(revenue)::float8 revenue, SUM(cost)::float8 cost, SUM(revenue_mediated)::float8 asg FROM v_site_geo_daily
      WHERE date BETWEEN ${D(from)} AND ${D(to)} AND site_id IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT date, SUM(amount)::float8 v FROM v_opex_daily WHERE date BETWEEN ${D(first)} AND ${D(last)} AND (site_id IS NULL OR site_id IN ${LIVE}) GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT g.site_id, s.domain, g.date, SUM(g.revenue)::float8 revenue, SUM(g.cost)::float8 cost, SUM(g.revenue_mediated)::float8 asg FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id
      WHERE g.date BETWEEN ${D(from)} AND ${D(to)} AND s.status <> 'ARCHIVED' GROUP BY 1, 2, 3`,
    db.$queryRaw<Raw[]>`SELECT site_id, SUM(revenue)::float8 revenue, SUM(cost)::float8 cost FROM v_site_geo_daily
      WHERE date BETWEEN ${D(pmFirst)} AND ${D(pmLast)} AND site_id IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT SUM(amount)::float8 v FROM v_opex_daily WHERE date BETWEEN ${D(pmFirst)} AND ${D(pmLast)} AND (site_id IS NULL OR site_id IN ${LIVE})`,
    db.deal.findMany({ where: { status: "ACTIVE", billedVia: "DIRECT", paymentBasis: { in: ["FLAT_DAILY", "FLAT_PERIOD"] }, startsAt: { lte: D(last) },
      OR: [{ endsAt: null }, { endsAt: { gte: D(today) } }] }, include: { sites: true } }),
    db.$queryRaw<Raw[]>`SELECT date, "siteId" site_id FROM "FactTrafficSource" WHERE date BETWEEN ${D(from)} AND ${D(to)} GROUP BY 1, 2`,
  ]);
  // Cost comes only with the per-site traffic-source cut: a day without it is not complete for the pace (its cost would read 0).
  const srcAt = new Set(srcDays.map((r) => `${iso(r.date as Date)}|${String(r.site_id)}`));
  const srcDay = new Set(srcDays.map((r) => iso(r.date as Date)));
  const opexByDay = Object.fromEntries(opex.map((r) => [iso(r.date as Date), n(r.v)]));
  const input = days.map((r) => ({ date: iso(r.date as Date), revenue: n(r.revenue), cost: n(r.cost), complete: n(r.asg) > 0 && srcDay.has(iso(r.date as Date)) }));
  const projection = projectMonth({ month, today, lookback, days: input, opexByDay });
  // The months ahead take the rotation alone: direct deals are added there by their own dates (ADR 0020).
  const rot = projectMonth({ month, today, lookback, days: days.map((r, k) => ({ ...input[k], revenue: n(r.asg) })) }).rate;

  const bySite = new Map<string, { domain: string; days: { date: string; revenue: number; cost: number; complete: boolean }[] }>();
  for (const r of perSite) {
    const id = String(r.site_id);
    if (!bySite.has(id)) bySite.set(id, { domain: String(r.domain), days: [] });
    bySite.get(id)!.days.push({ date: iso(r.date as Date), revenue: n(r.revenue), cost: n(r.cost), complete: n(r.asg) > 0 && srcAt.has(`${iso(r.date as Date)}|${id}`) });
  }
  const prevBy = new Map(prevSites.map((r) => [String(r.site_id), { revenue: n(r.revenue), cost: n(r.cost) }]));
  const sites: SiteForecast[] = [...bySite.entries()].map(([id, s]) => {
    const p = projectMonth({ month, today, lookback, days: s.days });
    const prev = prevBy.get(id)?.revenue ?? 0;
    const projected = p.projected?.revenue ?? null;
    return { id, domain: s.domain, actual: p.actual.revenue, rate: p.rate.revenue, projected, prevMonth: prev,
      delta: projected != null && prev > 0 ? (projected - prev) / prev : null, margin: p.projected ? p.projected.revenue - p.projected.cost : null };
  }).filter((s) => s.actual > 0 || s.projected).sort((a, b) => (b.projected ?? b.actual) - (a.projected ?? a.actual));

  const prevRevenue = prevSites.reduce((a, r) => a + n(r.revenue), 0), prevCost = prevSites.reduce((a, r) => a + n(r.cost), 0), prevOpx = n(prevOpex[0]?.v);
  const prev = prevSites.length || prevOpx ? { month: pm, revenue: prevRevenue, cost: prevCost, opex: prevOpx, margin: prevRevenue - prevCost - prevOpx } : null;

  let knownDeals = 0;
  for (const d of projection.days) {
    if (d.kind === "actual") continue;
    for (const deal of deals) {
      const start = iso(deal.startsAt), end = deal.endsAt ? iso(deal.endsAt) : null;
      if (d.date < start || (end && d.date > end)) continue;
      const termDays = end ? Math.round((D(end).getTime() - D(start).getTime()) / 86_400_000) + 1 : null;
      knownDeals += flatPerDay(deal.paymentBasis as PaymentBasis, deal.price.toString(), deal.billingPeriod as BillingPeriod, termDays, d.date).toNumber();
    }
  }
  const actualAsg = days.filter((r) => { const d = iso(r.date as Date); return d >= first && d < today; }).reduce((a, r) => a + n(r.asg), 0);
  const span = projection.actual.days + projection.daysLeft;
  const monthRate = span && rot.daysUsed
    ? { rotation: (actualAsg + rot.revenue * projection.daysLeft) / span, cost: (projection.actual.cost + rot.cost * projection.daysLeft) / span }
    : { rotation: rot.revenue, cost: rot.cost };
  return { projection, sites, prev, knownDeals, pace: { rotation: rot.revenue, cost: rot.cost, daysUsed: rot.daysUsed }, monthRate };
}

export interface CurrentMonthRow {
  month: string; revenue: number; cost: number; opex: number; margin: number; romi: number | null; actualRevenue: number; upcomingDeals: number;
  itemsRevenue: number; itemsCost: number; itemsSaving: number; cumMargin: number;
  /** The month as /forecast projects it (the deals running now are inside its pace), without new deals and planned lines. */
  baseMargin: number;
}
export interface PlanItemRow {
  id: string; month: string; recurring: boolean; untilMonth: string | null; kind: PlanItemKind; title: string; amount: number;
  siteId: string | null; domain: string | null; hypothesisId: string | null; hypothesis: string | null; note: string | null;
  /** Months of this view the line applies to. */
  months: string[];
}
export interface MonthsForecast {
  plan: ForecastPlan; horizon: Horizon; lookback: Lookback;
  pace: MonthForecast["pace"];
  monthRate: MonthForecast["monthRate"];
  current: CurrentMonthRow | null;
  months: PlanMonthRow[];
  items: PlanItemRow[];
}

/**
 * The plan for the months ahead (ADR 0020): this month as /forecast projects it (plus deals that start
 * later this month and this month's planned lines), then `horizon` months at the rotation and cost pace
 * grown by the scenario, fix deals by their dates, operating expenses as entered (else carried), planned lines.
 */
export async function monthsForecast(today = iso(new Date()), lookback: Lookback = 7, horizon?: Horizon): Promise<MonthsForecast> {
  const plan = await readForecastPlan(db);
  const h = horizon ?? plan.horizon;
  const cur = monthOf(today);
  const months = Array.from({ length: h }, (_, k) => shiftMonth(cur, k + 1));
  const endMonth = months[months.length - 1];
  const lastDay = addDays(`${shiftMonth(endMonth, 1)}-01`, -1);
  const winFrom = addDays(today, -lookback), winTo = addDays(today, -1);
  const [f, dealRows, opexRows, itemRows, overrideRows] = await Promise.all([
    monthForecast(today, lookback, cur),
    db.deal.findMany({ where: { billedVia: "DIRECT", status: { in: ["ACTIVE", "DRAFT"] }, startsAt: { lte: D(lastDay) }, OR: [{ endsAt: null }, { endsAt: { gte: D(today) } }] },
      include: { sites: { include: { site: { select: { domain: true } } } } } }),
    db.$queryRaw<Raw[]>`SELECT to_char(month, 'YYYY-MM') m, SUM(amount)::float8 v FROM "OpexEntry"
      WHERE month <= ${D(`${endMonth}-01`)} AND ("siteId" IS NULL OR "siteId" IN ${LIVE}) GROUP BY 1`,
    // Lines starting in the view, and repeating ones that started earlier and still run.
    db.planItem.findMany({ where: { month: { lte: D(`${endMonth}-01`) }, OR: [{ month: { gte: D(`${cur}-01`) } }, { recurring: true, OR: [{ untilMonth: null }, { untilMonth: { gte: D(`${cur}-01`) } }] }] },
      include: { site: { select: { domain: true } }, hypothesis: { select: { title: true } } }, orderBy: [{ month: "asc" }, { createdAt: "asc" }] }),
    db.planMonthOverride.findMany({ where: { month: { gte: D(`${months[0]}-01`), lte: D(`${endMonth}-01`) } } }),
  ]);
  const overrides: MonthOverrides = {};
  for (const o of overrideRows) (overrides[iso(o.month).slice(0, 7)] ??= {})[o.line] = Number(o.amount);
  // Per-load and CPM deals have no fixed sum: their recent accruals per day, else price × their sites' loads (or impressions) per day.
  const ids = dealRows.map((d) => d.id);
  const [accrued, siteLoads] = ids.length ? await Promise.all([
    db.$queryRaw<Raw[]>`SELECT "dealId" id, SUM(revenue)::float8 revenue, COUNT(DISTINCT date)::int days FROM "FactFixDeal"
      WHERE "dealId" IN (${Prisma.join(ids)}) AND date BETWEEN ${D(winFrom)} AND ${D(winTo)} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT site_id, SUM(page_loads)::float8 loads, SUM(imps_own)::float8 imps, COUNT(DISTINCT date)::int days FROM v_site_geo_daily
      WHERE date BETWEEN ${D(winFrom)} AND ${D(winTo)} AND site_id IN ${LIVE} GROUP BY 1`,
  ]) : [[], []];
  const acc = new Map(accrued.map((r) => [String(r.id), n(r.revenue) / Math.max(1, n(r.days))]));
  const load = new Map(siteLoads.map((r) => [String(r.site_id), { loads: n(r.loads) / Math.max(1, n(r.days)), imps: n(r.imps) / Math.max(1, n(r.days)) }]));
  const deals: PlanDeal[] = dealRows.map((d) => {
    const flat = d.paymentBasis === "FLAT_DAILY" || d.paymentBasis === "FLAT_PERIOD";
    const base = { id: d.id, title: d.title, sites: d.sites.map((s) => s.site.domain).join(", "), status: d.status as "ACTIVE" | "DRAFT", basis: d.paymentBasis as PaymentBasis,
      price: d.price.toString(), billingPeriod: d.billingPeriod as BillingPeriod, startsAt: iso(d.startsAt), endsAt: d.endsAt ? iso(d.endsAt) : null };
    if (flat) return base;
    if (acc.has(d.id)) return { ...base, perDay: acc.get(d.id)! };
    const volume = d.sites.reduce((a, s) => a + (d.paymentBasis === "PER_1000_LOADS" ? load.get(s.siteId)?.loads ?? 0 : load.get(s.siteId)?.imps ?? 0), 0);
    return { ...base, perDay: (Number(d.price) * volume) / 1000, estimate: true };
  });
  const opexByMonth = Object.fromEntries(opexRows.map((r) => [String(r.m), n(r.v)]));
  const viewMonths = [cur, ...months];
  const items: PlanItemRow[] = itemRows.map((x) => {
    const row = { month: iso(x.month).slice(0, 7), recurring: x.recurring, until: x.untilMonth ? iso(x.untilMonth).slice(0, 7) : null };
    return { id: x.id, month: row.month, recurring: x.recurring, untilMonth: row.until, kind: x.kind as PlanItemKind, title: x.title, amount: Number(x.amount), siteId: x.siteId,
      domain: x.site?.domain ?? null, hypothesisId: x.hypothesisId, hypothesis: x.hypothesis?.title ?? null, note: x.note, months: planItemMonths(row, viewMonths) };
  });
  const perMonth = items.flatMap((x) => x.months.map((month) => ({ month, kind: x.kind, amount: x.amount })));
  const sumOf = (month: string, kind: PlanItemKind) => perMonth.filter((x) => x.month === month && x.kind === kind).reduce((a, x) => a + x.amount, 0);

  // This month: the /forecast projection already holds the running deals (in its pace); add the ones that start after today and this month's lines.
  const p = f.projection.projected;
  let current: CurrentMonthRow | null = null;
  if (p) {
    const upcoming = deals.filter((d) => d.startsAt > today && (d.status === "ACTIVE" || plan.includeDrafts)).reduce((a, d) => a + dealMonthAmount(d, cur), 0);
    const itemsRevenue = sumOf(cur, "REVENUE"), itemsCost = sumOf(cur, "COST"), itemsSaving = sumOf(cur, "SAVING");
    const revenue = p.revenue + upcoming + itemsRevenue, cost = Math.max(0, p.cost + itemsCost - itemsSaving), margin = revenue - cost - p.opex;
    current = { month: cur, revenue, cost, opex: p.opex, margin, romi: cost ? ((revenue - cost) / cost) * 100 : null, actualRevenue: f.projection.actual.revenue,
      upcomingDeals: upcoming, itemsRevenue, itemsCost, itemsSaving, cumMargin: margin, baseMargin: p.margin };
  }
  const rows = f.pace.daysUsed
    ? projectMonths({ months, current: cur, base: f.monthRate, scenario: plan, deals, opexByMonth, items: perMonth, overrides, cumStart: current?.margin ?? 0, cumBaseStart: current?.baseMargin ?? 0 })
    : [];
  return { plan, horizon: h, lookback, pace: f.pace, monthRate: f.monthRate, current, months: rows, items };
}
