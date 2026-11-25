// «Закупка T1/T2» (/buying, ADR 0023): popunder revenue on T1/T2 traffic against what T1/T2 traffic
// costs, by day, country and source. Exact where the filtered ADOK cuts are loaded
// (FactRevenueFormatGeo, FactTrafficSourceTier), otherwise estimated and marked:
//  - popunder T1/T2 revenue ≈ ADOK T1/T2 revenue × the popunder share of the site's format revenue that day;
//  - T1/T2 cost ≈ the source cost the geo view spreads over T1/T2 countries (v_site_geo_alloc_daily, ADR 0015),
//    paid loads ≈ paid sources' loads × the T1/T2 share of the site's loads.
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import * as m from "@/lib/metrics";
import { T12, T12_TIERS, readBuyingFilters } from "@/server/ingest/adspyglass/filters";
import { readPlan } from "@/server/ingest/adspyglass/plan";
import { D, iso } from "./common";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

export interface BuyingDay {
  date: string; loads: number; popRevenue: number; allRevenue: number; cost: number; paidLoads: number;
  /** popunder T1/T2 from the zone-filtered cut, not the format share */ popExact: boolean;
  /** cost and paid loads from the country-filtered source cut, not the geo spread */ costExact: boolean;
  popPer1k: m.Num; costPer1k: m.Num;
}
export interface BuyingCountry { country: string; name: string; tier: number; loads: number; popRevenue: number; allRevenue: number; popPer1k: m.Num; allPer1k: m.Num; exact: boolean }
export interface BuyingSource { slug: string; title: string; revShare: number; loads: number; cost: number; costPer1k: m.Num; share: m.Num }

export async function buyingSites() {
  return db.site.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, domain: true }, orderBy: { domain: "asc" } });
}

export async function buyingReport(siteId: string, p: Period, targetMargin = 0.2) {
  const site = { siteId, from: D(p.from), to: D(p.to) };
  const [geo, siteDay, fmt, popGeo, alloc, srcAll, srcT12, filters, plan] = await Promise.all([
    // T1/T2 loads and ADOK revenue by day and country (country cut)
    db.$queryRaw<Raw[]>`
      SELECT g.date, g.country_code cc, c."nameRu" name, c.tier, SUM(g.page_loads)::float8 loads, SUM(g.revenue_mediated)::float8 rev
      FROM v_site_geo_daily g JOIN "Country" c ON c.code = g.country_code
      WHERE g.site_id = ${site.siteId} AND g.date BETWEEN ${site.from} AND ${site.to} AND c.tier IN (${T12_TIERS[0]}, ${T12_TIERS[1]})
      GROUP BY g.date, g.country_code, c."nameRu", c.tier`,
    db.$queryRaw<Raw[]>`
      SELECT date, SUM(page_loads)::float8 loads FROM v_site_geo_daily WHERE site_id = ${site.siteId} AND date BETWEEN ${site.from} AND ${site.to} GROUP BY date`,
    // the popunder share of the site's format revenue (ad_type cut)
    db.$queryRaw<Raw[]>`
      SELECT date, SUM("revenueReported") FILTER (WHERE format = 'POPUNDER')::float8 pop, SUM("revenueReported")::float8 total
      FROM "FactRevenueFormat" WHERE "siteId" = ${site.siteId} AND date BETWEEN ${site.from} AND ${site.to} GROUP BY date`,
    db.$queryRaw<Raw[]>`
      SELECT f.date, f."countryCode" cc, SUM(f."revenueReported")::float8 rev
      FROM "FactRevenueFormatGeo" f JOIN "Country" c ON c.code = f."countryCode"
      WHERE f."siteId" = ${site.siteId} AND f.format = 'POPUNDER' AND f.date BETWEEN ${site.from} AND ${site.to} AND c.tier IN (${T12_TIERS[0]}, ${T12_TIERS[1]})
      GROUP BY f.date, f."countryCode"`,
    db.$queryRaw<Raw[]>`
      SELECT a.date, SUM(a.cost)::float8 cost FROM v_site_geo_alloc_daily a JOIN "Country" c ON c.code = a.country_code
      WHERE a.site_id = ${site.siteId} AND a.date BETWEEN ${site.from} AND ${site.to} AND c.tier IN (${T12_TIERS[0]}, ${T12_TIERS[1]}) GROUP BY a.date`,
    db.$queryRaw<Raw[]>`
      SELECT t.date, SUM(t."pageLoads") FILTER (WHERE s."revShare" > 0)::float8 paid FROM "FactTrafficSource" t JOIN "CostSource" s ON s.slug = t."sourceSlug"
      WHERE t."siteId" = ${site.siteId} AND t.date BETWEEN ${site.from} AND ${site.to} GROUP BY t.date`,
    db.$queryRaw<Raw[]>`
      SELECT t.date, t."sourceSlug" slug, s.title, s."revShare"::float8 share, SUM(t."pageLoads")::float8 loads, SUM(t."revenueReported" * s."revShare")::float8 cost
      FROM "FactTrafficSourceTier" t JOIN "CostSource" s ON s.slug = t."sourceSlug"
      WHERE t."siteId" = ${site.siteId} AND t."tierGroup" = ${T12} AND t.date BETWEEN ${site.from} AND ${site.to}
      GROUP BY t.date, t."sourceSlug", s.title, s."revShare"`,
    readBuyingFilters(db),
    readPlan(db),
  ]);

  const key = (r: Raw) => iso(r.date as Date);
  const byDay = <T>(rows: Raw[], f: (r: Raw) => T) => new Map(rows.map((r) => [key(r), f(r)]));
  const siteLoads = byDay(siteDay, (r) => n(r.loads));
  const fmtShare = byDay(fmt, (r) => (n(r.total) > 0 ? n(r.pop) / n(r.total) : null));
  const allocCost = byDay(alloc, (r) => n(r.cost));
  const paidAll = byDay(srcAll, (r) => n(r.paid));
  const popExact = new Map<string, number>(), popExactCc = new Map<string, number>();
  for (const r of popGeo) {
    popExact.set(key(r), (popExact.get(key(r)) ?? 0) + n(r.rev));
    popExactCc.set(`${key(r)}|${r.cc}`, n(r.rev));
  }
  const srcDay = new Map<string, { cost: number; paid: number }>();
  for (const r of srcT12) {
    const cur = srcDay.get(key(r)) ?? { cost: 0, paid: 0 };
    srcDay.set(key(r), { cost: cur.cost + n(r.cost), paid: cur.paid + (n(r.share) > 0 ? n(r.loads) : 0) });
  }

  // days
  const dayGeo = new Map<string, { loads: number; rev: number }>();
  for (const r of geo) {
    const cur = dayGeo.get(key(r)) ?? { loads: 0, rev: 0 };
    dayGeo.set(key(r), { loads: cur.loads + n(r.loads), rev: cur.rev + n(r.rev) });
  }
  const days: BuyingDay[] = [...dayGeo].sort(([a], [b]) => a.localeCompare(b)).map(([date, g]) => {
    const exactPop = popExact.has(date), exactCost = srcDay.has(date);
    const popRevenue = exactPop ? popExact.get(date)! : g.rev * (fmtShare.get(date) ?? 0);
    const t12Share = (siteLoads.get(date) ?? 0) > 0 ? g.loads / siteLoads.get(date)! : 0;
    const cost = exactCost ? srcDay.get(date)!.cost : allocCost.get(date) ?? 0;
    const paidLoads = exactCost ? srcDay.get(date)!.paid : (paidAll.get(date) ?? 0) * t12Share;
    return { date, loads: g.loads, popRevenue, allRevenue: g.rev, cost, paidLoads, popExact: exactPop, costExact: exactCost,
      popPer1k: m.revPer1kLoads(popRevenue, g.loads), costPer1k: paidLoads > 0 ? (cost / paidLoads) * 1000 : null };
  });
  const total = days.reduce((a, d) => ({ popRevenue: a.popRevenue + d.popRevenue, allRevenue: a.allRevenue + d.allRevenue, loads: a.loads + d.loads, cost: a.cost + d.cost, paidLoads: a.paidLoads + d.paidLoads }),
    { popRevenue: 0, allRevenue: 0, loads: 0, cost: 0, paidLoads: 0 });

  // countries
  const cc = new Map<string, BuyingCountry & { _exactDays: number; _days: number }>();
  for (const r of geo) {
    const code = String(r.cc), date = key(r);
    const exact = popExactCc.has(`${date}|${code}`) || popExact.has(date);
    const pop = popExact.has(date) ? popExactCc.get(`${date}|${code}`) ?? 0 : n(r.rev) * (fmtShare.get(date) ?? 0);
    const cur = cc.get(code) ?? { country: code, name: String(r.name ?? code), tier: n(r.tier), loads: 0, popRevenue: 0, allRevenue: 0, popPer1k: null, allPer1k: null, exact: true, _exactDays: 0, _days: 0 };
    cur.loads += n(r.loads); cur.popRevenue += pop; cur.allRevenue += n(r.rev); cur._days++; if (exact) cur._exactDays++;
    cc.set(code, cur);
  }
  const countries: BuyingCountry[] = [...cc.values()].map(({ _exactDays, _days, ...c }) => ({ ...c, exact: _exactDays === _days,
    popPer1k: m.revPer1kLoads(c.popRevenue, c.loads), allPer1k: m.revPer1kLoads(c.allRevenue, c.loads) })).sort((a, b) => b.loads - a.loads);

  // sources (exact cut only)
  const src = new Map<string, BuyingSource>();
  for (const r of srcT12) {
    const cur = src.get(String(r.slug)) ?? { slug: String(r.slug), title: String(r.title), revShare: n(r.share), loads: 0, cost: 0, costPer1k: null, share: null };
    cur.loads += n(r.loads); cur.cost += n(r.cost);
    src.set(cur.slug, cur);
  }
  const srcLoads = [...src.values()].reduce((a, s) => a + s.loads, 0);
  const sources = [...src.values()].map((s) => ({ ...s, costPer1k: s.revShare > 0 ? m.revPer1kLoads(s.cost, s.loads) : null, share: m.share(s.loads, srcLoads) })).sort((a, b) => b.loads - a.loads);

  return {
    days, countries, sources, total,
    advice: m.bidAdvice(total, targetMargin),
    elasticity: m.bidElasticity(days),
    exact: { pop: days.filter((d) => d.popExact).length, cost: days.filter((d) => d.costExact).length, days: days.length },
    filters, cutsOn: { pop: plan.cuts.popunder_geo, cost: plan.cuts.source_t12 },
  };
}
