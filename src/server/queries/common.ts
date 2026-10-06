// Shared read helpers for pages. Numbers leave SQL as float8 for display only; money is
// aggregated in SQL (numeric) — the UI never sums money itself.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { eachDay, previousPeriod, type Period } from "@/lib/period";
import * as m from "@/lib/metrics";

export const D = (s: string) => new Date(`${s}T00:00:00Z`);
export const iso = (x: Date) => x.toISOString().slice(0, 10);

export interface Scope { siteIds?: string[] | null; countryCode?: string | null }

function where(p: Period, s: Scope) {
  const parts = [Prisma.sql`g.date BETWEEN ${D(p.from)} AND ${D(p.to)}`];
  if (s.siteIds) parts.push(s.siteIds.length ? Prisma.sql`g.site_id IN (${Prisma.join(s.siteIds)})` : Prisma.sql`false`);
  if (s.countryCode) parts.push(Prisma.sql`g.country_code = ${s.countryCode}`);
  parts.push(Prisma.sql`g.site_id IN (SELECT id FROM "Site" WHERE status <> 'ARCHIVED')`);
  return Prisma.join(parts, " AND ");
}

export interface Totals {
  revenue: number; revenueConfirmed: number; revenueDirect: number; cost: number; margin: number; uniques: number; pageviews: number;
  pageLoads: number; impsOwn: number; romi: number | null; rpm: number | null; depth: number | null; revPer1k: number | null;
}

const toTotals = (r: Record<string, number | null> | undefined): Totals => {
  const n = (k: string) => Number(r?.[k] ?? 0);
  const revenue = n("revenue"), cost = n("cost"), uniques = n("uniques");
  return {
    revenue, cost, uniques, revenueConfirmed: n("revenue_confirmed"), revenueDirect: n("revenue_direct"), margin: revenue - cost,
    pageviews: n("pageviews"), pageLoads: n("page_loads"), impsOwn: n("imps_own"),
    romi: m.romi(revenue, cost), rpm: m.rpm(n("revenue_tracked"), uniques), depth: m.depth(n("pageviews"), uniques), revPer1k: m.revPer1kLoads(revenue, n("page_loads")),
  };
};

// revenue_tracked: revenue of site-days Metrika counted uniques for — the RPM numerator (a site without Metrika must not inflate RPM).
const SUMS = Prisma.sql`SUM(revenue)::float8 revenue, SUM(revenue_confirmed)::float8 revenue_confirmed, SUM(revenue_direct)::float8 revenue_direct,
  SUM(cost)::float8 cost, SUM(uniques)::float8 uniques, SUM(pageviews)::float8 pageviews, SUM(page_loads)::float8 page_loads, SUM(imps_own)::float8 imps_own,
  SUM(revenue) FILTER (WHERE EXISTS (SELECT 1 FROM "FactTraffic" t WHERE t."siteId" = g.site_id AND t.date = g.date AND t.uniques > 0))::float8 revenue_tracked`;

export async function totals(p: Period, s: Scope = {}): Promise<Totals> {
  const [r] = await db.$queryRaw<Record<string, number | null>[]>`SELECT ${SUMS} FROM v_site_geo_daily g WHERE ${where(p, s)}`;
  return toTotals(r);
}

export async function dailyTotals(p: Period, s: Scope = {}): Promise<(Totals & { date: string })[]> {
  const rows = await db.$queryRaw<(Record<string, number | null> & { date: Date })[]>`
    SELECT g.date, ${SUMS} FROM v_site_geo_daily g WHERE ${where(p, s)} GROUP BY g.date ORDER BY g.date`;
  const byDay = new Map(rows.map((r) => [iso(r.date), toTotals(r)]));
  // Missing days stay null-ish so charts show a gap, not a drop to zero.
  return eachDay(p).map((date) => ({ date, ...(byDay.get(date) ?? ({ ...toTotals(undefined), revenue: NaN } as Totals)) }));
}

export interface KpiSet { cur: Totals; prev: Totals; spark: (Totals & { date: string })[] }

export async function kpis(p: Period, s: Scope = {}): Promise<KpiSet> {
  const sparkP = { from: shift(p.to, -13), to: p.to };
  const [cur, prev, spark] = await Promise.all([totals(p, s), totals(previousPeriod(p), s), dailyTotals(sparkP, s)]);
  return { cur, prev, spark };
}

/**
 * Days of the period that have AdSpyglass revenue but no per-site traffic-source cut: their cost is
 * 0 not because traffic was free but because it was never loaded (totals-only backfill, a skipped
 * night). Margin and ROMI over such days are overstated; the KPI row shows a warning.
 */
export async function costCoverage(p: Period, s: Scope = {}): Promise<{ days: number; missing: number; warn?: string }> {
  const rows = await db.$queryRaw<{ date: Date; has: boolean }[]>`
    SELECT g.date, EXISTS (SELECT 1 FROM "FactTrafficSource" f WHERE f.date = g.date AND f."siteId" = g.site_id) has
    FROM v_site_geo_daily g WHERE ${where(p, s)} AND g.revenue_mediated > 0 GROUP BY g.date, g.site_id`;
  const byDay = new Map<string, boolean>();
  for (const r of rows) byDay.set(iso(r.date), (byDay.get(iso(r.date)) ?? false) || r.has);
  const days = byDay.size, missing = [...byDay.values()].filter((h) => !h).length;
  return { days, missing, warn: missing ? `Расход не загружен за ${missing} из ${days} дн. с выручкой: маржа и ROMI за период завышены` : undefined };
}

export function shift(s: string, n: number): string {
  return iso(new Date(D(s).getTime() + n * 86_400_000));
}

export const sparkOf = (k: KpiSet, f: (t: Totals) => number | null) => k.spark.map((t) => (Number.isNaN(t.revenue) ? null : f(t)));

/** Sites (non-archived) with their bundles. */
export async function siteList() {
  return db.site.findMany({ where: { status: { not: "ARCHIVED" } }, include: { bundles: { include: { bundle: true } } }, orderBy: { domain: "asc" } });
}

export async function bundleSiteIds(bundleId: string): Promise<string[]> {
  return (await db.bundleSite.findMany({ where: { bundleId }, select: { siteId: true } })).map((x) => x.siteId);
}

export const countryNames = async () => new Map((await db.country.findMany()).map((c) => [c.code, c.nameRu]));

/** Freshness of each source: time since the last successful ingest and whether the last run failed. */
export async function freshness() {
  const out: { source: string; label: string; lastOk: Date | null; failed: boolean }[] = [];
  for (const [source, label] of [["adspyglass", "AdSpyglass"], ["metrika", "Метрика"]] as const) {
    const [lastOk, last] = await Promise.all([
      db.ingestRun.findFirst({ where: { source, status: { in: ["ok", "partial"] } }, orderBy: { startedAt: "desc" } }),
      db.ingestRun.findFirst({ where: { source, status: { not: "running" } }, orderBy: { startedAt: "desc" } }),
    ]);
    out.push({ source, label, lastOk: lastOk?.finishedAt ?? lastOk?.startedAt ?? null, failed: last?.status === "failed" });
  }
  return out;
}
