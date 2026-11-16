// Numbers of the morning Telegram digest (ADR 0022): yesterday against the average of the 7 days
// before it — the network (over sites, never a sum of bundles), bundles, sites, traffic cost by
// source, active alerts and the state of the load. All money is summed in SQL over v_site_geo_daily:
// `revenue_mediated` is everything AdSpyglass reports (deals billed via ADOK are inside it),
// `revenue_direct` — fix deals billed directly, so the two never overlap.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";
import type { DigestData } from "@/lib/digest";
import { asgPause } from "@/server/ingest/run";

const LIVE = Prisma.sql`(SELECT id FROM "Site" WHERE status <> 'ARCHIVED')`;
const n = (v: unknown) => Number(v ?? 0);

/** Yesterday is loaded for good: the per-site country cut is there and derive ran after the day ended. */
export async function digestReady(db: PrismaClient, day: string): Promise<boolean> {
  const [cut, derived] = await Promise.all([
    db.factRevenueGeo.count({ where: { date: new Date(`${day}T00:00:00Z`), countryCode: { not: "ZZ" } }, take: 1 }),
    db.ingestRun.count({ where: { source: "derive", status: { in: ["ok", "partial"] }, startedAt: { gt: new Date(`${day}T23:59:59Z`) }, dateTo: { gte: new Date(`${day}T00:00:00Z`) } }, take: 1 }),
  ]);
  return cut > 0 && derived > 0;
}

export async function digestData(db: PrismaClient, day: string, now = new Date()): Promise<DigestData> {
  const from = addDays(day, -7), prevTo = addDays(day, -1);
  const fresh = new Date(now.getTime() - 26 * 3_600_000); // "new" = first seen since the previous digest (a day and a margin)
  const win = Prisma.sql`g.date BETWEEN ${from}::date AND ${day}::date AND g.site_id IN ${LIVE}`;
  const cur = Prisma.sql`FILTER (WHERE g.date = ${day}::date)`, prev = Prisma.sql`FILTER (WHERE g.date <= ${prevTo}::date)`;
  const [[net], bundles, sites, costs, overlap, alerts, pause, [cov], lastDerive, ready] = await Promise.all([
    db.$queryRaw<Record<string, number | null>[]>`
      SELECT COUNT(DISTINCT g.date) FILTER (WHERE g.date <= ${prevTo}::date AND (g.revenue <> 0 OR g.page_loads > 0))::int base_days,
        SUM(g.revenue) ${cur}::float8 revenue, SUM(g.revenue_mediated) ${cur}::float8 mediated, SUM(g.revenue_direct) ${cur}::float8 direct,
        SUM(g.cost) ${cur}::float8 cost, SUM(g.margin) ${cur}::float8 margin,
        SUM(g.revenue) ${prev}::float8 p_revenue, SUM(g.cost) ${prev}::float8 p_cost, SUM(g.margin) ${prev}::float8 p_margin
      FROM v_site_geo_daily g WHERE ${win}`,
    db.$queryRaw<{ name: string; revenue: number | null; margin: number | null; p_revenue: number | null }[]>`
      SELECT b.title name, SUM(g.revenue) ${cur}::float8 revenue, SUM(g.margin) ${cur}::float8 margin, SUM(g.revenue) ${prev}::float8 p_revenue
      FROM v_site_geo_daily g JOIN "BundleSite" bs ON bs."siteId" = g.site_id JOIN "Bundle" b ON b.id = bs."bundleId"
      WHERE ${win} GROUP BY b.id, b.title`,
    db.$queryRaw<{ name: string; revenue: number | null; margin: number | null; loads: number | null; p_revenue: number | null; p_loads: number | null }[]>`
      SELECT s.domain name, SUM(g.revenue) ${cur}::float8 revenue, SUM(g.margin) ${cur}::float8 margin, SUM(g.page_loads) ${cur}::float8 loads,
        SUM(g.revenue) ${prev}::float8 p_revenue, SUM(g.page_loads) ${prev}::float8 p_loads
      FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id WHERE ${win} GROUP BY s.id, s.domain`,
    db.$queryRaw<{ title: string; cost: number }[]>`
      SELECT COALESCE(cs.title, c."sourceSlug") title, SUM(c.cost)::float8 cost FROM "FactCost" c LEFT JOIN "CostSource" cs ON cs.slug = c."sourceSlug"
      WHERE c.date = ${day}::date AND c."siteId" IN ${LIVE} GROUP BY 1`,
    db.$queryRaw<{ n: number }[]>`SELECT COUNT(*)::int n FROM (SELECT "siteId" FROM "BundleSite" WHERE "siteId" IN ${LIVE} GROUP BY 1 HAVING COUNT(*) > 1) x`,
    // One line per rule and level: how many are active, how many are new, the money at risk, the costliest one's title.
    db.$queryRaw<{ level: "CRITICAL" | "WARNING"; rule: string; title: string; count: number; new_count: number; risk: number }[]>`
      SELECT a.level::text "level", a.rule, (ARRAY_AGG(a.title ORDER BY (a."firstSeenAt" >= ${fresh}) DESC, a."moneyAtRisk" DESC, a.title))[1] title,
        COUNT(*)::int count, COUNT(*) FILTER (WHERE a."firstSeenAt" >= ${fresh})::int new_count,
        SUM(a."moneyAtRisk") FILTER (WHERE a.level = 'CRITICAL' OR a."firstSeenAt" >= ${fresh})::float8 risk
      FROM "Alert" a WHERE a."resolvedAt" IS NULL AND (a."snoozedUntil" IS NULL OR a."snoozedUntil" < ${now})
      GROUP BY a.level, a.rule ORDER BY 6 DESC NULLS LAST, 4 DESC`,
    asgPause(db),
    // Sites with AdSpyglass revenue yesterday but no traffic-source cut: their cost is 0 because it was not loaded.
    db.$queryRaw<{ missing: number; sites: number }[]>`
      SELECT COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "FactTrafficSource" f WHERE f.date = x.date AND f."siteId" = x.site_id))::int missing, COUNT(*)::int sites
      FROM (SELECT g.date, g.site_id FROM v_site_geo_daily g WHERE g.date = ${day}::date AND g.site_id IN ${LIVE} GROUP BY 1, 2 HAVING SUM(g.revenue_mediated) > 0) x`,
    db.ingestRun.findFirst({ where: { source: "derive", status: { not: "running" } }, orderBy: { startedAt: "desc" } }),
    digestReady(db, day),
  ]);
  const base = n(net?.base_days);
  const avg = (v: number | null | undefined) => (base ? n(v) / base : 0);
  const health: string[] = [];
  if (pause) health.push(`AdSpyglass на паузе до ${pause.until.slice(11, 16)} UTC: ${pause.reason.slice(0, 80)}`);
  if (n(cov?.missing) > 0) health.push(`Расход не загружен у ${cov!.missing} из ${cov!.sites} сайтов — маржа завышена`);
  if (lastDerive?.status === "failed") health.push("Ночной пересчёт (derive) упал — дилы и алерты не обновлены");
  return {
    day, baseDays: base,
    total: { revenue: n(net?.revenue), mediated: n(net?.mediated), direct: n(net?.direct), cost: n(net?.cost), margin: n(net?.margin) },
    avg: { revenue: avg(net?.p_revenue), cost: avg(net?.p_cost), margin: avg(net?.p_margin) },
    bundles: bundles.map((b) => ({ name: b.name, revenue: n(b.revenue), margin: n(b.margin), avgRevenue: avg(b.p_revenue) })),
    bundlesOverlap: n(overlap[0]?.n) > 0,
    sites: sites.map((s) => ({ name: s.name, revenue: n(s.revenue), margin: n(s.margin), avgRevenue: avg(s.p_revenue), pageLoads: n(s.loads), avgLoads: avg(s.p_loads) })),
    costs: costs.map((c) => ({ title: c.title, cost: n(c.cost) })),
    alerts: alerts.map((a) => ({ level: a.level, rule: a.rule, title: a.title, count: a.count, newCount: a.new_count, moneyAtRisk: n(a.risk) })),
    health, incomplete: !ready,
  };
}
