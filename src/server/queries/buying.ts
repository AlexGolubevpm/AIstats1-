// «Окупаемость закупки» (/buying, ADR 0023): for a site, formats and tiers — what the bought traffic
// earns per 1000 loads, what it costs per 1000 loads, and whether the bid may go up.
// The slice (loads and revenue of each traffic source in each tier, for the chosen formats) is the
// cached answer of the filtered ADOK requests, or an estimate from the stored cuts (services/buying.ts).
// Cost: the source's CPM bid for the tier (BidRate) — bid / loads per visit; a source without a bid
// costs its revshare of what its traffic earned (ADR 0006); revshare 0 is free traffic.
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import * as m from "@/lib/metrics";
import { readBuyingFilters } from "@/server/ingest/adspyglass/filters";
import { cachedSlice, estimateSlice, normSel, type SliceSel } from "@/server/services/buying";
import { D } from "./common";

export interface BuyingSel { formats: string[] | null; tiers: number[]; /** a source slug, or "paid" — every source that costs money */ source: string; margin: number }
export interface TierRow {
  tier: number; exact: boolean; loads: number; revenue: number; revenueAll: number; cost: number;
  revPer1k: m.Num; costPer1k: m.Num; marginPer1k: m.Num; maxBid: m.Num; headroom: m.Num; verdict: m.BidVerdict;
  /** the bid of the single chosen source, $ per 1000 visits, and the limit in the same unit */ bid: number | null; maxCpm: number | null;
  /** how the cost was taken */ costKind: "bid" | "revshare" | "mixed" | "free";
  /** the formats' revenue of all traffic in the tier per 1000 Metrika users; null without Metrika */ revPer1kUsers: m.Num;
}

export async function buyingSites() {
  return db.site.findMany({ where: { status: { not: "ARCHIVED" } }, select: { id: true, domain: true }, orderBy: { domain: "asc" } });
}

export async function buyingView(siteId: string, p: Period, sel: BuyingSel) {
  const s: SliceSel = normSel({ siteId, from: p.from, to: p.to, formats: sel.formats, tiers: sel.tiers });
  const [cached, sources, bids, filters, uniq] = await Promise.all([
    cachedSlice(db, s),
    db.costSource.findMany({ orderBy: { title: "asc" } }),
    db.bidRate.findMany({ where: { validFrom: { lte: D(p.to) }, OR: [{ siteId }, { siteId: null }] }, orderBy: { validFrom: "desc" } }),
    readBuyingFilters(db),
    db.$queryRaw<{ tier: number; uniques: number }[]>`
      SELECT c.tier::int tier, SUM(g.uniques)::float8 uniques FROM v_site_geo_daily g JOIN "Country" c ON c.code = g.country_code
      WHERE g.site_id = ${siteId} AND g.date BETWEEN ${D(p.from)} AND ${D(p.to)} GROUP BY 1`,
  ]);
  const slice = cached ?? (await estimateSlice(db, s));
  const src = new Map(sources.map((x) => [x.slug, x]));
  // the bid in force at the end of the period: the site's own first, then the one for all sites
  const bidOf = (slug: string, tier: number) => bids.find((b) => b.sourceSlug === slug && b.tier === tier && b.siteId === siteId) ?? bids.find((b) => b.sourceSlug === slug && b.tier === tier && b.siteId == null) ?? null;
  const costOf = (slug: string, tier: number, x: { loads: number; revenueAll: number }): { cost: number; kind: "bid" | "revshare" | "free" } => {
    const b = bidOf(slug, tier);
    if (b) return { cost: (x.loads / 1000) * (m.bidCostPer1kLoads(Number(b.cpm), Number(b.loadsPerVisit)) ?? 0), kind: "bid" };
    const share = Number(src.get(slug)?.revShare ?? 0);
    return share > 0 ? { cost: x.revenueAll * share, kind: "revshare" } : { cost: 0, kind: "free" };
  };
  const paid = (slug: string) => Number(src.get(slug)?.revShare ?? 0) > 0 || s.tiers.some((t) => bidOf(slug, t));
  const chosen = (slug: string) => (sel.source === "paid" ? paid(slug) : slug === sel.source);
  const uniques = new Map(uniq.map((u) => [u.tier, Number(u.uniques ?? 0)]));

  const tiers: TierRow[] = slice.tiers.map((t) => {
    const rows = t.sources.filter((x) => chosen(x.slug)).map((x) => ({ ...x, ...costOf(x.slug, t.tier, x) }));
    const sum = (k: "loads" | "revenueFmt" | "revenueAll" | "cost") => rows.reduce((a, x) => a + x[k], 0);
    const a = m.bidAdvice({ popRevenue: sum("revenueFmt"), allRevenue: sum("revenueAll"), loads: sum("loads"), cost: sum("cost"), paidLoads: sum("loads") }, sel.margin);
    const kinds = new Set(rows.filter((x) => x.loads > 0).map((x) => x.kind));
    const b = sel.source !== "paid" ? bidOf(sel.source, t.tier) : null;
    const u = uniques.get(t.tier) ?? 0;
    return { tier: t.tier, exact: t.exact, loads: sum("loads"), revenue: sum("revenueFmt"), revenueAll: sum("revenueAll"), cost: sum("cost"),
      revPer1k: a.popPer1k, costPer1k: a.costPer1k, marginPer1k: a.popMarginPer1k, maxBid: a.maxBid, headroom: a.headroom, verdict: a.verdict,
      bid: b ? Number(b.cpm) : null, maxCpm: b && a.maxBid != null ? a.maxBid * Number(b.loadsPerVisit) : null,
      costKind: kinds.size > 1 ? "mixed" : ([...kinds][0] ?? "free"),
      revPer1kUsers: u > 0 ? (t.sources.reduce((acc, x) => acc + x.revenueFmt, 0) / u) * 1000 : null };
  });
  const total = tiers.reduce((a, t) => ({ popRevenue: a.popRevenue + t.revenue, allRevenue: a.allRevenue + t.revenueAll, loads: a.loads + t.loads, cost: a.cost + t.cost, paidLoads: a.paidLoads + t.loads }),
    { popRevenue: 0, allRevenue: 0, loads: 0, cost: 0, paidLoads: 0 });
  const advice = m.bidAdvice(total, sel.margin);
  const names = new Map((await db.country.findMany({ where: { code: { in: slice.countries.map((c) => c.cc) } }, select: { code: true, nameRu: true } })).map((c) => [c.code, c.nameRu]));
  // sources seen in the slice, for the picker
  const seen = new Map<string, { slug: string; title: string; loads: number; paid: boolean }>();
  for (const t of slice.tiers) for (const x of t.sources) {
    const cur = seen.get(x.slug) ?? { slug: x.slug, title: x.title, loads: 0, paid: paid(x.slug) };
    cur.loads += x.loads; seen.set(x.slug, cur);
  }
  return {
    sel: s, slice: { exact: slice.exact, fmtExact: slice.fmtExact, notes: slice.notes, requests: slice.requests, computedAt: slice.computedAt, cached: Boolean(cached) },
    tiers, total, advice,
    countries: slice.countries.map((c) => ({ country: c.cc, name: names.get(c.cc) ?? c.cc, tier: c.tier, loads: c.loads, revenue: c.revenueFmt, revenueAll: c.revenueAll,
      revPer1k: m.revPer1kLoads(c.revenueFmt, c.loads), allPer1k: m.revPer1kLoads(c.revenueAll, c.loads) })).sort((a, b) => b.loads - a.loads),
    sourceOptions: [...seen.values()].sort((a, b) => b.loads - a.loads),
    allSources: sources.map((x) => ({ slug: x.slug, title: x.title })),
    bids: bids.map((b) => ({ id: b.id, source: src.get(b.sourceSlug)?.title ?? b.sourceSlug, sourceSlug: b.sourceSlug, tier: b.tier, cpm: Number(b.cpm), loadsPerVisit: Number(b.loadsPerVisit),
      validFrom: b.validFrom.toISOString().slice(0, 10), allSites: b.siteId == null })),
    filters,
  };
}
