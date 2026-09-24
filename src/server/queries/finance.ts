// Finance page queries (docs/product/04-finance-and-deals.md#finance). Totals by sites, never bundles.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import * as m from "@/lib/metrics";
import { D, iso } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const LIVE = Prisma.sql`(SELECT id FROM "Site" WHERE status <> 'ARCHIVED')`;

/** Revenue split by status for the period: confirmed, invoiced (direct deals), forecast. */
export async function financeKpis(p: Period, today = iso(new Date())) {
  const [[g], [f], [od]] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT SUM(revenue)::float8 revenue, SUM(revenue_confirmed)::float8 confirmed, SUM(cost)::float8 cost
      FROM v_site_geo_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE}`,
    db.$queryRaw<Raw[]>`SELECT SUM(revenue) FILTER (WHERE revenue_state = 'INVOICED')::float8 invoiced FROM v_deal_daily
      WHERE billed_via = 'DIRECT' AND date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE}`,
    db.$queryRaw<Raw[]>`SELECT SUM(COALESCE("amountInvoiced", 0) - COALESCE("amountPaid", 0))::float8 overdue, count(*)::int periods
      FROM "DealPeriod" WHERE "supersededById" IS NULL AND status IN ('INVOICED', 'PARTIAL') AND "dueAt" < ${D(today)}`,
  ]);
  const revenue = n(g?.revenue), confirmed = n(g?.confirmed), invoiced = n(f?.invoiced), cost = n(g?.cost);
  return {
    revenue, confirmed, invoiced, forecast: Math.max(0, revenue - confirmed - invoiced), expected: Math.max(0, revenue - confirmed),
    cost, margin: revenue - cost, romi: m.romi(revenue, cost), overdue: n(od?.overdue), overduePeriods: n(od?.periods),
  };
}

/** Daily (or monthly for > 62 days) structure: AdSpyglass, deals confirmed, deals expected, cost. */
export async function revenueStructure(p: Period, monthly: boolean) {
  const bucket = monthly ? Prisma.sql`date_trunc('month', date)::date` : Prisma.sql`date`;
  const [geo, deals] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT ${bucket} b, SUM(revenue_mediated)::float8 asg, SUM(cost)::float8 cost FROM v_site_geo_daily
      WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT ${bucket} b, SUM(revenue) FILTER (WHERE revenue_state = 'CONFIRMED')::float8 confirmed,
      SUM(revenue) FILTER (WHERE revenue_state <> 'CONFIRMED')::float8 expected FROM v_deal_daily
      WHERE billed_via = 'DIRECT' AND date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE} GROUP BY 1`,
  ]);
  const map = new Map<string, { date: string; asg: number; dealsConfirmed: number; dealsExpected: number; cost: number }>();
  const at = (b: unknown) => {
    const k = iso(b as Date);
    if (!map.has(k)) map.set(k, { date: monthly ? k.slice(0, 7) : k, asg: 0, dealsConfirmed: 0, dealsExpected: 0, cost: 0 });
    return map.get(k)!;
  };
  for (const r of geo) Object.assign(at(r.b), { asg: n(r.asg), cost: n(r.cost) });
  for (const r of deals) Object.assign(at(r.b), { dealsConfirmed: n(r.confirmed), dealsExpected: n(r.expected) });
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, v]) => v);
}

export interface PnlRow {
  siteId: string; domain: string; bundles: string[]; asg: number; asgConfirmed: number; deals: number; dealsConfirmed: number; dealsInvoiced: number;
  revenue: number; cost: number; margin: number; romi: number | null; marginShare: number | null;
  costGapDays: number; noTraffic: boolean; dealNoNumbers: boolean; months: { month: string; asg: number; deals: number; cost: number; margin: number; romi: number | null }[];
}

/** P&L per tube with completeness flags and a per-month breakdown. */
export async function pnlTable(p: Period): Promise<PnlRow[]> {
  const [rows, months, deals, gaps, sites, alerts] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT site_id, SUM(revenue_mediated)::float8 asg, SUM(revenue)::float8 revenue, SUM(revenue_confirmed)::float8 confirmed,
      SUM(cost)::float8 cost, SUM(uniques)::float8 uniques FROM v_site_geo_daily
      WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT site_id, to_char(date, 'YYYY-MM') mo, SUM(revenue_mediated)::float8 asg, SUM(revenue_direct)::float8 deals, SUM(cost)::float8 cost
      FROM v_site_geo_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE} GROUP BY 1, 2`,
    db.$queryRaw<Raw[]>`SELECT site_id, SUM(revenue)::float8 total, SUM(revenue) FILTER (WHERE revenue_state = 'CONFIRMED')::float8 confirmed,
      SUM(revenue) FILTER (WHERE revenue_state = 'INVOICED')::float8 invoiced FROM v_deal_daily
      WHERE billed_via = 'DIRECT' AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1`,
    // Days with traffic but no cost at all: ROMI for those sites is incomplete.
    db.$queryRaw<Raw[]>`SELECT site_id, count(*)::int days FROM (
      SELECT site_id, date FROM v_site_geo_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)}
      GROUP BY 1, 2 HAVING SUM(uniques) > 0 AND SUM(cost) = 0) x GROUP BY 1`,
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, include: { bundles: { include: { bundle: true } } } }),
    db.alert.findMany({ where: { resolvedAt: null, rule: "deal_no_numbers" }, select: { siteId: true } }),
  ]);
  const by = <T extends Raw>(list: T[]) => new Map(list.map((r) => [String(r.site_id), r]));
  const rowBy = by(rows), dealBy = by(deals), gapBy = by(gaps);
  const noNumbers = new Set(alerts.map((a) => a.siteId));
  const totalMargin = rows.reduce((a, r) => a + n(r.revenue) - n(r.cost), 0);
  return sites.filter((s) => rowBy.has(s.id)).map((s) => {
    const r = rowBy.get(s.id)!, dl = dealBy.get(s.id);
    const revenue = n(r.revenue), cost = n(r.cost), margin = revenue - cost;
    const dealsConfirmed = n(dl?.confirmed);
    return {
      siteId: s.id, domain: s.domain, bundles: s.bundles.map((b) => b.bundle.title),
      asg: n(r.asg), asgConfirmed: Math.max(0, n(r.confirmed) - dealsConfirmed), deals: n(dl?.total), dealsConfirmed, dealsInvoiced: n(dl?.invoiced),
      revenue, cost, margin, romi: m.romi(revenue, cost), marginShare: totalMargin > 0 && margin > 0 ? margin / totalMargin : null,
      costGapDays: n(gapBy.get(s.id)?.days), noTraffic: n(r.uniques) === 0, dealNoNumbers: noNumbers.has(s.id),
      months: months.filter((x) => x.site_id === s.id).sort((a, b) => String(a.mo).localeCompare(String(b.mo))).map((x) => {
        const rev = n(x.asg) + n(x.deals);
        return { month: String(x.mo), asg: n(x.asg), deals: n(x.deals), cost: n(x.cost), margin: rev - n(x.cost), romi: m.romi(rev, n(x.cost)) };
      }),
    };
  });
}

/** Last N months of AdSpyglass reported revenue vs payouts received. */
export async function asgPayouts(months = 6, today = iso(new Date())) {
  const since = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - months, 1));
  const [rows, payouts] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT date_trunc('month', date)::date mo, SUM("revenueReported")::float8 reported FROM "FactRevenueGeo"
      WHERE date >= ${since} GROUP BY 1 ORDER BY 1 DESC`,
    db.asgPayout.findMany({ where: { month: { gte: since } } }),
  ]);
  const pay = new Map(payouts.map((x) => [iso(x.month), x]));
  const current = `${today.slice(0, 7)}-01`;
  return rows.map((r) => {
    const month = iso(r.mo as Date), p = pay.get(month), reported = n(r.reported);
    const received = p ? Number(p.amountReceived) : null;
    return {
      month, reported, received, receivedAt: p?.receivedAt ?? null, diff: received != null && reported ? (received - reported) / reported : null,
      status: p ? "CONFIRMED" : month === current ? "OPEN" : "AWAITING",
    };
  });
}

/** Open receivables across direct deals, overdue first. */
export async function receivables(today = iso(new Date())) {
  const list = await db.dealPeriod.findMany({
    where: { supersededById: null, status: { in: ["INVOICED", "PARTIAL", "DISPUTED"] } },
    include: { deal: { include: { advertiser: true } } }, orderBy: { dueAt: "asc" },
  });
  return list.map((p) => {
    const outstanding = Number(p.amountInvoiced ?? 0) - Number(p.amountPaid ?? 0);
    const overdueDays = p.dueAt && iso(p.dueAt) < today ? Math.round((D(today).getTime() - p.dueAt.getTime()) / 86_400_000) : 0;
    return { id: p.id, dealId: p.dealId, advertiser: p.deal.advertiser.name, deal: p.deal.title, from: iso(p.from), to: iso(p.to),
      invoiced: Number(p.amountInvoiced ?? 0), paid: Number(p.amountPaid ?? 0), outstanding, dueAt: p.dueAt ? iso(p.dueAt) : null, overdueDays, status: p.status };
  }).sort((a, b) => b.overdueDays - a.overdueDays || b.outstanding - a.outstanding);
}
