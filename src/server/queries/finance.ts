// Finance page queries (docs/product/04-finance-and-deals.md#finance). Totals by sites, never bundles.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import * as m from "@/lib/metrics";
import { D, iso } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const LIVE = Prisma.sql`(SELECT id FROM "Site" WHERE status <> 'ARCHIVED')`;

/** Operating expenses (all entries, network-wide and per site) that fall into the period. */
export async function opexInPeriod(p: Period): Promise<number> {
  const [r] = await db.$queryRaw<Raw[]>`SELECT SUM(amount)::float8 opex FROM v_opex_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)}`;
  return n(r?.opex);
}

/** Revenue split by status for the period: confirmed, invoiced (direct deals), forecast. Margin is after operating expenses. */
export async function financeKpis(p: Period, today = iso(new Date())) {
  const [[g], [f], [od], opex] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT SUM(revenue)::float8 revenue, SUM(revenue_confirmed)::float8 confirmed, SUM(cost)::float8 cost
      FROM v_site_geo_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE}`,
    db.$queryRaw<Raw[]>`SELECT SUM(revenue) FILTER (WHERE revenue_state = 'INVOICED')::float8 invoiced FROM v_deal_daily
      WHERE billed_via = 'DIRECT' AND date BETWEEN ${D(p.from)} AND ${D(p.to)} AND site_id IN ${LIVE}`,
    db.$queryRaw<Raw[]>`SELECT SUM(COALESCE("amountInvoiced", 0) - COALESCE("amountPaid", 0))::float8 overdue, count(*)::int periods
      FROM "DealPeriod" WHERE "supersededById" IS NULL AND status IN ('INVOICED', 'PARTIAL') AND "dueAt" < ${D(today)}`,
    opexInPeriod(p),
  ]);
  const revenue = n(g?.revenue), confirmed = n(g?.confirmed), invoiced = n(f?.invoiced), cost = n(g?.cost);
  return {
    revenue, confirmed, invoiced, forecast: Math.max(0, revenue - confirmed - invoiced), expected: Math.max(0, revenue - confirmed),
    cost, opex, margin: revenue - cost - opex, romi: m.romi(revenue, cost), overdue: n(od?.overdue), overduePeriods: n(od?.periods),
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
  revenue: number; cost: number;
  /** Operating expenses: the site's own entries + its share of network-wide ones, pro rata to revenue. */
  opex: number; margin: number; romi: number | null; marginShare: number | null;
  costGapDays: number; noTraffic: boolean; dealNoNumbers: boolean; months: { month: string; asg: number; deals: number; cost: number; margin: number; romi: number | null }[];
}

/**
 * P&L per tube with completeness flags and a per-month breakdown. Margin is after operating
 * expenses: a site's own entries plus its revenue share of network-wide ones (ADR 0007), so the
 * column adds up to the network figure.
 */
export async function pnlTable(p: Period): Promise<PnlRow[]> {
  const [rows, months, deals, gaps, sites, alerts, opex] = await Promise.all([
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
    db.$queryRaw<Raw[]>`SELECT site_id, SUM(amount)::float8 opex FROM v_opex_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1`,
  ]);
  const by = <T extends Raw>(list: T[]) => new Map(list.map((r) => [String(r.site_id), r]));
  const rowBy = by(rows), dealBy = by(deals), gapBy = by(gaps);
  const noNumbers = new Set(alerts.map((a) => a.siteId));
  const live = sites.filter((s) => rowBy.has(s.id));
  const networkOpex = n(opex.find((o) => o.site_id == null)?.opex);
  const siteOpex = new Map(opex.filter((o) => o.site_id != null).map((o) => [String(o.site_id), n(o.opex)]));
  const totalRevenue = live.reduce((a, s) => a + n(rowBy.get(s.id)!.revenue), 0);
  const opexOf = (id: string, revenue: number) =>
    (siteOpex.get(id) ?? 0) + (totalRevenue > 0 ? (networkOpex * revenue) / totalRevenue : live.length ? networkOpex / live.length : 0);
  const totalMargin = live.reduce((a, s) => { const r = rowBy.get(s.id)!; return a + n(r.revenue) - n(r.cost) - opexOf(s.id, n(r.revenue)); }, 0);
  return live.map((s) => {
    const r = rowBy.get(s.id)!, dl = dealBy.get(s.id);
    const revenue = n(r.revenue), cost = n(r.cost), opx = opexOf(s.id, revenue), margin = revenue - cost - opx;
    const dealsConfirmed = n(dl?.confirmed);
    return {
      siteId: s.id, domain: s.domain, bundles: s.bundles.map((b) => b.bundle.title),
      asg: n(r.asg), asgConfirmed: Math.max(0, n(r.confirmed) - dealsConfirmed), deals: n(dl?.total), dealsConfirmed, dealsInvoiced: n(dl?.invoiced),
      revenue, cost, opex: opx, margin, romi: m.romi(revenue, cost), marginShare: totalMargin > 0 && margin > 0 ? margin / totalMargin : null,
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

export interface MonthRow { month: string; asg: number; deals: number; revenue: number; cost: number; opex: number; margin: number; romi: number | null; isCurrent: boolean }

/** Network P&L by calendar month, the last `count` months ending with the current one. Totals by sites. */
export async function monthlyPnl(count = 6, today = iso(new Date())): Promise<MonthRow[]> {
  const since = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - count, 1));
  const [geo, opex] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT to_char(date, 'YYYY-MM') mo, SUM(revenue_mediated)::float8 asg, SUM(revenue_direct)::float8 deals, SUM(cost)::float8 cost
      FROM v_site_geo_daily WHERE date >= ${since} AND date <= ${D(today)} AND site_id IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT to_char(date, 'YYYY-MM') mo, SUM(amount)::float8 opex FROM v_opex_daily WHERE date >= ${since} AND date <= ${D(today)} GROUP BY 1`,
  ]);
  const g = new Map(geo.map((r) => [String(r.mo), r])), o = new Map(opex.map((r) => [String(r.mo), n(r.opex)]));
  const out: MonthRow[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i, 1));
    const mo = iso(d).slice(0, 7), r = g.get(mo);
    const asg = n(r?.asg), deals = n(r?.deals), cost = n(r?.cost), opx = o.get(mo) ?? 0, revenue = asg + deals;
    if (!r && !opx && i > 0) continue; // months before the data start are not shown
    out.push({ month: mo, asg, deals, revenue, cost, opex: opx, margin: revenue - cost - opx, romi: m.romi(revenue, cost), isCurrent: i === 0 });
  }
  return out;
}

export interface OpexEntryRow { id: string; month: string; title: string; category: string; amount: number; siteId: string | null; domain: string | null; note: string | null }

/** Operating expense entries of the last `count` months, newest month first. */
export async function opexEntries(count = 6, today = iso(new Date())): Promise<OpexEntryRow[]> {
  const since = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - count, 1));
  const list = await db.opexEntry.findMany({ where: { month: { gte: since } }, include: { site: true }, orderBy: [{ month: "desc" }, { createdAt: "asc" }] });
  return list.map((e) => ({ id: e.id, month: iso(e.month).slice(0, 7), title: e.title, category: e.category, amount: Number(e.amount),
    siteId: e.siteId, domain: e.site?.domain ?? null, note: e.note }));
}
