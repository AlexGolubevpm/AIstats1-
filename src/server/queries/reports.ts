// Page queries for overview, bundle, site and geo pages (docs/product/03-pages.md).
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import * as m from "@/lib/metrics";
import { previousPeriod } from "@/lib/period";
import { D, iso, type Scope } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

function siteFilter(col: Prisma.Sql, s: Scope) {
  if (!s.siteIds) return Prisma.sql`${col} IN (SELECT id FROM "Site" WHERE status <> 'ARCHIVED')`;
  return s.siteIds.length ? Prisma.sql`${col} IN (${Prisma.join(s.siteIds)})` : Prisma.sql`false`;
}

// ---------- tables by entity ----------

export async function bundlesTable(p: Period) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT b.id, b.slug, b.title, b.color, (SELECT count(*) FROM "BundleSite" x WHERE x."bundleId" = b.id)::int sites,
      COALESCE(SUM(v.revenue), 0)::float8 revenue, COALESCE(SUM(v.cost), 0)::float8 cost, COALESCE(SUM(v.uniques), 0)::float8 uniques,
      COALESCE(SUM(v.pageviews), 0)::float8 pageviews
    FROM "Bundle" b LEFT JOIN v_bundle_daily v ON v.bundle_id = b.id AND v.date BETWEEN ${D(p.from)} AND ${D(p.to)}
    GROUP BY b.id ORDER BY revenue DESC`;
  return rows.map((r) => ({
    id: String(r.id), slug: String(r.slug), title: String(r.title), color: String(r.color), sites: n(r.sites),
    revenue: n(r.revenue), cost: n(r.cost), margin: n(r.revenue) - n(r.cost), romi: m.romi(n(r.revenue), n(r.cost)),
    uniques: n(r.uniques), rpm: m.rpm(n(r.revenue), n(r.uniques)),
  }));
}

/** Sites that belong to more than one bundle: bundle sums exceed the network total by these. */
export async function overlappingSites(): Promise<number> {
  const [r] = await db.$queryRaw<{ c: number }[]>`SELECT count(*)::int c FROM (SELECT "siteId" FROM "BundleSite" GROUP BY 1 HAVING count(*) > 1) x`;
  return r.c;
}

export async function sitesTable(p: Period, s: Scope = {}) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT s.id, s.domain, s.status::text status,
      COALESCE(SUM(g.revenue), 0)::float8 revenue, COALESCE(SUM(g.cost), 0)::float8 cost, COALESCE(SUM(g.uniques), 0)::float8 uniques,
      COALESCE(SUM(g.pageviews), 0)::float8 pageviews, COALESCE(SUM(g.page_loads), 0)::float8 page_loads
    FROM "Site" s LEFT JOIN v_site_geo_daily g ON g.site_id = s.id AND g.date BETWEEN ${D(p.from)} AND ${D(p.to)}
    WHERE ${siteFilter(Prisma.sql`s.id`, s)}
    GROUP BY s.id ORDER BY revenue DESC`;
  return rows.map((r) => {
    const revenue = n(r.revenue), cost = n(r.cost), uniques = n(r.uniques), pv = n(r.pageviews);
    return { id: String(r.id), domain: String(r.domain), status: String(r.status), revenue, cost, margin: revenue - cost, romi: m.romi(revenue, cost),
      uniques, pageviews: pv, depth: m.depth(pv, uniques), rpm: m.rpm(revenue, uniques), pageLoads: n(r.page_loads) };
  });
}

export async function topMovers(p: Period, limit = 5) {
  const prev = previousPeriod(p);
  const rows = await db.$queryRaw<Raw[]>`
    SELECT s.domain,
      COALESCE(SUM(g.margin) FILTER (WHERE g.date BETWEEN ${D(p.from)} AND ${D(p.to)}), 0)::float8 cur,
      COALESCE(SUM(g.margin) FILTER (WHERE g.date BETWEEN ${D(prev.from)} AND ${D(prev.to)}), 0)::float8 prev
    FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id
    WHERE g.date BETWEEN ${D(prev.from)} AND ${D(p.to)} AND s.status <> 'ARCHIVED'
    GROUP BY s.domain`;
  const all = rows.map((r) => ({ domain: String(r.domain), margin: n(r.cur), change: n(r.cur) - n(r.prev) }));
  const up = [...all].filter((x) => x.change > 0).sort((a, b) => b.change - a.change).slice(0, limit);
  const down = [...all].filter((x) => x.change < 0).sort((a, b) => a.change - b.change).slice(0, limit);
  return { up, down };
}

export async function formatsTable(p: Period, s: Scope = {}) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT format, SUM(page_loads)::float8 loads, SUM(imps_own)::float8 imps, SUM(views)::float8 views, SUM(revenue)::float8 revenue
    FROM v_format_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`site_id`, s)}
    GROUP BY format ORDER BY revenue DESC`;
  const total = rows.reduce((a, r) => a + n(r.revenue), 0);
  return rows.map((r) => {
    const loads = n(r.loads), imps = n(r.imps), views = n(r.views), revenue = n(r.revenue), banner = r.format === "BANNER" || r.format === "NATIVE";
    return { format: String(r.format), pageLoads: loads, imps, views: banner ? views : null, fillRate: m.fillRate(imps, loads), cpm: m.cpm(revenue, imps),
      viewRate: banner ? m.viewRate(views, imps) : null, viewableCpm: banner ? m.viewableCpm(revenue, views) : null, revenue, share: m.share(revenue, total) };
  });
}

export async function geoTable(p: Period, s: Scope = {}, top = 20) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT g.country_code cc, c."nameRu" name, c.tier, count(DISTINCT g.site_id)::int sites,
      SUM(g.uniques)::float8 uniques, SUM(g.page_loads)::float8 loads, SUM(g.revenue)::float8 revenue, SUM(g.cost)::float8 cost,
      SUM(g.uniques_bought)::float8 bought
    FROM v_site_geo_daily g LEFT JOIN "Country" c ON c.code = g.country_code
    WHERE g.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`g.site_id`, s)}
    GROUP BY 1, 2, 3 ORDER BY loads DESC`;
  const mapped = rows.map((r) => {
    const revenue = n(r.revenue), cost = n(r.cost);
    return { country: String(r.cc), name: String(r.name ?? r.cc), tier: n(r.tier) || null, sites: n(r.sites), uniques: n(r.uniques), pageLoads: n(r.loads),
      revenue, cost, margin: revenue - cost, romi: m.romi(revenue, cost), revPer1k: m.revPer1kLoads(revenue, n(r.loads)), costPerUnique: m.costPerUnique(cost, n(r.bought)) };
  });
  if (!top || mapped.length <= top) return mapped;
  const rest = mapped.slice(top);
  const sum = (k: "uniques" | "pageLoads" | "revenue" | "cost") => rest.reduce((a, r) => a + r[k], 0);
  const other = { country: "", name: `Прочие (${rest.length})`, tier: null, sites: 0, uniques: sum("uniques"), pageLoads: sum("pageLoads"),
    revenue: sum("revenue"), cost: sum("cost"), margin: sum("revenue") - sum("cost"), romi: m.romi(sum("revenue"), sum("cost")),
    revPer1k: m.revPer1kLoads(sum("revenue"), sum("pageLoads")), costPerUnique: null };
  return [...mapped.slice(0, top), other];
}

/**
 * Networks with volume share, price rank (by rev/1000 loads), discrepancy and the floor
 * recommendation: 60th percentile of rev/1000 loads over the two best sources (14 days).
 */
export async function networksTable(p: Period, s: Scope = {}, countryCode?: string | null) {
  const cf = countryCode ? Prisma.sql`AND country_code = ${countryCode}` : Prisma.empty;
  const rows = await db.$queryRaw<Raw[]>`
    SELECT n.network_slug slug, n.network_title title, nw.color,
      SUM(n.page_loads)::float8 loads, SUM(n.imps_own)::float8 imps, SUM(n.imps_network)::float8 imps_net, SUM(n.revenue)::float8 revenue
    FROM v_network_geo n JOIN "Network" nw ON nw.id = n.network_id
    WHERE n.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`n.site_id`, s)} ${cf}
    GROUP BY 1, 2, 3`;
  const totalLoads = rows.reduce((a, r) => a + n(r.loads), 0);
  const withPrice = rows.map((r) => {
    const loads = n(r.loads), imps = n(r.imps), revenue = n(r.revenue);
    return { slug: String(r.slug), network: String(r.title), color: String(r.color), pageLoads: loads, volShare: m.share(loads, totalLoads),
      fillRate: m.fillRate(imps, loads), revPer1k: m.revPer1kLoads(revenue, loads), discrepancy: m.discrepancy(imps, n(r.imps_net)), revenue,
      impsOwn: imps, impsNetwork: n(r.imps_net) };
  }).sort((a, b) => (b.revPer1k ?? -1) - (a.revPer1k ?? -1));
  const best = withPrice.slice(0, 2).map((x) => x.revPer1k ?? 0).sort((a, b) => a - b);
  const floor = best.length === 2 ? best[0] + (best[1] - best[0]) * 0.6 : best[0] ?? null;
  return withPrice.map((x, i) => ({ ...x, rank: i + 1, belowFloor: floor != null && x.revPer1k != null && x.revPer1k < floor * 0.999 && i > 1,
    inverted: i + 1 > 3 && (x.volShare ?? 0) > 0.3 })).map((x) => ({ ...x, floor }));
}

export async function zonesTable(p: Period, siteId: string) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT z.zone_id id, z.zone_name name, z.format, z.position, SUM(z.imps_own)::float8 imps, SUM(z.views)::float8 views, SUM(z.revenue)::float8 revenue
    FROM v_zone_daily z WHERE z.site_id = ${siteId} AND z.date BETWEEN ${D(p.from)} AND ${D(p.to)}
    GROUP BY 1, 2, 3, 4 ORDER BY revenue DESC`;
  const total = rows.reduce((a, r) => a + n(r.revenue), 0);
  return rows.map((r) => {
    const imps = n(r.imps), views = n(r.views), revenue = n(r.revenue), banner = r.format === "BANNER" || r.format === "NATIVE";
    const viewRate = banner ? m.viewRate(views, imps) : null, share = m.share(revenue, total);
    return { id: String(r.id), zone: String(r.name), format: String(r.format), position: r.position ? String(r.position) : null, imps, views: banner ? views : null,
      viewRate, cpm: m.cpm(revenue, imps), viewableCpm: banner ? m.viewableCpm(revenue, views) : null, revenue, share,
      candidateRemove: share != null && share < 0.01, invisible: viewRate != null && viewRate < 0.15 };
  });
}

export async function devicesTable(p: Period, siteId: string) {
  const [traffic, revenue] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT device::text device, SUM(uniques)::float8 uniques FROM "FactTraffic" WHERE "siteId" = ${siteId} AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1`,
    db.$queryRaw<Raw[]>`SELECT device::text device, SUM("impsOwn")::float8 imps, SUM("revenueReported")::float8 revenue FROM "FactRevenueGeo" WHERE "siteId" = ${siteId} AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1`,
  ]);
  const devices = new Set([...traffic, ...revenue].map((r) => String(r.device)));
  const total = revenue.reduce((a, r) => a + n(r.revenue), 0);
  return [...devices].map((d) => {
    const t = traffic.find((r) => r.device === d), rv = revenue.find((r) => r.device === d);
    const imps = n(rv?.imps), rev = n(rv?.revenue);
    return { device: d, uniques: n(t?.uniques), imps, cpm: m.cpm(rev, imps), revenue: rev, share: m.share(rev, total) };
  }).sort((a, b) => b.revenue - a.revenue);
}

/** Geo rows for one site, each with networks in that country (the nested table). */
export async function siteGeoWithNetworks(p: Period, siteId: string) {
  const geo = await geoTable(p, { siteIds: [siteId] }, 0);
  const nets = await db.$queryRaw<Raw[]>`
    SELECT country_code cc, network_title title, SUM(page_loads)::float8 loads, SUM(imps_own)::float8 imps, SUM(imps_network)::float8 imps_net, SUM(revenue)::float8 revenue
    FROM v_network_geo WHERE site_id = ${siteId} AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1, 2`;
  return geo.map((g) => {
    const mine = nets.filter((r) => r.cc === g.country);
    const loads = mine.reduce((a, r) => a + n(r.loads), 0);
    const children = mine.map((r) => ({ network: String(r.title), pageLoads: n(r.loads), volShare: m.share(n(r.loads), loads),
      revPer1k: m.revPer1kLoads(n(r.revenue), n(r.loads)), discrepancy: m.discrepancy(n(r.imps), n(r.imps_net)), revenue: n(r.revenue) }))
      .sort((a, b) => (b.revPer1k ?? 0) - (a.revPer1k ?? 0)).map((c, i) => ({ ...c, rank: i + 1 }));
    return { ...g, children };
  });
}

// ---------- series ----------

export type SplitBy = "formats" | "sites" | "networks";

/** Stacked daily revenue split by formats (zone cut), sites or networks (geo cut). */
export async function revenueSplitDaily(p: Period, s: Scope, by: SplitBy) {
  let rows: Raw[];
  if (by === "formats") {
    rows = await db.$queryRaw<Raw[]>`SELECT date, format k, SUM(revenue)::float8 v FROM v_format_daily
      WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`site_id`, s)} GROUP BY 1, 2`;
  } else if (by === "sites") {
    rows = await db.$queryRaw<Raw[]>`SELECT g.date, s.domain k, SUM(g.revenue)::float8 v FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id
      WHERE g.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`g.site_id`, s)} GROUP BY 1, 2`;
  } else {
    rows = await db.$queryRaw<Raw[]>`
      SELECT date, network_title k, SUM(revenue)::float8 v FROM v_network_geo
      WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`site_id`, s)} GROUP BY 1, 2
      UNION ALL
      SELECT date, 'Фикс-дилы' k, SUM(revenue)::float8 v FROM v_deal_daily
      WHERE billed_via = 'DIRECT' AND date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`site_id`, s)} GROUP BY 1, 2`;
  }
  return rows.map((r) => ({ date: iso(r.date as Date), key: String(r.k), value: n(r.v) }));
}

/** Site × country ROMI for the top countries by cost (geo page matrix). */
export async function geoMatrix(p: Period, top = 12) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT s.domain, g.country_code cc, SUM(g.revenue)::float8 revenue, SUM(g.cost)::float8 cost
    FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id
    WHERE g.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND s.status <> 'ARCHIVED' GROUP BY 1, 2`;
  const byCountry = new Map<string, number>();
  for (const r of rows) byCountry.set(String(r.cc), (byCountry.get(String(r.cc)) ?? 0) + n(r.cost));
  const countries = [...byCountry].filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, top).map(([c]) => c);
  const sites = [...new Set(rows.map((r) => String(r.domain)))].sort();
  const cell = new Map(rows.map((r) => [`${r.domain}|${r.cc}`, m.romi(n(r.revenue), n(r.cost))]));
  return { countries, sites, value: (site: string, cc: string) => cell.get(`${site}|${cc}`) ?? null, cells: Object.fromEntries(cell) };
}

export async function dataExists(): Promise<boolean> {
  const [r] = await db.$queryRaw<{ c: boolean }[]>`SELECT EXISTS (SELECT 1 FROM "FactRevenueGeo") OR EXISTS (SELECT 1 FROM "FactTraffic") c`;
  return r.c;
}
