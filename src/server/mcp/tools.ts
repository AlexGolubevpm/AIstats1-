// MCP tools as plain functions (tested without the transport). Read only: nothing here writes.
// Shaped tools reuse the page queries, so an answer in Claude matches the same block in the UI.
import type { PrismaClient } from "@/generated/prisma/client";
import type { Period } from "@/lib/period";
import { db as appDb } from "@/server/db";
import { bundleSiteIds } from "@/server/queries/common";
import { dealsList } from "@/server/queries/deals";
import { bundlesTable, devicesTable, formatsTable, geoTable, networksTable, sitesTable, zonesTable } from "@/server/queries/reports";
import { guardSql, MAX_ROWS } from "./sql-guard";

export class ToolError extends Error {}

const ISO = /^\d{4}-\d{2}-\d{2}$/;
function period(from?: string, to?: string): Period {
  if (!from || !to || !ISO.test(from) || !ISO.test(to) || from > to) throw new ToolError("date_from / date_to: YYYY-MM-DD, date_from ≤ date_to");
  return { from, to };
}

async function siteId(domain: string): Promise<string> {
  const s = await appDb.site.findFirst({ where: { OR: [{ domain: domain.toLowerCase() }, { id: domain }] } });
  if (!s) throw new ToolError(`Сайт не найден: ${domain}`);
  return s.id;
}

async function bundleSites(slug: string): Promise<string[]> {
  const b = await appDb.bundle.findUnique({ where: { slug } });
  if (!b) throw new ToolError(`Бандл не найден: ${slug}`);
  return bundleSiteIds(b.id);
}

const plain = (v: unknown): unknown => {
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString().slice(0, v.getUTCHours() || v.getUTCMinutes() ? 19 : 10);
  if (v && typeof v === "object" && "toNumber" in v && typeof (v as { toNumber: unknown }).toNumber === "function") return (v as { toNumber(): number }).toNumber();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
};

/** Universal read-only SQL over the reporting views. */
export async function queryTool(db: PrismaClient, sql: string): Promise<{ rows: unknown[]; truncated: boolean }> {
  const safe = guardSql(sql);
  const rows = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10s'");
    await tx.$executeRawUnsafe("SET LOCAL ROLE mcp_reader");
    return tx.$queryRawUnsafe<Record<string, unknown>[]>(safe);
  }, { timeout: 15_000 });
  return { rows: plain(rows) as unknown[], truncated: rows.length >= MAX_ROWS };
}

export type PnlGroup = "bundle" | "site" | "country" | "device" | "format" | "network";

export async function getPnl(a: { date_from: string; date_to: string; group_by: PnlGroup; bundle?: string; site?: string; country?: string }) {
  const p = period(a.date_from, a.date_to);
  const siteIds = a.site ? [await siteId(a.site)] : a.bundle ? await bundleSites(a.bundle) : null;
  const scope = { siteIds, countryCode: a.country?.toUpperCase() ?? null };
  switch (a.group_by) {
    case "bundle": return (await bundlesTable(p)).filter((b) => !a.bundle || b.slug === a.bundle)
      .map(({ slug, title, sites, revenue, cost, margin, romi, uniques, rpm }) => ({ bundle: slug, title, sites, revenue, cost, margin, romi, uniques, rpm }));
    case "site": return (await sitesTable(p, scope)).map(({ domain, revenue, cost, margin, romi, uniques, rpm, pageLoads }) =>
      ({ site: domain, revenue, cost, margin, romi, uniques, rpm, rev_per_1k_loads: pageLoads ? (revenue / pageLoads) * 1000 : null }));
    case "country": return (await geoTable(p, scope, 0)).filter((g) => !scope.countryCode || g.country === scope.countryCode)
      .map(({ country, name, tier, uniques, pageLoads, revenue, cost, margin, romi, revPer1k }) =>
        ({ country, name, tier, uniques, page_loads: pageLoads, revenue, cost, margin, romi, rev_per_1k_loads: revPer1k }));
    case "format": return (await formatsTable(p, scope)).map(({ format, pageLoads, imps, fillRate, cpm, viewRate, revenue, share }) =>
      ({ format, page_loads: pageLoads, imps, fill_rate: fillRate, cpm, view_rate: viewRate, revenue, share, note: "зонный разрез AdSpyglass: без own deals и фикс-дилов, без расхода" }));
    case "network": return (await networksTable(p, scope, scope.countryCode)).map(({ slug, network, pageLoads, volShare, fillRate, revPer1k, rank, discrepancy, revenue }) =>
      ({ network: slug, title: network, page_loads: pageLoads, vol_share: volShare, fill_rate: fillRate, rev_per_1k_loads: revPer1k, rank, discrepancy, revenue }));
    case "device": {
      if (!siteIds || siteIds.length !== 1) throw new ToolError("group_by=device требует site");
      return (await devicesTable(p, siteIds[0])).map((d) => ({ ...d, note: "расход по устройствам не известен" }));
    }
    default: throw new ToolError("group_by: bundle | site | country | device | format | network");
  }
}

export async function getNetworkMatrix(a: { site: string; date_from: string; date_to: string; country?: string }) {
  const p = period(a.date_from, a.date_to);
  const id = await siteId(a.site);
  const cc = a.country?.toUpperCase();
  const countries = cc ? [cc] : (await geoTable(p, { siteIds: [id] }, 10)).map((g) => g.country).filter(Boolean);
  const out: Record<string, unknown>[] = [];
  for (const c of countries) {
    for (const n of await networksTable(p, { siteIds: [id] }, c)) {
      out.push({ country: c, network: n.slug, page_loads: n.pageLoads, vol_share: n.volShare, fill_rate: n.fillRate, rev_per_1k_loads: n.revPer1k,
        rank: n.rank, discrepancy: n.discrepancy, floor_recommendation: n.floor, below_floor: n.belowFloor, waterfall_inversion: n.inverted });
    }
  }
  return out;
}

export async function getZones(a: { site: string; date_from: string; date_to: string }) {
  const p = period(a.date_from, a.date_to);
  return (await zonesTable(p, await siteId(a.site))).map((z) => ({ zone: z.zone, format: z.format, position: z.position, imps: z.imps, views: z.views,
    view_rate: z.viewRate, viewable_cpm: z.viewableCpm, cpm: z.cpm, revenue: z.revenue, share: z.share, invisible: z.invisible, candidate_remove: z.candidateRemove }));
}

export async function getAlerts(a: { level?: "WARNING" | "CRITICAL"; bundle?: string; site?: string }) {
  const siteIds = a.site ? [await siteId(a.site)] : a.bundle ? await bundleSites(a.bundle) : null;
  const rows = await appDb.alert.findMany({
    where: { resolvedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }], ...(a.level ? { level: a.level } : {}), ...(siteIds ? { siteId: { in: siteIds } } : {}) },
    orderBy: [{ level: "desc" }, { moneyAtRisk: "desc" }],
  });
  const base = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  return rows.map((r) => ({ level: r.level, rule: r.rule, title: r.title, message: r.message, money_at_risk: Number(r.moneyAtRisk),
    since: r.firstSeenAt.toISOString().slice(0, 10), link: `${base}${r.link}` }));
}

export async function getDeals(a: { status?: string; advertiser?: string; date_from?: string; date_to?: string }) {
  const today = new Date().toISOString().slice(0, 10);
  const p = a.date_from || a.date_to ? period(a.date_from, a.date_to) : { from: `${today.slice(0, 7)}-01`, to: today };
  const status = a.status ? a.status.toUpperCase() : undefined;
  const list = await dealsList(p, status === "ENDED" ? "archive" : status);
  const outstanding = await appDb.dealPeriod.groupBy({ by: ["dealId"], _sum: { amountInvoiced: true, amountPaid: true },
    where: { supersededById: null, status: { in: ["INVOICED", "PARTIAL", "DISPUTED"] } } });
  const rest = new Map(outstanding.map((o) => [o.dealId, Number(o._sum.amountInvoiced ?? 0) - Number(o._sum.amountPaid ?? 0)]));
  return list.filter((d) => !a.advertiser || d.advertiser.toLowerCase().includes(a.advertiser.toLowerCase())).map((d) => ({
    advertiser: d.advertiser, deal: d.title, status: d.status, format: d.format, payment_basis: d.basis, price: d.price, billed_via: d.billedVia, sites: d.sites,
    forecast: d.forecast, invoiced: d.invoiced, confirmed: d.confirmed, outstanding: rest.get(d.id) ?? 0, imps_multiplier: d.multiplier, period: p,
  }));
}
