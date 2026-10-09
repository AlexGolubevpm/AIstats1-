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
  return s.siteIds.length ? Prisma.sql`${col} IN (SELECT id FROM "Site" WHERE id IN (${Prisma.join(s.siteIds)}) AND status <> 'ARCHIVED')` : Prisma.sql`false`;
}

// ---------- tables by entity ----------

export async function bundlesTable(p: Period) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT b.id, b.slug, b.title, b.color, (SELECT count(*) FROM "BundleSite" x JOIN "Site" s ON s.id = x."siteId" AND s.status <> 'ARCHIVED' WHERE x."bundleId" = b.id)::int sites,
      COALESCE(SUM(v.revenue), 0)::float8 revenue, COALESCE(SUM(v.cost), 0)::float8 cost, COALESCE(SUM(v.uniques), 0)::float8 uniques,
      COALESCE(SUM(v.pageviews), 0)::float8 pageviews,
      (SELECT COALESCE(SUM(g.revenue), 0) FROM v_site_geo_daily g JOIN "BundleSite" x ON x."siteId" = g.site_id AND x."bundleId" = b.id
        WHERE g.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`g.site_id`, {})}
          AND EXISTS (SELECT 1 FROM "FactTraffic" t WHERE t."siteId" = g.site_id AND t.date = g.date AND t.uniques > 0))::float8 revenue_tracked
    FROM "Bundle" b LEFT JOIN v_bundle_daily v ON v.bundle_id = b.id AND v.date BETWEEN ${D(p.from)} AND ${D(p.to)}
    GROUP BY b.id ORDER BY revenue DESC`;
  return rows.map((r) => ({
    id: String(r.id), slug: String(r.slug), title: String(r.title), color: String(r.color), sites: n(r.sites),
    revenue: n(r.revenue), cost: n(r.cost), margin: n(r.revenue) - n(r.cost), romi: m.romi(n(r.revenue), n(r.cost)),
    uniques: n(r.uniques), rpm: m.rpm(n(r.revenue_tracked), n(r.uniques)), // RPM only over site-days Metrika counted, else a site without Metrika inflates it
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
    SELECT format, SUM(page_loads)::float8 loads, SUM(imps_own)::float8 imps, SUM(views)::float8 views, SUM(clicks)::float8 clicks, SUM(revenue)::float8 revenue,
           SUM(requests)::float8 requests,
           CASE WHEN SUM(page_loads) FILTER (WHERE fill_rate_asg IS NOT NULL) > 0 THEN SUM(fill_rate_asg * page_loads) / SUM(page_loads) FILTER (WHERE fill_rate_asg IS NOT NULL) END::float8 fill_asg,
           bool_or(from_format_cut) from_cut
    FROM v_format_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`site_id`, s)}
    GROUP BY format ORDER BY revenue DESC`;
  const total = rows.reduce((a, r) => a + n(r.revenue), 0);
  return rows.map((r) => {
    const loads = n(r.loads), imps = n(r.imps), views = n(r.views), revenue = n(r.revenue), banner = r.format === "BANNER" || r.format === "NATIVE";
    return { format: String(r.format), requests: r.requests == null ? null : n(r.requests), pageLoads: loads, imps, views: banner ? views : null,
      fillRate: m.fillRate(imps, loads), fillRateAsg: r.fill_asg == null ? null : n(r.fill_asg), ctr: m.ctr(n(r.clicks), imps), cpm: m.cpm(revenue, imps),
      viewRate: banner ? m.viewRate(views, imps) : null, viewableCpm: banner ? m.viewableCpm(revenue, views) : null, revenue, share: m.share(revenue, total),
      /** false — the period has only zone sums for the format (no ad_type cut yet): loads are zone loads, not the format's. */
      fromFormatCut: Boolean(r.from_cut) };
  });
}

export interface GeoRow {
  country: string; name: string; tier: number | null; sites: number; uniques: number; pageLoads: number; revenue: number; cost: number; margin: number;
  romi: number | null; revPer1k: number | null; costPerUnique: number | null;
  /** Part of the cost is the site's no-country source cost allocated to this country (v_site_geo_alloc_daily, ADR 0015). */
  estimated: boolean;
  [k: string]: unknown;
}

/**
 * Countries over the scope. No-country money is spread **per site** (a site's source cost lands on
 * that site's countries, not on another site's), then the countries are rolled up.
 */
export async function geoTable(p: Period, s: Scope = {}, top = 20): Promise<GeoRow[]> {
  // v_site_geo_alloc_daily already carries the no-country cost on the countries (per site and day); ZZ stays
  // only with the money of days that have no country cut and is shown as «Без страны» without ROMI.
  const rows = await db.$queryRaw<Raw[]>`
    SELECT g.country_code cc, c."nameRu" name, c.tier, COUNT(DISTINCT g.site_id)::int sites,
      SUM(g.uniques)::float8 uniques, SUM(g.page_loads)::float8 loads, SUM(g.revenue)::float8 revenue, SUM(g.cost)::float8 cost, SUM(g.cost_own)::float8 raw_cost,
      SUM(g.uniques_bought)::float8 bought, BOOL_OR(g.estimated) estimated
    FROM v_site_geo_alloc_daily g LEFT JOIN "Country" c ON c.code = g.country_code
    WHERE g.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`g.site_id`, s)}
    GROUP BY 1, 2, 3`;
  const mapped: GeoRow[] = rows
    .map((r) => {
      const country = String(r.cc), revenue = n(r.revenue), cost = n(r.cost), rawCost = n(r.raw_cost), estimated = Boolean(r.estimated);
      return { country, name: country === "ZZ" ? "Без страны" : String(r.name ?? country), tier: n(r.tier) || null, sites: n(r.sites), uniques: n(r.uniques), pageLoads: n(r.loads),
        revenue, cost, margin: revenue - cost, romi: m.romi(revenue, cost), revPer1k: m.revPer1kLoads(revenue, n(r.loads)),
        // per bought unique only from cost that was really booked to the country; an allocated share has no uniques behind it
        costPerUnique: estimated && cost !== rawCost ? null : m.costPerUnique(rawCost, n(r.bought)), estimated };
    })
    .filter((r) => r.country !== "ZZ" || r.revenue !== 0 || r.cost !== 0 || r.pageLoads > 0 || r.uniques > 0)
    .map((r) => (r.country === "ZZ" ? { ...r, romi: null, revPer1k: null } : r))
    .sort((a, b) => (a.country === "ZZ" ? 1 : b.country === "ZZ" ? -1 : b.pageLoads - a.pageLoads));
  if (!top || mapped.length <= top) return mapped;
  const rest = mapped.slice(top);
  const sum = (k: "uniques" | "pageLoads" | "revenue" | "cost") => rest.reduce((a, r) => a + r[k], 0);
  const other: GeoRow = { country: "", name: `Прочие (${rest.length})`, tier: null, sites: 0, uniques: sum("uniques"), pageLoads: sum("pageLoads"),
    revenue: sum("revenue"), cost: sum("cost"), margin: sum("revenue") - sum("cost"), romi: m.romi(sum("revenue"), sum("cost")),
    revPer1k: m.revPer1kLoads(sum("revenue"), sum("pageLoads")), costPerUnique: null, estimated: rest.some((r) => r.estimated) };
  return [...mapped.slice(0, top), other];
}

/**
 * Networks with volume share, price rank (by rev/1000 loads), discrepancy and the floor
 * recommendation: 60th percentile of rev/1000 loads over the two best sources (14 days).
 */
export async function networksTable(p: Period, s: Scope = {}, countryCode?: string | null) {
  const cf = countryCode ? Prisma.sql`AND country_code = ${countryCode}` : Prisma.empty;
  const rows = await db.$queryRaw<Raw[]>`
    SELECT n.network_slug slug, n.network_title title, nw.color, nw."isSystem" OR nw.kind = 'DIRECT' AS excluded,
      SUM(n.page_loads)::float8 loads, SUM(n.imps_own)::float8 imps, SUM(n.imps_network)::float8 imps_net, SUM(n.clicks)::float8 clicks, SUM(n.revenue)::float8 revenue
    FROM v_network_geo n JOIN "Network" nw ON nw.id = n.network_id
    WHERE n.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`n.site_id`, s)} ${cf}
    GROUP BY 1, 2, 3, 4`;
  const totalLoads = rows.reduce((a, r) => a + n(r.loads), 0);
  const withPrice = rows.map((r) => {
    const loads = n(r.loads), imps = n(r.imps), revenue = n(r.revenue);
    return { slug: String(r.slug), network: String(r.title), color: String(r.color), pageLoads: loads, volShare: m.share(loads, totalLoads),
      fillRate: m.fillRate(imps, loads), revPer1k: m.revPer1kLoads(revenue, loads), discrepancy: m.discrepancy(imps, n(r.imps_net)), ctr: m.ctr(n(r.clicks), imps), revenue,
      impsOwn: imps, impsNetwork: n(r.imps_net), excluded: Boolean(r.excluded) };
  }).sort((a, b) => (b.revPer1k ?? -1) - (a.revPer1k ?? -1));
  // The floor comes from real mediated networks with a real share (≥ 5% of loads): own deals, the
  // "all networks" fallback row and a network with a handful of loads must not set the bar.
  const eligible = withPrice.filter((x) => !x.excluded && (x.volShare ?? 0) >= 0.05 && x.revPer1k != null);
  const best = eligible.slice(0, 2).map((x) => x.revPer1k ?? 0).sort((a, b) => a - b);
  const floor = best.length === 2 ? best[0] + (best[1] - best[0]) * 0.6 : best[0] ?? null;
  const topTwo = new Set(eligible.slice(0, 2).map((x) => x.slug));
  return withPrice.map((x, i) => ({ ...x, rank: i + 1, belowFloor: floor != null && x.revPer1k != null && !x.excluded && !topTwo.has(x.slug) && x.revPer1k < floor * 0.999,
    inverted: i + 1 > 3 && (x.volShare ?? 0) > 0.3 })).map(({ excluded: _e, ...x }) => ({ ...x, floor }));
}

/** Thresholds of alert №5 «мёртвая зона» (src/server/domain/alerts/rules.ts): the badge on the site page uses the same ones. */
export const DEAD_ZONE = { minImps: 50_000, maxRevShare: 0.01, minImpShare: 0.05 } as const;

export async function zonesTable(p: Period, siteId: string) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT z.zone_id id, z.zone_name name, z.format, z.position, SUM(z.imps_own)::float8 imps, SUM(z.views)::float8 views, SUM(z.clicks)::float8 clicks, SUM(z.revenue)::float8 revenue
    FROM v_zone_daily z WHERE z.site_id = ${siteId} AND z.date BETWEEN ${D(p.from)} AND ${D(p.to)}
    GROUP BY 1, 2, 3, 4 ORDER BY revenue DESC`;
  const total = rows.reduce((a, r) => a + n(r.revenue), 0);
  // Per format: CPM is only comparable within a format (docs 06), so «кандидат на снос» is judged against the site's
  // zones of the same format with the thresholds of alert №5 — under 1% of their revenue while holding over 5% of
  // their impressions, ≥ 50 000 impressions, more than one zone of the format.
  const byFormat = new Map<string, { revenue: number; imps: number; zones: number }>();
  for (const r of rows) {
    const f = byFormat.get(String(r.format)) ?? { revenue: 0, imps: 0, zones: 0 };
    f.revenue += n(r.revenue); f.imps += n(r.imps); f.zones += 1; byFormat.set(String(r.format), f);
  }
  return rows.map((r) => {
    const imps = n(r.imps), views = n(r.views), revenue = n(r.revenue), banner = r.format === "BANNER" || r.format === "NATIVE";
    const viewRate = banner ? m.viewRate(views, imps) : null, share = m.share(revenue, total);
    const fmt = byFormat.get(String(r.format))!;
    const formatShare = m.share(revenue, fmt.revenue), formatImpShare = m.share(imps, fmt.imps);
    const candidateRemove = fmt.zones > 1 && imps >= DEAD_ZONE.minImps && formatShare != null && formatShare < DEAD_ZONE.maxRevShare && formatImpShare != null && formatImpShare > DEAD_ZONE.minImpShare;
    return { id: String(r.id), zone: String(r.name), format: String(r.format), position: r.position ? String(r.position) : null, imps, views: banner ? views : null,
      viewRate, ctr: m.ctr(n(r.clicks), imps), cpm: m.cpm(revenue, imps), viewableCpm: banner ? m.viewableCpm(revenue, views) : null, revenue, share, formatShare,
      candidateRemove, invisible: viewRate != null && viewRate < 0.15 };
  });
}

export async function devicesTable(p: Period, siteId: string) {
  const [traffic, revenue] = await Promise.all([
    db.$queryRaw<Raw[]>`SELECT device::text device, SUM(uniques)::float8 uniques FROM "FactTraffic" WHERE "siteId" = ${siteId} AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1`,
    // Device cut where ADOK sent one for the site-day; the geo fact (device UNKNOWN or demo devices) otherwise.
    db.$queryRaw<Raw[]>`SELECT device, SUM(imps)::float8 imps, SUM(clicks)::float8 clicks, SUM(revenue)::float8 revenue FROM (
        SELECT device::text device, "impsOwn" imps, clicks, "revenueReported" revenue FROM "FactRevenueDevice"
        WHERE "siteId" = ${siteId} AND date BETWEEN ${D(p.from)} AND ${D(p.to)}
        UNION ALL
        SELECT g.device::text, g."impsOwn", g.clicks, g."revenueReported" FROM "FactRevenueGeo" g
        WHERE g."siteId" = ${siteId} AND g.date BETWEEN ${D(p.from)} AND ${D(p.to)}
          AND NOT EXISTS (SELECT 1 FROM "FactRevenueDevice" x WHERE x."siteId" = g."siteId" AND x.date = g.date)
      ) u GROUP BY 1`,
  ]);
  const devices = new Set([...traffic, ...revenue].map((r) => String(r.device)));
  const total = revenue.reduce((a, r) => a + n(r.revenue), 0);
  return [...devices].map((d) => {
    const t = traffic.find((r) => r.device === d), rv = revenue.find((r) => r.device === d);
    const imps = n(rv?.imps), rev = n(rv?.revenue);
    return { device: d, uniques: n(t?.uniques), imps, ctr: m.ctr(n(rv?.clicks), imps), cpm: m.cpm(rev, imps), revenue: rev, share: m.share(rev, total) };
  }).sort((a, b) => b.revenue - a.revenue);
}

/** ADOK traffic sources of a site: volume and what was paid to each (ADOK labels that sum "revenue"). */
export async function sourcesTable(p: Period, siteId: string) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT s.title source, s."revShare"::float8 share_paid, SUM(f."pageLoads")::float8 loads, SUM(f."impsOwn")::float8 imps, SUM(f."revenueReported")::float8 revenue,
           COALESCE((SELECT SUM(c.cost) FROM "FactCost" c WHERE c."siteId" = f."siteId" AND c."sourceSlug" = f."sourceSlug" AND c.date BETWEEN ${D(p.from)} AND ${D(p.to)}), 0)::float8 cost
    FROM "FactTrafficSource" f JOIN "CostSource" s ON s.slug = f."sourceSlug"
    WHERE f."siteId" = ${siteId} AND f.date BETWEEN ${D(p.from)} AND ${D(p.to)}
    GROUP BY f."siteId", f."sourceSlug", s.title, s."revShare"`;
  const costTotal = rows.reduce((a, r) => a + n(r.cost), 0), loadsTotal = rows.reduce((a, r) => a + n(r.loads), 0);
  return rows.map((r) => {
    const reported = n(r.revenue), cost = n(r.cost), loads = n(r.loads);
    return { source: String(r.source), loads, loadsShare: m.share(loads, loadsTotal), reported, cost,
      costPer1k: m.revPer1kLoads(cost, loads), revShare: n(r.share_paid), share: m.share(cost, costTotal) };
  }).sort((a, b) => b.loads - a.loads);
}

/**
 * Geo rows for one site with the site's networks nested under each country. ADOK has no
 * network × country cut (real network rows sit in ZZ), so the nested table is the site's
 * networks when the country itself has none — the page says so.
 */
export async function siteGeoWithNetworks(p: Period, siteId: string) {
  const geo = await geoTable(p, { siteIds: [siteId] }, 0);
  const nets = await db.$queryRaw<Raw[]>`
    SELECT country_code cc, network_title title, SUM(page_loads)::float8 loads, SUM(imps_own)::float8 imps, SUM(imps_network)::float8 imps_net, SUM(revenue)::float8 revenue
    FROM v_network_geo WHERE site_id = ${siteId} AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1, 2`;
  const siteWide = nets.filter((r) => r.cc === "ZZ");
  return geo.map((g) => {
    const own = nets.filter((r) => r.cc === g.country);
    const mine = own.length ? own : siteWide;
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
    // The zone cut has no direct deals: add them as their own series so the chart shows all the revenue cost is compared with.
    rows = await db.$queryRaw<Raw[]>`SELECT date, format k, SUM(revenue)::float8 v FROM v_format_daily
      WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`site_id`, s)} GROUP BY 1, 2
      UNION ALL
      SELECT date, 'Фикс-дилы' k, SUM(revenue)::float8 v FROM v_deal_daily
      WHERE billed_via = 'DIRECT' AND date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`site_id`, s)} GROUP BY 1, 2`;
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

/** Stacked daily cost: traffic cost by source (FactCost) plus operating expenses by day (v_opex_daily). */
export async function costSplitDaily(p: Period, s: Scope = {}) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT c.date, COALESCE(cs.title, c."sourceSlug") k, SUM(c.cost)::float8 v FROM "FactCost" c LEFT JOIN "CostSource" cs ON cs.slug = c."sourceSlug"
    WHERE c.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND ${siteFilter(Prisma.sql`c."siteId"`, s)} GROUP BY 1, 2
    UNION ALL
    SELECT o.date, 'Опер. расходы' k, SUM(o.amount)::float8 v FROM v_opex_daily o
    WHERE o.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND (o.site_id IS NULL OR ${siteFilter(Prisma.sql`o.site_id`, s)}) GROUP BY 1, 2`;
  return rows.map((r) => ({ date: iso(r.date as Date), key: String(r.k), value: n(r.v) }));
}

/** Operating expenses per day in the period (all entries). */
export async function opexDaily(p: Period): Promise<Map<string, number>> {
  const rows = await db.$queryRaw<Raw[]>`SELECT date, SUM(amount)::float8 v FROM v_opex_daily WHERE date BETWEEN ${D(p.from)} AND ${D(p.to)} AND (site_id IS NULL OR site_id IN (SELECT id FROM "Site" WHERE status <> 'ARCHIVED')) GROUP BY 1`;
  return new Map(rows.map((r) => [iso(r.date as Date), n(r.v)]));
}

/** Site × country ROMI for the top countries by cost (geo page matrix). Cost per country from v_site_geo_alloc_daily (ADR 0015). */
export async function geoMatrix(p: Period, top = 12) {
  // Same allocation as geoTable and the loss-geo alert (ADR 0015); only real countries make cells.
  const rows = await db.$queryRaw<Raw[]>`
    SELECT s.domain, g.country_code cc, SUM(g.revenue)::float8 revenue, SUM(g.cost)::float8 cost
    FROM v_site_geo_alloc_daily g JOIN "Site" s ON s.id = g.site_id
    WHERE g.date BETWEEN ${D(p.from)} AND ${D(p.to)} AND s.status <> 'ARCHIVED' AND g.country_code NOT IN ('ZZ', 'XX') GROUP BY 1, 2`;
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

/** Profile of the day: the site's loads, impressions and revenue by hour over the period (ADR 0016). Hours are UTC as ADOK reports them. */
export async function hoursTable(p: Period, siteId: string) {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT hour, SUM("pageLoads")::float8 loads, SUM("impsOwn")::float8 imps, SUM(clicks)::float8 clicks, SUM("revenueReported")::float8 revenue, COUNT(DISTINCT date)::int days
    FROM "FactRevenueHour" WHERE "siteId" = ${siteId} AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY hour ORDER BY hour`;
  const total = rows.reduce((a, r) => a + n(r.revenue), 0), totalLoads = rows.reduce((a, r) => a + n(r.loads), 0);
  return rows.map((r) => {
    const loads = n(r.loads), imps = n(r.imps), revenue = n(r.revenue), days = Math.max(1, n(r.days));
    return { hour: n(r.hour), label: `${String(n(r.hour)).padStart(2, "0")}:00`, pageLoads: loads, loadsPerDay: loads / days, imps, fillRate: m.fillRate(imps, loads), ctr: m.ctr(n(r.clicks), imps),
      revPer1k: m.revPer1kLoads(revenue, loads), revenue, revenuePerDay: revenue / days, share: m.share(revenue, total), loadsShare: m.share(loads, totalLoads), days };
  });
}

/** Platforms (OS) or browsers of a site over the period (ADR 0016). */
export async function techTable(p: Period, siteId: string, kind: "PLATFORM" | "BROWSER") {
  const rows = await db.$queryRaw<Raw[]>`
    SELECT name, SUM("pageLoads")::float8 loads, SUM("impsOwn")::float8 imps, SUM(clicks)::float8 clicks, SUM("revenueReported")::float8 revenue
    FROM "FactRevenueTech" WHERE "siteId" = ${siteId} AND kind = ${kind}::"TechKind" AND date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY name ORDER BY revenue DESC`;
  const total = rows.reduce((a, r) => a + n(r.revenue), 0), totalLoads = rows.reduce((a, r) => a + n(r.loads), 0);
  return rows.map((r) => {
    const loads = n(r.loads), imps = n(r.imps), revenue = n(r.revenue);
    return { name: String(r.name), pageLoads: loads, loadsShare: m.share(loads, totalLoads), imps, fillRate: m.fillRate(imps, loads), ctr: m.ctr(n(r.clicks), imps),
      revPer1k: m.revPer1kLoads(revenue, loads), cpm: m.cpm(revenue, imps), revenue, share: m.share(revenue, total) };
  });
}
