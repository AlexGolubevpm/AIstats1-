// Deals pages (docs/product/04-finance-and-deals.md#deals).
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import { closedPeriods, periodsOverlap, type BillingPeriod } from "@/server/domain/deals";
import { D, iso } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

export const BASIS_LABEL: Record<string, string> = {
  PER_1000_LOADS: "за 1000 загрузок", CPM_ADVERTISER: "CPM по счётчику рекл.", CPM_OWN: "CPM по нашему", FLAT_DAILY: "флэт в сутки", FLAT_PERIOD: "флэт за период",
};

async function factSums(p: Period | null) {
  const range = p ? { date: { gte: D(p.from), lte: D(p.to) } } : {};
  const rows = await db.factFixDeal.groupBy({ by: ["dealId", "revenueState"], _sum: { revenue: true, impsOwn: true, impsReported: true }, where: range });
  const withRep = await db.factFixDeal.groupBy({ by: ["dealId"], _sum: { impsOwn: true, impsReported: true }, where: { ...range, dealPeriodId: { not: null }, impsReported: { gt: 0 } } });
  const out = new Map<string, { forecast: number; invoiced: number; confirmed: number; multiplier: number | null }>();
  for (const r of rows) {
    const o = out.get(r.dealId) ?? { forecast: 0, invoiced: 0, confirmed: 0, multiplier: null };
    const v = n(r._sum.revenue);
    if (r.revenueState === "FORECAST") o.forecast += v; else if (r.revenueState === "INVOICED") o.invoiced += v; else o.confirmed += v;
    out.set(r.dealId, o);
  }
  for (const r of withRep) {
    const o = out.get(r.dealId);
    if (o && n(r._sum.impsOwn) > 0) o.multiplier = n(r._sum.impsReported) / n(r._sum.impsOwn);
  }
  return out;
}

export async function dealsList(p: Period, status?: string) {
  const deals = await db.deal.findMany({
    where: status === "archive" ? { status: "ENDED" } : status ? { status: status as never } : { status: { not: "ENDED" } },
    include: { advertiser: true, sites: { include: { site: true } } }, orderBy: [{ status: "asc" }, { createdAt: "desc" }],
  });
  const sums = await factSums(p);
  return deals.map((d) => ({
    id: d.id, title: d.title, advertiser: d.advertiser.name, format: d.format, basis: d.paymentBasis, price: Number(d.price), billedVia: d.billedVia,
    sites: d.sites.map((s) => s.site.domain), status: d.status, ...(sums.get(d.id) ?? { forecast: 0, invoiced: 0, confirmed: 0, multiplier: null }),
  }));
}

/** Work queue: closed billing periods without advertiser numbers, and overdue invoices. */
export async function todoQueue(today = iso(new Date())) {
  const deals = await db.deal.findMany({ where: { status: { in: ["ACTIVE", "PAUSED", "ENDED"] }, billedVia: "DIRECT" }, include: { advertiser: true, periods: { where: { supersededById: null } } } });
  const items: { kind: "enter" | "overdue"; dealId: string; advertiser: string; title: string; from: string; to: string; forecast: number; overdueDays: number; periodId?: string; outstanding?: number }[] = [];
  for (const d of deals) {
    const closed = closedPeriods({ startsAt: iso(d.startsAt), endsAt: d.endsAt ? iso(d.endsAt) : null, billingPeriod: d.billingPeriod as BillingPeriod }, today);
    const entered = d.periods.filter((p) => p.status !== "OPEN").map((p) => ({ from: iso(p.from), to: iso(p.to) }));
    for (const c of closed) {
      if (entered.some((e) => periodsOverlap(e, c))) continue;
      const f = await db.factFixDeal.aggregate({ _sum: { revenue: true }, where: { dealId: d.id, date: { gte: D(c.from), lte: D(c.to) } } });
      const days = Math.round((D(today).getTime() - D(c.to).getTime()) / 86_400_000);
      items.push({ kind: "enter", dealId: d.id, advertiser: d.advertiser.name, title: d.title, ...c, forecast: n(f._sum.revenue), overdueDays: Math.max(0, days - 7) });
    }
    for (const p of d.periods) {
      if (!["INVOICED", "PARTIAL"].includes(p.status) || !p.dueAt || iso(p.dueAt) >= today) continue;
      items.push({ kind: "overdue", dealId: d.id, advertiser: d.advertiser.name, title: d.title, from: iso(p.from), to: iso(p.to), periodId: p.id,
        forecast: n(p.amountInvoiced), outstanding: n(p.amountInvoiced) - n(p.amountPaid), overdueDays: Math.round((D(today).getTime() - p.dueAt.getTime()) / 86_400_000) });
    }
  }
  return items.sort((a, b) => b.overdueDays - a.overdueDays || b.forecast - a.forecast);
}

/** Receivables register with ageing buckets and totals per advertiser. */
export async function paymentsRegister(today = iso(new Date())) {
  const list = await db.dealPeriod.findMany({ where: { supersededById: null, status: { not: "OPEN" } }, include: { deal: { include: { advertiser: true } } }, orderBy: { dueAt: "desc" } });
  const rows = list.map((p) => {
    const outstanding = ["PAID", "WRITTEN_OFF"].includes(p.status) ? 0 : n(p.amountInvoiced) - n(p.amountPaid);
    const overdue = p.dueAt && iso(p.dueAt) < today && outstanding > 0 ? Math.round((D(today).getTime() - p.dueAt.getTime()) / 86_400_000) : 0;
    return { id: p.id, dealId: p.dealId, advertiser: p.deal.advertiser.name, deal: p.deal.title, period: `${iso(p.from)} — ${iso(p.to)}`,
      invoiced: n(p.amountInvoiced), paid: n(p.amountPaid), outstanding, dueAt: p.dueAt ? iso(p.dueAt) : null, overdue,
      bucket: overdue === 0 ? "" : overdue <= 30 ? "0–30" : overdue <= 60 ? "31–60" : "60+", status: p.status };
  });
  const byAdv = new Map<string, { advertiser: string; invoiced: number; paid: number; outstanding: number; b30: number; b60: number; b60p: number }>();
  for (const r of rows) {
    const a = byAdv.get(r.advertiser) ?? { advertiser: r.advertiser, invoiced: 0, paid: 0, outstanding: 0, b30: 0, b60: 0, b60p: 0 };
    a.invoiced += r.invoiced; a.paid += r.paid; a.outstanding += r.outstanding;
    if (r.bucket === "0–30") a.b30 += r.outstanding; else if (r.bucket === "31–60") a.b60 += r.outstanding; else if (r.bucket === "60+") a.b60p += r.outstanding;
    byAdv.set(r.advertiser, a);
  }
  return { rows, advertisers: [...byAdv.values()].sort((a, b) => b.outstanding - a.outstanding) };
}

export async function dealDetail(id: string) {
  const deal = await db.deal.findUnique({ where: { id }, include: { advertiser: true, sites: { include: { site: true, zone: true } } } });
  if (!deal) return null;
  const [periods, history, daily, sums] = await Promise.all([
    db.dealPeriod.findMany({ where: { dealId: id }, orderBy: [{ from: "desc" }, { version: "desc" }] }),
    db.$queryRaw<Raw[]>`SELECT * FROM "AuditLog" WHERE (entity = 'Deal' AND "entityId" = ${id})
      OR (entity = 'DealPeriod' AND "entityId" IN (SELECT id FROM "DealPeriod" WHERE "dealId" = ${id})) ORDER BY at DESC LIMIT 100`,
    db.$queryRaw<Raw[]>`SELECT date, SUM("impsOwn")::float8 own, SUM("impsReported")::float8 reported, SUM("pageLoads")::float8 loads,
      SUM(revenue) FILTER (WHERE "revenueState" = 'FORECAST')::float8 forecast, SUM(revenue) FILTER (WHERE "revenueState" = 'INVOICED')::float8 invoiced,
      SUM(revenue) FILTER (WHERE "revenueState" = 'CONFIRMED')::float8 confirmed
      FROM "FactFixDeal" WHERE "dealId" = ${id} AND date >= ${new Date(Date.now() - 92 * 86_400_000)} GROUP BY 1 ORDER BY 1`,
    factSums(null),
  ]);
  const periodRows = await Promise.all(periods.map(async (p) => {
    const c = await db.factFixDeal.aggregate({ _sum: { impsOwn: true, pageLoads: true }, where: { dealId: id, date: { gte: p.from, lte: p.to }, ...(p.siteId ? { siteId: p.siteId } : {}) } });
    const own = deal.paymentBasis === "PER_1000_LOADS" ? n(c._sum.pageLoads) : n(c._sum.impsOwn);
    return { ...p, own, discrepancy: p.impsReported && own ? (own - p.impsReported) / own : null };
  }));
  const s = sums.get(id) ?? { forecast: 0, invoiced: 0, confirmed: 0, multiplier: null };
  const [own] = await db.$queryRaw<Raw[]>`SELECT SUM("impsOwn")::float8 own FROM "FactFixDeal" WHERE "dealId" = ${id} AND "revenueState" = 'CONFIRMED'`;
  const outstanding = periods.filter((p) => !p.supersededById && ["INVOICED", "PARTIAL", "DISPUTED"].includes(p.status))
    .reduce((a, p) => a + n(p.amountInvoiced) - n(p.amountPaid), 0);
  return {
    deal, periods: periodRows, history, outstanding, ...s, effectiveCpm: n(own?.own) > 0 ? (s.confirmed / n(own?.own)) * 1000 : null,
    daily: daily.map((r) => ({ date: iso(r.date as Date), own: n(r.own), reported: n(r.reported) || null, forecast: n(r.forecast), invoiced: n(r.invoiced), confirmed: n(r.confirmed) })),
  };
}
