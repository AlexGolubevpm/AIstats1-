// «Окупаемость закупки» (/buying, ADR 0023): the ADOK filters the report needs, the «formats × tiers»
// slice of a site's traffic sources, and the CPM bids of the sources.
//  - the check finds how ADOK names its zone and country filters (one site-day, the usual budget and pause);
//  - a slice is computed on request: per tier one traffic_source request filtered to the tier's countries
//    (loads and all revenue of each source's traffic there) and one more filtered to the formats' zones too;
//    whole period in one request; the answer is cached (BuyingSlice);
//  - without the filters the slice is estimated from the stored cuts and marked.
import Decimal from "decimal.js";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import type { Config } from "@/server/config";
import { RuleError } from "@/server/domain/errors";
import { AsgError, type AsgRow } from "@/server/ingest/adspyglass/client";
import {
  COUNTRY_CANDIDATES, SPOT_CANDIDATES, T12_TIERS, countryValues, formatScoped, popunderScoped, readBuyingFilters, saveBuyingFilters, spotValues, t12Revenue, t12Scoped,
  type BuyingFilters, type CountryFilter, type SpotFilter,
} from "@/server/ingest/adspyglass/filters";
import { allocateBroker, mapCountryRows, mapFormatRows, mapTrafficSourceRows, mapWebsiteRows, measures, type Measures } from "@/server/ingest/adspyglass/map";
import { loadResolver } from "@/server/ingest/adspyglass/ingest";
import { withAsg } from "@/server/ingest/probe";

export interface FilterTry { what: "popunder" | "t12" | "both"; param: string; kind: string; ok: boolean; why: string }
export interface FilterCheck { spots: SpotFilter | null; countries: CountryFilter | null; tried: FilterTry[]; day: string; site: string }

const label = (f: SpotFilter | CountryFilter) => `${f.param} (${f.kind === "zone_ids" ? "ID зон" : f.kind === "ad_type" ? "тип" : f.kind === "iso" ? "ISO" : "ID стран"})`;

/** Tries the filter candidates on (site, day); keeps the first that narrows the answer. */
export async function checkBuyingFilters(db: PrismaClient, cfg: Config, siteId: string, day: string, fetchImpl?: typeof fetch): Promise<FilterCheck> {
  const site = await db.site.findUniqueOrThrow({ where: { id: siteId } });
  if (!site.adsgSiteId) throw new RuleError("site", "У сайта не задан ID AdSpyglass", "site");
  const zones = await db.zone.findMany({ where: { siteId, format: "POPUNDER", isActive: true }, select: { adsgZoneId: true } });
  const t12 = new Set((await db.country.findMany({ where: { tier: { in: T12_TIERS } }, select: { code: true } })).map((c) => c.code));
  const res = await withAsg(db, cfg, async (c) => {
    const tried: FilterTry[] = [];
    const base = { from: day, to: day, websiteId: site.adsgSiteId! };
    const websiteRows = await c.report({ from: day, to: day, groupBy: "website" });
    const siteM = mapWebsiteRows(websiteRows).find((t) => t.adsgSiteId === site.adsgSiteId)?.m ?? null;
    const countryRows = await c.report({ ...base, groupBy: "country" });
    const fmt = mapFormatRows(await c.report({ ...base, groupBy: "ad_type" })).find((f) => f.format === "POPUNDER")?.m ?? null;
    const t12Loads = countryRows.filter((r) => typeof r.iso === "string" && t12.has(r.iso.trim().toUpperCase())).reduce((a, r) => a + measures(r).pageLoads, 0);

    /** One candidate request; a refused parameter is a failed try, a pause or the budget stops the check. */
    const attempt = async (groupBy: string, param: string, values: string[]): Promise<AsgRow[] | string> => {
      try { return await c.report({ ...base, groupBy, extra: { [param]: values } }); } catch (e) {
        if (e instanceof AsgError && (e.pausesQueue || e.kind === "budget")) throw e;
        return (e as Error).message;
      }
    };
    let spots: SpotFilter | null = null;
    for (const f of SPOT_CANDIDATES) {
      const values = spotValues(f, zones.map((z) => z.adsgZoneId));
      const rows = values.length ? await attempt("country", f.param, values) : "у сайта нет зон попсов";
      const v = typeof rows === "string" ? { ok: false, why: rows } : popunderScoped(rows, fmt, siteM);
      tried.push({ what: "popunder", param: f.param, kind: label(f), ...v });
      if (v.ok) { spots = f; break; }
    }
    let countries: CountryFilter | null = null;
    for (const f of COUNTRY_CANDIDATES) {
      const values = countryValues(f, countryRows, t12);
      const rows = values.length ? await attempt("traffic_source", f.param, values) : "ADOK не отдал ID стран";
      const v = typeof rows === "string" ? { ok: false, why: rows } : t12Scoped(rows, t12Loads, siteM?.pageLoads ?? null);
      tried.push({ what: "t12", param: f.param, kind: label(f), ...v });
      if (v.ok) { countries = f; break; }
    }
    if (spots && countries) {
      // both filters in one request: the formats of a source's traffic in a tier need them together
      const only = await attempt("traffic_source", countries.param, countryValues(countries, countryRows, t12));
      const both = await c.report({ ...base, groupBy: "traffic_source", extra: { [countries.param]: countryValues(countries, countryRows, t12), [spots.param]: spotValues(spots, zones.map((z) => z.adsgZoneId)) } })
        .catch((e: Error) => { if (e instanceof AsgError && (e.pausesQueue || e.kind === "budget")) throw e; return e.message; });
      const imps = (rows: AsgRow[]) => rows.reduce((a, r) => a + measures(r).impsOwn, 0);
      const v = typeof both === "string" || typeof only === "string" ? { ok: false, why: typeof both === "string" ? both : String(only) }
        : formatScoped(imps(both), imps(only), fmt && siteM && siteM.impsOwn > 0 ? fmt.impsOwn / siteM.impsOwn : null);
      tried.push({ what: "both", param: `${countries.param} + ${spots.param}`, kind: "вместе", ...v });
    }
    return { spots, countries, tried };
  }, fetchImpl);
  if (!res.ok) throw new RuleError("asg", res.error);
  const { spots, countries, tried } = res.value;
  const prev = await readBuyingFilters(db);
  const next: BuyingFilters = { spots: spots ?? undefined, countries: countries ?? undefined, checkedAt: new Date().toISOString(), site: site.domain, day };
  await saveBuyingFilters(db, next);
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: "asg_buying_filters", field: "filters",
    before: prev.checkedAt ? `${prev.spots?.param ?? "—"} · ${prev.countries?.param ?? "—"}` : null,
    after: `${spots ? label(spots) : "форматы: фильтр не найден"} · ${countries ? label(countries) : "тиры: фильтр не найден"}` } });
  return { spots, countries, tried, day, site: site.domain };
}

// ---------- the site slice: tiers × formats (revenue) and tiers × sources (cost) ----------

export const ALL_FORMATS = ["POPUNDER", "BANNER", "NATIVE", "SLIDER", "OUTSTREAM", "INVIDEO", "INPAGEPUSH", "OTHER"] as const;
export const TIER_LIST = [1, 2, 3, 4, 5];
export interface SliceKey { siteId: string; from: string; to: string }
export interface SliceTier {
  tier: number;
  /** the tier's ADOK revenue and own impressions from the stored country cut */ revenue: number; imps: number; loads: number;
  /** revenue and impressions of each format in the tier */ formats: { format: string; revenue: number; imps: number; exact: boolean }[];
  /** loads and revenue of each traffic source's traffic in the tier: what the cost is taken from */ sources: { slug: string; title: string; loads: number; revenue: number }[];
  /** the sources came from the country-filtered ADOK request, not from the site's average */ sourcesExact: boolean;
}
export interface SiteSlice { notes: string[]; requests: number; computedAt: string | null; tiers: SliceTier[] }

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const num = (v: unknown) => (v == null ? 0 : Number(v));
export const sliceKey = (s: SliceKey) => `${s.siteId}|${s.from}|${s.to}`;

/** What the stored cuts know about the site over the period. */
async function stored(db: PrismaClient, s: SliceKey) {
  type Raw = Record<string, unknown>;
  const [geo, fmt, src, sources] = await Promise.all([
    db.$queryRaw<Raw[]>`
      SELECT g.country_code cc, COALESCE(c.tier, 0)::int tier, SUM(g.page_loads)::float8 loads, SUM(g.revenue_mediated)::float8 rev, SUM(g.imps_own)::float8 imps
      FROM v_site_geo_daily g LEFT JOIN "Country" c ON c.code = g.country_code
      WHERE g.site_id = ${s.siteId} AND g.date BETWEEN ${D(s.from)} AND ${D(s.to)} GROUP BY 1, 2`,
    // v_format_daily: the ad_type cut, or the zone sums for days without it
    db.$queryRaw<Raw[]>`
      SELECT format::text, SUM(revenue)::float8 rev, SUM(imps_own)::float8 imps
      FROM v_format_daily WHERE site_id = ${s.siteId} AND date BETWEEN ${D(s.from)} AND ${D(s.to)} GROUP BY 1`,
    db.$queryRaw<Raw[]>`
      SELECT "sourceSlug" slug, SUM("pageLoads")::float8 loads, SUM("revenueReported")::float8 rev, SUM("predictedIncome")::float8 predicted, SUM("impsOwn")::float8 imps
      FROM "FactTrafficSource" WHERE "siteId" = ${s.siteId} AND date BETWEEN ${D(s.from)} AND ${D(s.to)} GROUP BY 1`,
    db.costSource.findMany(),
  ]);
  const g = geo.map((r) => ({ cc: String(r.cc), tier: num(r.tier), loads: num(r.loads), rev: num(r.rev), imps: num(r.imps) }));
  const f = fmt.map((r) => ({ format: String(r.format), rev: num(r.rev), imps: num(r.imps) })).filter((x) => x.rev > 0 || x.imps > 0);
  const sum = <T,>(xs: T[], k: (x: T) => number) => xs.reduce((a, x) => a + k(x), 0);
  return {
    geo: g, fmt: f, sources,
    siteLoads: sum(g, (x) => x.loads), siteRev: sum(g, (x) => x.rev), fmtRev: sum(f, (x) => x.rev), fmtImps: sum(f, (x) => x.imps),
    src: src.map((r) => ({ slug: String(r.slug), loads: num(r.loads), rev: num(r.rev), predicted: num(r.predicted), imps: num(r.imps) })),
    tier: (t: number) => { const xs = g.filter((x) => x.tier === t); return { loads: sum(xs, (x) => x.loads), rev: sum(xs, (x) => x.rev), imps: sum(xs, (x) => x.imps) }; },
  };
}

/**
 * The slice from the stored cuts only (no requests). The tier's revenue is exact (country cut); it is
 * split over formats by each format's share of the site's format revenue, and a source's traffic in
 * the tier is the tier's share of the source. An estimate: it assumes every tier has the site's
 * format mix and every source the site's geo mix.
 */
export async function estimateSlice(db: PrismaClient, key: SliceKey): Promise<SiteSlice> {
  return estimateFrom(await stored(db, key));
}
function estimateFrom(st: Awaited<ReturnType<typeof stored>>): SiteSlice {
  const title = new Map(st.sources.map((x) => [x.slug, x.title]));
  const tiers = TIER_LIST.map((tier): SliceTier => {
    const t = st.tier(tier);
    const loadShare = st.siteLoads > 0 ? t.loads / st.siteLoads : 0, revShare = st.siteRev > 0 ? t.rev / st.siteRev : 0;
    return { tier, revenue: t.rev, imps: t.imps, loads: t.loads, sourcesExact: false,
      formats: st.fmt.map((f) => ({ format: f.format, revenue: st.fmtRev > 0 ? (t.rev * f.rev) / st.fmtRev : 0, imps: st.fmtImps > 0 ? (t.imps * f.imps) / st.fmtImps : 0, exact: false })),
      sources: st.src.map((x) => {
        // the source's own revenue where ADOK reported it; otherwise its loads earn like the tier's average load
        const loads = x.loads * loadShare;
        return { slug: x.slug, title: title.get(x.slug) ?? x.slug, loads, revenue: x.rev > 0 ? x.rev * revShare : t.loads > 0 ? (t.rev / t.loads) * loads : 0 };
      }).filter((x) => x.loads > 0 || x.revenue > 0) };
  });
  return { notes: [], requests: 0, computedAt: null, tiers };
}

export async function cachedSlice(db: PrismaClient, key: SliceKey): Promise<SiteSlice | null> {
  const row = await db.buyingSlice.findUnique({ where: { key: sliceKey(key) } });
  return row ? (row.data as unknown as SiteSlice) : null;
}

type Report = (p: { from: string; to: string; groupBy: string; websiteId?: number; extra?: Record<string, string | string[]> }) => Promise<AsgRow[]>;
/**
 * The exact slice of a site from ADOK, whole period in one request each:
 *  - per format of the site: `country` filtered to the format's zones → the format's revenue and
 *    impressions by country, rolled up to tiers (revenue spread from the stored format total, ADR 0005);
 *  - per tier: `traffic_source` filtered to the tier's countries → each source's loads and revenue there.
 * Every answer is checked against the stored cuts; a part that fails keeps the estimate, with a note.
 * Throws when no part came out exact. The result is cached.
 */
export async function siteSliceWith(db: PrismaClient, report: Report, key: SliceKey): Promise<SiteSlice> {
  const site = await db.site.findUniqueOrThrow({ where: { id: key.siteId } });
  if (!site.adsgSiteId) throw new RuleError("site", "У сайта не задан ID AdSpyglass", "site");
  const filters = await readBuyingFilters(db);
  if (!filters.countries && !filters.spots) throw new RuleError("filters", "Фильтры ADOK не найдены — нажмите «Проверить фильтры ADOK». Пока показана оценка");
  const [st, countries, resolver, zones] = await Promise.all([stored(db, key), db.country.findMany({ where: { tier: { in: TIER_LIST } }, select: { code: true, tier: true } }), loadResolver(db),
    db.zone.findMany({ where: { siteId: key.siteId, isActive: true }, select: { adsgZoneId: true, format: true } })]);
  const slice = estimateFrom(st);
  const tierOf = new Map(countries.map((c) => [c.code, c.tier]));
  const base = { from: key.from, to: key.to, websiteId: site.adsgSiteId };
  let requests = 0, exactParts = 0;
  const notes: string[] = [];

  if (filters.spots) {
    for (const f of st.fmt) {
      const values = spotValues(filters.spots, zones.filter((z) => z.format === f.format).map((z) => z.adsgZoneId), [f.format]);
      if (!values.length) continue; // no zones of the format (own deals, unknown types): the share stays
      requests++;
      const rows = await report({ ...base, groupBy: "country", extra: { [filters.spots.param]: values } });
      const v = popunderScoped(rows, f.imps > 0 ? { impsOwn: f.imps } : null, st.fmtImps > 0 ? { impsOwn: st.fmtImps } : null);
      if (!v.ok) { notes.push(`${f.format}: ${v.why} — по доле формата`); continue; }
      const cells = allocateBroker(mapCountryRows(rows, resolver), { pageLoads: 0, impsOwn: 0, impsNetwork: 0, clicks: 0, revenue: f.rev, predicted: 0 });
      for (const t of slice.tiers) {
        const mine = cells.filter((c) => tierOf.get(c.countryCode) === t.tier);
        const row = t.formats.find((x) => x.format === f.format)!;
        row.revenue = mine.reduce((a, c) => a + c.m.revenue, 0); row.imps = mine.reduce((a, c) => a + c.m.impsOwn, 0); row.exact = true;
      }
      exactParts++;
    }
  } else notes.push("фильтр ADOK по зонам не найден — форматы по доле в выручке сайта");

  if (filters.countries) {
    const cf = filters.countries;
    const idRows: AsgRow[] = cf.kind === "id" ? (requests++, await report({ ...base, groupBy: "country" })) : [];
    const byName = new Map(st.sources.map((x) => [x.asgName ?? "", x])), known = new Map(st.sources.map((x) => [x.slug, x]));
    const srcStored = new Map(st.src.map((x) => [x.slug, { pageLoads: x.loads, impsOwn: x.imps, impsNetwork: 0, clicks: 0, revenue: x.rev, predicted: x.predicted } as Measures]));
    for (const t of slice.tiers) {
      if (t.loads <= 0) continue; // no traffic of the tier: nothing to ask
      const values = countryValues(cf, idRows, new Set(countries.filter((x) => x.tier === t.tier).map((x) => x.code)));
      if (!values.length) { notes.push(`T${t.tier}: ADOK не отдал ID стран — источники оценкой`); continue; }
      requests++;
      const rows = await report({ ...base, groupBy: "traffic_source", extra: { [cf.param]: values } });
      const v = t12Scoped(rows, t.loads, st.siteLoads || null);
      if (!v.ok) { notes.push(`T${t.tier}: ${v.why} — источники оценкой`); continue; }
      t.sources = mapTrafficSourceRows(rows).map((x) => {
        const src = byName.get(x.name) ?? known.get(x.slug), slug = src?.slug ?? x.slug;
        return { slug, title: src?.title ?? x.name, loads: x.m.pageLoads, revenue: t12Revenue(x.m, srcStored.get(slug)) };
      }).filter((x) => x.loads > 0 || x.revenue > 0);
      t.sourcesExact = true;
      exactParts++;
    }
  } else notes.push("фильтр ADOK по странам не найден — расход по тирам оценкой");

  if (!exactParts) throw new RuleError("asg", `ADOK не дал точных данных: ${notes.join("; ") || "нет данных за период"}. Показана оценка`);
  const data: SiteSlice = { ...slice, notes, requests, computedAt: new Date().toISOString() };
  const json = data as unknown as Prisma.InputJsonValue;
  await db.buyingSlice.upsert({ where: { key: sliceKey(key) }, create: { key: sliceKey(key), siteId: key.siteId, data: json }, update: { data: json, createdAt: new Date() } });
  return data;
}

/** The exact slice on request from the page: the usual budget and pause, no retries (the owner is waiting). */
export async function computeSiteSlice(db: PrismaClient, cfg: Config, key: SliceKey, fetchImpl?: typeof fetch): Promise<SiteSlice> {
  let rule: RuleError | null = null;
  const res = await withAsg(db, cfg, (c) => siteSliceWith(db, (p) => c.report(p), key).catch((e) => { if (e instanceof RuleError) { rule = e; return null; } throw e; }), fetchImpl);
  if (rule) throw rule;
  if (!res.ok) throw new RuleError("asg", res.error);
  return res.value!;
}

// ---------- bids ----------

export interface BidInput { sourceSlug: string; siteId: string | null; tier: number; cpm: string; loadsPerVisit: string; validFrom: string }
/** A CPM bid of a source for a tier from a date; the same (source, site, tier, date) is replaced. */
export async function saveBid(db: PrismaClient, i: BidInput): Promise<void> {
  if (!(await db.costSource.findUnique({ where: { slug: i.sourceSlug } }))) throw new RuleError("sourceSlug", "Выберите источник", "sourceSlug");
  if (!(i.tier >= 1 && i.tier <= 5)) throw new RuleError("tier", "Тир от 1 до 5", "tier");
  const numeric = (v: string) => /^\d+(\.\d+)?$/.test(v.trim());
  if (!numeric(i.cpm)) throw new RuleError("cpm", "Ставка — число, $ за 1000 визитов", "cpm");
  if (!numeric(i.loadsPerVisit || "1")) throw new RuleError("loadsPerVisit", "Загрузок на визит — число от 0.01 до 100", "loadsPerVisit");
  const cpm = new Decimal(i.cpm.trim()), lpv = new Decimal((i.loadsPerVisit || "1").trim());
  if (lpv.lte(0) || lpv.gt(100)) throw new RuleError("loadsPerVisit", "Загрузок на визит — число от 0.01 до 100", "loadsPerVisit");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.validFrom)) throw new RuleError("validFrom", "Дата начала", "validFrom");
  const where = { sourceSlug: i.sourceSlug, siteId: i.siteId, tier: i.tier, validFrom: D(i.validFrom) };
  const prev = await db.bidRate.findFirst({ where });
  const data = { cpm: cpm.toFixed(4), loadsPerVisit: lpv.toFixed(2) };
  const row = prev ? await db.bidRate.update({ where: { id: prev.id }, data }) : await db.bidRate.create({ data: { ...where, ...data } });
  await db.auditLog.create({ data: { entity: "BidRate", entityId: row.id, field: `${i.sourceSlug} T${i.tier}`, before: prev ? `$${prev.cpm} / 1000` : null, after: `$${data.cpm} / 1000 с ${i.validFrom}, ${data.loadsPerVisit} загр./визит` } });
}
export async function deleteBid(db: PrismaClient, id: string): Promise<void> {
  const prev = await db.bidRate.delete({ where: { id } });
  await db.auditLog.create({ data: { entity: "BidRate", entityId: id, field: `${prev.sourceSlug} T${prev.tier}`, before: `$${prev.cpm} / 1000`, after: null } });
}
