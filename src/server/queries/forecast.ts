// Forecast page: the month so far and its projection at the current pace (docs/product/03-pages.md#forecast).
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { projectMonth, type Lookback, type Projection } from "@/lib/forecast";
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
}

export async function monthForecast(today = iso(new Date()), lookback: Lookback = 7, month = monthOf(today)): Promise<MonthForecast> {
  const first = `${month}-01`, last = addDays(first, daysInMonth(first) - 1);
  const from = addDays(first, -21), to = last < today ? last : today; // extra days before the month only feed the pace (lookback ≤ 14 plus gaps)
  const pm = prevMonth(month), pmFirst = `${pm}-01`, pmLast = addDays(pmFirst, daysInMonth(pmFirst) - 1);
  const [days, opex, perSite, prevSites, prevOpex, deals, srcDays] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT date, SUM(revenue)::float8 revenue, SUM(cost)::float8 cost, SUM(revenue_mediated)::float8 asg FROM v_site_geo_daily
      WHERE date BETWEEN ${D(from)} AND ${D(to)} AND site_id IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT date, SUM(amount)::float8 v FROM v_opex_daily WHERE date BETWEEN ${D(first)} AND ${D(last)} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT g.site_id, s.domain, g.date, SUM(g.revenue)::float8 revenue, SUM(g.cost)::float8 cost, SUM(g.revenue_mediated)::float8 asg FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id
      WHERE g.date BETWEEN ${D(from)} AND ${D(to)} AND s.status <> 'ARCHIVED' GROUP BY 1, 2, 3`,
    db.$queryRaw<Raw[]>`SELECT site_id, SUM(revenue)::float8 revenue, SUM(cost)::float8 cost FROM v_site_geo_daily
      WHERE date BETWEEN ${D(pmFirst)} AND ${D(pmLast)} AND site_id IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT SUM(amount)::float8 v FROM v_opex_daily WHERE date BETWEEN ${D(pmFirst)} AND ${D(pmLast)}`,
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
  return { projection, sites, prev, knownDeals };
}
