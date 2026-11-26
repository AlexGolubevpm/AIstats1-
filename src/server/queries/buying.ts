// «Окупаемость закупки» (/buying, ADR 0023): one tree — site → tier → format — with what each
// earned (ADOK revenue), what the tier's traffic cost, and the CPM, over a period.
// Revenue and impressions come from the site's slice: the cached answer of the filtered ADOK
// requests, or the estimate from the stored cuts (services/buying.ts). Cost belongs to the traffic of
// a tier, not to a format: a source with a CPM bid for the tier (BidRate) costs loads × bid / loads
// per visit; a source without one costs its revshare of what its traffic earned (ADR 0006).
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import * as m from "@/lib/metrics";
import { readBuyingFilters } from "@/server/ingest/adspyglass/filters";
import { estimateSlice, sliceKey, type SiteSlice } from "@/server/services/buying";
import { D } from "./common";

export interface BuyingFilter { /** site ids; null = every site */ siteIds: string[] | null; tiers: number[]; /** null = every format */ formats: string[] | null }
export interface FormatRow { format: string; revenue: number; imps: number; cpm: m.Num; exact: boolean }
export interface TierRow { tier: number; revenue: number; cost: number; imps: number; cpm: m.Num; exact: boolean; formats: FormatRow[] }
export interface SiteRow { id: string; domain: string; revenue: number; cost: number; imps: number; cpm: m.Num; exact: boolean; computedAt: string | null; notes: string[]; tiers: TierRow[] }

export async function buyingSites() {
  return db.site.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, domain: true }, orderBy: { domain: "asc" } });
}

export async function buyingTable(p: Period, f: BuyingFilter) {
  const [sites, sources, bids, filters] = await Promise.all([
    db.site.findMany({ where: { status: { not: "ARCHIVED" }, ...(f.siteIds ? { id: { in: f.siteIds } } : {}) }, select: { id: true, domain: true, adsgSiteId: true }, orderBy: { domain: "asc" } }),
    db.costSource.findMany({ orderBy: { title: "asc" } }),
    db.bidRate.findMany({ where: { validFrom: { lte: D(p.to) } }, orderBy: { validFrom: "desc" } }),
    readBuyingFilters(db),
  ]);
  const cached = new Map((await db.buyingSlice.findMany({ where: { key: { in: sites.map((s) => sliceKey({ siteId: s.id, from: p.from, to: p.to })) } } })).map((r) => [r.siteId, r.data as unknown as SiteSlice]));
  const share = new Map(sources.map((x) => [x.slug, Number(x.revShare)]));
  // the bid in force at the end of the period: the site's own first, then the one for all sites
  const bidOf = (siteId: string, slug: string, tier: number) => bids.find((b) => b.sourceSlug === slug && b.tier === tier && b.siteId === siteId) ?? bids.find((b) => b.sourceSlug === slug && b.tier === tier && b.siteId == null);
  const costOf = (siteId: string, tier: number, x: { slug: string; loads: number; revenue: number }) => {
    const b = bidOf(siteId, x.slug, tier);
    return b ? (x.loads / 1000) * (m.bidCostPer1kLoads(Number(b.cpm), Number(b.loadsPerVisit)) ?? 0) : x.revenue * (share.get(x.slug) ?? 0);
  };
  const rows: SiteRow[] = [];
  for (const s of sites) {
    const slice = cached.get(s.id) ?? (await estimateSlice(db, { siteId: s.id, from: p.from, to: p.to }));
    const tiers: TierRow[] = slice.tiers.filter((t) => f.tiers.includes(t.tier)).map((t) => {
      const formats = t.formats.filter((x) => !f.formats || f.formats.includes(x.format)).filter((x) => x.revenue > 0 || x.imps > 0)
        .map((x) => ({ format: x.format, revenue: x.revenue, imps: x.imps, cpm: m.cpm(x.revenue, x.imps), exact: x.exact })).sort((a, b) => b.revenue - a.revenue);
      // every format: the tier's own total (the country cut); a choice of formats: their sum
      const revenue = f.formats ? formats.reduce((a, x) => a + x.revenue, 0) : t.revenue, imps = f.formats ? formats.reduce((a, x) => a + x.imps, 0) : t.imps;
      return { tier: t.tier, revenue, imps, cost: t.sources.reduce((a, x) => a + costOf(s.id, t.tier, x), 0), cpm: m.cpm(revenue, imps),
        exact: t.sourcesExact && formats.every((x) => x.exact), formats };
    }).filter((t) => t.revenue > 0 || t.cost > 0);
    if (!tiers.length) continue;
    const revenue = tiers.reduce((a, t) => a + t.revenue, 0), imps = tiers.reduce((a, t) => a + t.imps, 0);
    rows.push({ id: s.id, domain: s.domain, revenue, imps, cost: tiers.reduce((a, t) => a + t.cost, 0), cpm: m.cpm(revenue, imps), exact: tiers.every((t) => t.exact),
      computedAt: cached.get(s.id)?.computedAt ?? null, notes: cached.get(s.id)?.notes ?? [], tiers });
  }
  rows.sort((a, b) => b.revenue - a.revenue);
  const total = { revenue: rows.reduce((a, r) => a + r.revenue, 0), cost: rows.reduce((a, r) => a + r.cost, 0), imps: rows.reduce((a, r) => a + r.imps, 0) };
  const title = new Map(sources.map((x) => [x.slug, x.title]));
  const domain = new Map(sites.map((x) => [x.id, x.domain]));
  return {
    rows, total: { ...total, cpm: m.cpm(total.revenue, total.imps) },
    computed: { done: sites.filter((s) => cached.has(s.id)).length, of: sites.filter((s) => s.adsgSiteId != null).length },
    allSources: sources.map((x) => ({ slug: x.slug, title: x.title })),
    bids: bids.filter((b) => !f.siteIds || b.siteId == null || f.siteIds.includes(b.siteId)).map((b) => ({ id: b.id, source: title.get(b.sourceSlug) ?? b.sourceSlug, sourceSlug: b.sourceSlug, tier: b.tier,
      cpm: Number(b.cpm), loadsPerVisit: Number(b.loadsPerVisit), validFrom: b.validFrom.toISOString().slice(0, 10), site: b.siteId ? domain.get(b.siteId) ?? "другой сайт" : null })),
    filters,
  };
}
