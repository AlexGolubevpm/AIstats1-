// Gathers the inputs of every recommendation rule in one pass (docs/product/03-pages.md#recommendations).
import { db } from "@/server/db";
import { presetPeriod } from "@/lib/period";
import * as m from "@/lib/metrics";
import { floorRecs, freePlaceRecs, fromAlert, lossSites, mergeRecs, sourceRecs, zoneRecs, type Recommendation } from "@/server/domain/recommendations";
import { inventoryGrid } from "./inventory";
import { networksTable, sitesTable } from "./reports";
import { D, iso } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

export async function recommendations(today = iso(new Date())): Promise<Recommendation[]> {
  const p7 = presetPeriod("7d", today), p30 = presetPeriod("30d", today);
  const [alerts, sites, zones, sources, grid, siteNames] = await Promise.all([
    db.alert.findMany({ where: { resolvedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }] } }),
    sitesTable(p7),
    db.$queryRaw<Raw[]>`
      SELECT z.site_id, s.domain, z.zone_name zone, z.format, SUM(z.imps_own)::float8 imps, SUM(z.views)::float8 views, SUM(z.revenue)::float8 revenue,
             SUM(SUM(z.revenue)) OVER (PARTITION BY z.site_id) site_revenue, SUM(SUM(z.imps_own)) OVER (PARTITION BY z.site_id) site_imps
      FROM v_zone_daily z JOIN "Site" s ON s.id = z.site_id
      WHERE z.date BETWEEN ${D(p30.from)} AND ${D(p30.to)} AND s.status <> 'ARCHIVED' GROUP BY 1, 2, 3, 4`,
    db.$queryRaw<Raw[]>`
      SELECT c."siteId" site_id, s.domain, cs.title source, SUM(c.cost)::float8 cost,
             (SELECT SUM(revenue) FROM v_site_geo_daily g WHERE g.site_id = c."siteId" AND g.date BETWEEN ${D(p7.from)} AND ${D(p7.to)})::float8 site_revenue,
             (SELECT SUM(f."pageLoads") FROM "FactTrafficSource" f WHERE f."siteId" = c."siteId" AND f."sourceSlug" = c."sourceSlug" AND f.date BETWEEN ${D(p7.from)} AND ${D(p7.to)})::float8 loads,
             (SELECT SUM(f."pageLoads") FROM "FactTrafficSource" f WHERE f."siteId" = c."siteId" AND f.date BETWEEN ${D(p7.from)} AND ${D(p7.to)})::float8 site_loads
      FROM "FactCost" c JOIN "Site" s ON s.id = c."siteId" JOIN "CostSource" cs ON cs.slug = c."sourceSlug"
      WHERE c.date BETWEEN ${D(p7.from)} AND ${D(p7.to)} AND s.status <> 'ARCHIVED' GROUP BY 1, 2, 3, c."sourceSlug"`,
    inventoryGrid(today, p7),
    db.site.findMany({ select: { id: true, domain: true } }),
  ]);
  const domainOf = new Map(siteNames.map((s) => [s.id, s.domain]));
  const live = sites.filter((s) => s.status !== "ARCHIVED");
  // Networks per site: the floor is a per-site rule, so one table per site with traffic (top 30 by revenue keeps it cheap).
  const nets = (await Promise.all(live.filter((s) => s.revenue > 0).slice(0, 30).map(async (s) =>
    (await networksTable(p7, { siteIds: [s.id] })).map((r) => ({ siteId: s.id, domain: s.domain, network: r.network, revPer1k: r.revPer1k, floor: r.floor,
      volShare: r.volShare, pageLoads: r.pageLoads, belowFloor: r.belowFloor }))))).flat();
  const ranked = [...live].sort((a, b) => b.revenue - a.revenue);
  const free = grid.sites.map((g) => {
    const rank = ranked.findIndex((s) => s.id === g.id) + 1;
    return { siteId: g.id, domain: g.domain, free: g.free, places: grid.places.length, revenue: ranked[rank - 1]?.revenue ?? 0, rank: rank || 999 };
  });
  return mergeRecs([
    alerts.map((a) => fromAlert({ id: a.id, rule: a.rule, level: a.level, title: a.title, message: a.message, link: a.link, siteId: a.siteId, domain: a.siteId ? domainOf.get(a.siteId) ?? null : null, moneyAtRisk: Number(a.moneyAtRisk) })),
    lossSites(live, 7),
    zoneRecs(zones.map((z) => ({ siteId: String(z.site_id), domain: String(z.domain), zone: String(z.zone), format: String(z.format), imps: n(z.imps), revenue: n(z.revenue),
      share: m.share(n(z.revenue), n(z.site_revenue)), impShare: m.share(n(z.imps), n(z.site_imps)),
      viewRate: z.format === "BANNER" || z.format === "NATIVE" ? m.viewRate(n(z.views), n(z.imps)) : null })), 30),
    floorRecs(nets, 7),
    sourceRecs(sources.map((r) => ({ siteId: String(r.site_id), domain: String(r.domain), source: String(r.source), cost: n(r.cost), siteRevenue: n(r.site_revenue), loadsShare: m.share(n(r.loads), n(r.site_loads)) })), 7),
    freePlaceRecs(free),
  ]);
}
