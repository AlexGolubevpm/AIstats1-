// Hypotheses: gathers the inputs of every rule in one pass over the daily analytics and reads the
// stored list for the page (docs/product/03-pages.md#hypotheses).
import type { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import { presetPeriod, previousPeriod } from "@/lib/period";
import * as m from "@/lib/metrics";
import {
  bundleCostShare, dealBelowRotation, floorRecs, formatMissingVsPeers, freePlaceRecs, fromAlert, geoBelowNetwork, lossSites, marginDrop, median, mergeCandidates,
  networkUnderused, siteBelowBundle, sourceAboveRevenue, sourceRecs, zoneRecs, type HypScope, type HypothesisCandidate, type MarginTrendRow,
} from "@/server/domain/hypotheses";
import { inventoryGrid } from "./inventory";
import { networksTable, sitesTable } from "./reports";
import { D, iso } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));
const s = (v: unknown) => String(v);

/** Every candidate the rules and the open alerts produce today, deduped (alerts first). */
export async function collectCandidates(today = iso(new Date())): Promise<HypothesisCandidate[]> {
  const p7 = presetPeriod("7d", today), p30 = presetPeriod("30d", today), prev7 = previousPeriod(p7);
  const r7 = { from: D(p7.from), to: D(p7.to) }, rPrev = { from: D(prev7.from), to: D(prev7.to) };
  const [alerts, sites, zones, sources, grid, siteNames, bundleSites, geo, formats, nets, dealRot, prevSites, cuts] = await Promise.all([
    db.alert.findMany({ where: { resolvedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }] } }),
    sitesTable(p7),
    db.$queryRaw<Raw[]>`
      SELECT z.zone_id, z.site_id, s.domain, z.zone_name zone, z.format, SUM(z.imps_own)::float8 imps, SUM(z.revenue)::float8 revenue,
             SUM(z.imps_own) FILTER (WHERE z.date >= ${r7.from})::float8 imps7, SUM(z.views) FILTER (WHERE z.date >= ${r7.from})::float8 views7,
             SUM(z.revenue) FILTER (WHERE z.date >= ${r7.from})::float8 revenue7,
             SUM(SUM(z.revenue)) OVER (PARTITION BY z.site_id, z.format) site_revenue, SUM(SUM(z.imps_own)) OVER (PARTITION BY z.site_id, z.format) site_imps
      FROM v_zone_daily z JOIN "Site" s ON s.id = z.site_id
      WHERE z.date BETWEEN ${D(p30.from)} AND ${D(p30.to)} AND s.status <> 'ARCHIVED' GROUP BY 1, 2, 3, 4, 5`,
    db.$queryRaw<Raw[]>`
      SELECT c."siteId" site_id, s.domain, cs.slug source_slug, cs.title source, SUM(c.cost)::float8 cost,
             (SELECT SUM(revenue) FROM v_site_geo_daily g WHERE g.site_id = c."siteId" AND g.date BETWEEN ${r7.from} AND ${r7.to})::float8 site_revenue,
             (SELECT SUM(f."pageLoads") FROM "FactTrafficSource" f WHERE f."siteId" = c."siteId" AND f."sourceSlug" = c."sourceSlug" AND f.date BETWEEN ${r7.from} AND ${r7.to})::float8 loads,
             (SELECT SUM(f."pageLoads") FROM "FactTrafficSource" f WHERE f."siteId" = c."siteId" AND f.date BETWEEN ${r7.from} AND ${r7.to})::float8 site_loads,
             (SELECT SUM(page_loads) FROM v_site_geo_daily g WHERE g.site_id = c."siteId" AND g.date BETWEEN ${r7.from} AND ${r7.to})::float8 site_geo_loads
      FROM "FactCost" c JOIN "Site" s ON s.id = c."siteId" JOIN "CostSource" cs ON cs.slug = c."sourceSlug"
      WHERE c.date BETWEEN ${r7.from} AND ${r7.to} AND s.status <> 'ARCHIVED' GROUP BY 1, 2, 3, 4, c."sourceSlug"`,
    inventoryGrid(today, p7),
    db.site.findMany({ select: { id: true, domain: true } }),
    // Site × bundle with the site's week: the peer groups every "vs bundle" rule compares within.
    db.$queryRaw<Raw[]>`
      SELECT b.id bundle_id, b.title bundle_title, b.slug bundle_slug, s.id site_id, s.domain,
             COALESCE(SUM(g.revenue), 0)::float8 revenue, COALESCE(SUM(g.page_loads), 0)::float8 page_loads, COALESCE(SUM(g.cost), 0)::float8 cost
      FROM "BundleSite" bs JOIN "Bundle" b ON b.id = bs."bundleId" JOIN "Site" s ON s.id = bs."siteId" AND s.status <> 'ARCHIVED'
      LEFT JOIN v_site_geo_daily g ON g.site_id = s.id AND g.date BETWEEN ${r7.from} AND ${r7.to}
      GROUP BY 1, 2, 3, 4, 5`,
    db.$queryRaw<Raw[]>`
      SELECT g.site_id, s.domain, g.country_code, SUM(g.revenue)::float8 revenue, SUM(g.page_loads)::float8 page_loads
      FROM v_site_geo_alloc_daily g JOIN "Site" s ON s.id = g.site_id AND s.status <> 'ARCHIVED'
      WHERE g.date BETWEEN ${r7.from} AND ${r7.to} GROUP BY 1, 2, 3`,
    db.$queryRaw<Raw[]>`SELECT site_id, format, SUM(revenue)::float8 revenue, SUM(page_loads)::float8 page_loads FROM v_format_daily WHERE date BETWEEN ${r7.from} AND ${r7.to} GROUP BY 1, 2`,
    db.$queryRaw<Raw[]>`
      SELECT g.site_id, g.network_id, g.network_title network, SUM(g.revenue)::float8 revenue, SUM(g.page_loads)::float8 page_loads
      FROM v_network_geo g JOIN "Network" nw ON nw.id = g.network_id AND nw.slug <> 'own_deals'
      WHERE g.date BETWEEN ${r7.from} AND ${r7.to} GROUP BY 1, 2, 3`,
    db.$queryRaw<Raw[]>`
      SELECT d.deal_id, d.deal_title title, d.advertiser, d.site_id, s.domain, dl.format::text format, SUM(d.revenue)::float8 deal_revenue, SUM(d.page_loads)::float8 deal_loads,
             (SELECT CASE WHEN SUM(f.page_loads) > 0 THEN SUM(f.revenue) / SUM(f.page_loads) * 1000 END FROM v_format_daily f
               WHERE f.site_id = d.site_id AND f.format = dl.format::text AND f.date BETWEEN ${r7.from} AND ${r7.to})::float8 rotation_per_1k
      FROM v_deal_daily d JOIN "Deal" dl ON dl.id = d.deal_id AND dl.status = 'ACTIVE' JOIN "Site" s ON s.id = d.site_id
      WHERE d.date BETWEEN ${r7.from} AND ${r7.to} GROUP BY 1, 2, 3, 4, 5, 6, dl.format`,
    sitesTable(prev7),
    // Per-site deltas of the cuts between the two weeks: the evidence of a margin drop.
    db.$queryRaw<Raw[]>`
      SELECT site_id, kind, name, SUM(cur) - SUM(prev) delta FROM (
        SELECT site_id, 'гео' kind, country_code name,
               SUM(revenue) FILTER (WHERE date BETWEEN ${r7.from} AND ${r7.to})::float8 cur, SUM(revenue) FILTER (WHERE date BETWEEN ${rPrev.from} AND ${rPrev.to})::float8 prev
        FROM v_site_geo_daily WHERE date BETWEEN ${rPrev.from} AND ${r7.to} GROUP BY 1, 2, 3
        UNION ALL
        SELECT site_id, 'сетка', network_title,
               SUM(revenue) FILTER (WHERE date BETWEEN ${r7.from} AND ${r7.to})::float8, SUM(revenue) FILTER (WHERE date BETWEEN ${rPrev.from} AND ${rPrev.to})::float8
        FROM v_network_geo WHERE date BETWEEN ${rPrev.from} AND ${r7.to} GROUP BY 1, 2, 3
        UNION ALL
        SELECT site_id, 'формат', format,
               SUM(revenue) FILTER (WHERE date BETWEEN ${r7.from} AND ${r7.to})::float8, SUM(revenue) FILTER (WHERE date BETWEEN ${rPrev.from} AND ${rPrev.to})::float8
        FROM v_format_daily WHERE date BETWEEN ${rPrev.from} AND ${r7.to} GROUP BY 1, 2, 3
      ) x GROUP BY 1, 2, 3 HAVING SUM(cur) - SUM(prev) < 0`,
  ]);
  const domainOf = new Map(siteNames.map((x) => [x.id, x.domain]));
  const live = sites.filter((x) => x.status !== "ARCHIVED");
  const liveIds = new Set(live.map((x) => x.id));
  // Networks per site: the floor is a per-site rule, so one table per site with traffic (top 30 by revenue keeps it cheap).
  const floorNets = (await Promise.all(live.filter((x) => x.revenue > 0).slice(0, 30).map(async (x) =>
    (await networksTable(p7, { siteIds: [x.id] })).map((r) => ({ siteId: x.id, domain: x.domain, network: r.network, revPer1k: r.revPer1k, floor: r.floor,
      volShare: r.volShare, pageLoads: r.pageLoads, belowFloor: r.belowFloor }))))).flat();
  const ranked = [...live].sort((a, b) => b.revenue - a.revenue);
  const free = grid.sites.map((g) => {
    const rank = ranked.findIndex((x) => x.id === g.id) + 1;
    // What an occupied place on this site brings: the median of the cells that earned in the window.
    const occupied = Object.values(g.cells).filter((c) => c.use !== "FREE" && c.revenue > 0).map((c) => c.revenue);
    return { siteId: g.id, domain: g.domain, free: g.free, places: grid.places.length, revenue: ranked[rank - 1]?.revenue ?? 0, rank: rank || 999, placeMedian: median(occupied) };
  });
  const bundleRows = bundleSites.map((b) => ({ bundleId: s(b.bundle_id), bundleTitle: s(b.bundle_title), bundleSlug: s(b.bundle_slug), siteId: s(b.site_id), domain: s(b.domain), revenue: n(b.revenue), pageLoads: n(b.page_loads), cost: n(b.cost) }));
  const siteTotals = new Map(bundleRows.map((b) => [b.siteId, b]));
  const bundleTotals = new Map<string, { bundleId: string; title: string; slug: string; revenue: number; cost: number }>();
  for (const b of bundleRows) {
    const t = bundleTotals.get(b.bundleId) ?? { bundleId: b.bundleId, title: b.bundleTitle, slug: b.bundleSlug, revenue: 0, cost: 0 };
    t.revenue += b.revenue; t.cost += b.cost; bundleTotals.set(b.bundleId, t);
  }
  const network = { revenue: live.reduce((a, x) => a + x.revenue, 0), cost: live.reduce((a, x) => a + x.cost, 0) };
  const prevBySite = new Map(prevSites.map((x) => [x.id, x]));
  const dropsBySite = new Map<string, MarginTrendRow["drops"]>();
  for (const c of cuts) dropsBySite.set(s(c.site_id), [...(dropsBySite.get(s(c.site_id)) ?? []), { kind: s(c.kind) as "гео", name: s(c.name), delta: n(c.delta) }]);
  const netShare = nets.filter((x) => liveIds.has(s(x.site_id))).flatMap((x) => {
    const site = siteTotals.get(s(x.site_id)); if (!site) return [];
    const sr = sitesTotalsFor(bundleRows, s(x.site_id));
    return sr.map((b) => ({ bundleId: b.bundleId, bundleTitle: b.bundleTitle, bundleSlug: b.bundleSlug, siteId: b.siteId, domain: b.domain, networkId: s(x.network_id), network: s(x.network),
      revenue: n(x.revenue), pageLoads: n(x.page_loads), siteLoads: b.pageLoads, siteRevenue: b.revenue }));
  });
  return mergeCandidates([
    alerts.map((a) => fromAlert({ id: a.id, rule: a.rule, entityKey: a.entityKey, level: a.level, title: a.title, message: a.message, link: a.link, siteId: a.siteId, domain: a.siteId ? domainOf.get(a.siteId) ?? null : null, moneyAtRisk: Number(a.moneyAtRisk),
      action: typeof (a.payload as Record<string, unknown>)?.action === "string" ? String((a.payload as Record<string, unknown>).action) : null })),
    lossSites(live, 7),
    marginDrop(live.map((x) => { const prev = prevBySite.get(x.id); return { siteId: x.id, domain: x.domain, revenue: x.revenue, prevRevenue: prev?.revenue ?? 0, margin: x.margin, prevMargin: prev?.margin ?? 0, drops: dropsBySite.get(x.id) ?? [] }; }), 7),
    zoneRecs(zones.map((z) => ({ zoneId: s(z.zone_id), siteId: s(z.site_id), domain: s(z.domain), zone: s(z.zone), format: s(z.format), imps: n(z.imps), revenue: n(z.revenue),
      share: m.share(n(z.revenue), n(z.site_revenue)), impShare: m.share(n(z.imps), n(z.site_imps)), imps7: n(z.imps7), revenue7: n(z.revenue7),
      viewRate7: z.format === "BANNER" || z.format === "NATIVE" ? m.viewRate(n(z.views7), n(z.imps7)) : null }))),
    floorRecs(floorNets, 7),
    networkUnderused(netShare, 7),
    sourceRecs(sources.map((r) => ({ siteId: s(r.site_id), domain: s(r.domain), source: s(r.source), sourceSlug: s(r.source_slug), cost: n(r.cost), siteRevenue: n(r.site_revenue), loadsShare: m.share(n(r.loads), n(r.site_loads)) })), 7),
    sourceAboveRevenue(sources.map((r) => ({ siteId: s(r.site_id), domain: s(r.domain), sourceSlug: s(r.source_slug), source: s(r.source), cost: n(r.cost), loads: n(r.loads), siteRevenue: n(r.site_revenue), siteLoads: n(r.site_geo_loads) })), 7),
    siteBelowBundle(bundleRows, 7),
    geoBelowNetwork(geo.filter((g) => liveIds.has(s(g.site_id))).map((g) => ({ siteId: s(g.site_id), domain: s(g.domain), countryCode: s(g.country_code), revenue: n(g.revenue), pageLoads: n(g.page_loads) })), 7),
    formatMissingVsPeers(bundleRows, formats.map((f) => ({ siteId: s(f.site_id), format: s(f.format), revenue: n(f.revenue), pageLoads: n(f.page_loads) })), 7),
    bundleCostShare([...bundleTotals.values()], network, 7),
    dealBelowRotation(dealRot.map((d) => ({ dealId: s(d.deal_id), title: s(d.title), advertiser: s(d.advertiser), siteId: s(d.site_id), domain: s(d.domain), format: s(d.format), dealRevenue: n(d.deal_revenue), dealLoads: n(d.deal_loads), rotationPer1k: d.rotation_per_1k == null ? null : n(d.rotation_per_1k) })), 7),
    freePlaceRecs(free),
  ]);
}
/** The bundle rows of one site (a site can sit in several bundles). */
const sitesTotalsFor = (rows: { siteId: string; bundleId: string; bundleTitle: string; bundleSlug: string; domain: string; revenue: number; pageLoads: number }[], siteId: string) => rows.filter((b) => b.siteId === siteId);

export type HypothesisTab = "proposed" | "accepted" | "done" | "all";
export const TAB_LABEL: Record<HypothesisTab, string> = { proposed: "Предложено системой", accepted: "В работе", done: "Проверено", all: "Все" };

export interface HypothesisFilter {
  tab: HypothesisTab; scope?: HypScope | null; bundleSiteIds?: string[] | null; bundleId?: string | null; page?: number;
  /** One site's hypotheses (the site page block, `?site=`). */
  siteId?: string | null;
  /** Only the sites in this list — the «Топ-10 сайтов» chip passes the ids of the week's top earners. */
  siteIds?: string[] | null;
}
export const HYPOTHESES_PAGE = 50;

const TAB_WHERE: Record<HypothesisTab, Prisma.HypothesisWhereInput> = {
  proposed: { status: "PROPOSED" }, accepted: { status: "ACCEPTED" }, done: { status: { in: ["DONE", "REJECTED"] } }, all: { status: { not: "EXPIRED" } },
};

/** The page list: by tab, scope, bundle (a bundle's hypotheses are its own plus those of its sites), one site or a list of sites. */
export async function hypothesesList(f: HypothesisFilter) {
  const where: Prisma.HypothesisWhereInput = {
    ...TAB_WHERE[f.tab], ...(f.scope ? { scope: f.scope } : {}),
    ...(f.bundleSiteIds ? { OR: [{ siteId: { in: f.bundleSiteIds } }, ...(f.bundleId ? [{ bundleId: f.bundleId }] : [])] } : {}),
    ...(f.siteId ? { siteId: f.siteId } : f.siteIds ? { siteId: { in: f.siteIds } } : {}),
  };
  const page = Math.max(1, f.page ?? 1);
  const [rows, total] = await Promise.all([
    db.hypothesis.findMany({ where, include: { site: { select: { id: true, domain: true } }, bundle: { select: { id: true, title: true, slug: true } } },
      // Prisma sorts enums by definition order (INFO < WARNING < CRITICAL), so desc puts critical first.
      orderBy: [{ level: "desc" }, { impactMonth: { sort: "desc", nulls: "last" } }, { lastSeenAt: "desc" }], skip: (page - 1) * HYPOTHESES_PAGE, take: HYPOTHESES_PAGE }),
    db.hypothesis.count({ where }),
  ]);
  return Object.assign(rows, { total, page, pages: Math.max(1, Math.ceil(total / HYPOTHESES_PAGE)) });
}

export async function hypothesisCounts(f: Omit<HypothesisFilter, "tab" | "scope">) {
  const bundle: Prisma.HypothesisWhereInput = {
    ...(f.bundleSiteIds ? { OR: [{ siteId: { in: f.bundleSiteIds } }, ...(f.bundleId ? [{ bundleId: f.bundleId }] : [])] } : {}),
    ...(f.siteId ? { siteId: f.siteId } : f.siteIds ? { siteId: { in: f.siteIds } } : {}),
  };
  const [tabs, scopes] = await Promise.all([
    Promise.all((Object.keys(TAB_WHERE) as HypothesisTab[]).map(async (t) => [t, await db.hypothesis.count({ where: { ...TAB_WHERE[t], ...bundle } })] as const)),
    db.hypothesis.groupBy({ by: ["scope", "status"], _count: { _all: true }, where: bundle }),
  ]);
  return { tabs: Object.fromEntries(tabs) as Record<HypothesisTab, number>, scopes };
}

/** Open proposals for the sidebar badge. */
export const proposedCount = () => db.hypothesis.count({ where: { status: "PROPOSED" } });

/** Top proposals by effect for the overview block. */
export function topHypotheses(limit = 3) {
  return db.hypothesis.findMany({ where: { status: "PROPOSED" }, include: { site: { select: { domain: true } } },
    orderBy: [{ impactMonth: { sort: "desc", nulls: "last" } }, { level: "desc" }], take: limit });
}

/** Ids of the sites that earned the most over the last 7 days — the «Топ-10 сайтов» chip. */
export async function topSiteIds(limit = 10, today = iso(new Date())): Promise<string[]> {
  const rows = await sitesTable(presetPeriod("7d", today));
  return rows.filter((x) => x.status !== "ARCHIVED" && x.revenue > 0).sort((a, b) => b.revenue - a.revenue).slice(0, limit).map((x) => x.id);
}

/** Open and accepted hypotheses about one site, the site page block: critical first, then by effect. */
export function siteHypotheses(siteId: string, limit = 6) {
  return db.hypothesis.findMany({ where: { siteId, status: { in: ["PROPOSED", "ACCEPTED"] } },
    orderBy: [{ level: "desc" }, { impactMonth: { sort: "desc", nulls: "last" } }], take: limit });
}
