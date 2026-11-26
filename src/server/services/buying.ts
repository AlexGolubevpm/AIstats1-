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
  COUNTRY_CANDIDATES, SPOT_CANDIDATES, T12_TIERS, countryValues, formatRevenue, formatScoped, popunderScoped, readBuyingFilters, saveBuyingFilters, spotValues, t12Revenue, t12Scoped,
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

// ---------- the slice ----------

export const ALL_FORMATS = ["POPUNDER", "BANNER", "NATIVE", "SLIDER", "OUTSTREAM", "INVIDEO", "INPAGEPUSH", "OTHER"] as const;
export interface SliceSel { siteId: string; from: string; to: string; /** null = all formats */ formats: string[] | null; tiers: number[] }
export interface SliceSource { slug: string; title: string; loads: number; revenueAll: number; revenueFmt: number }
export interface SliceData {
  /** every tier came from the filtered ADOK requests */ exact: boolean;
  /** the formats' part came from the zone filter, not from the formats' share of the site */ fmtExact: boolean;
  notes: string[]; requests: number; computedAt: string | null;
  tiers: { tier: number; exact: boolean; sources: SliceSource[] }[];
  countries: { cc: string; tier: number; loads: number; revenueAll: number; revenueFmt: number }[];
}

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const num = (v: unknown) => (v == null ? 0 : Number(v));
export const normSel = (s: SliceSel): SliceSel => ({ ...s, tiers: [...new Set(s.tiers)].filter((t) => t >= 1 && t <= 5).sort(),
  formats: s.formats && s.formats.length && s.formats.length < ALL_FORMATS.length ? [...new Set(s.formats)].sort() : null });
export const sliceKey = (s: SliceSel) => { const n = normSel(s); return `${n.siteId}|${n.from}|${n.to}|${n.formats?.join(",") ?? "ALL"}|${n.tiers.join(",")}`; };

/** What the stored cuts know about the site over the period. */
async function stored(db: PrismaClient, s: SliceSel) {
  type Raw = Record<string, unknown>;
  const [geo, fmt, src, sources] = await Promise.all([
    db.$queryRaw<Raw[]>`
      SELECT g.country_code cc, COALESCE(c.tier, 0)::int tier, SUM(g.page_loads)::float8 loads, SUM(g.revenue_mediated)::float8 rev
      FROM v_site_geo_daily g LEFT JOIN "Country" c ON c.code = g.country_code
      WHERE g.site_id = ${s.siteId} AND g.date BETWEEN ${D(s.from)} AND ${D(s.to)} GROUP BY 1, 2`,
    db.$queryRaw<Raw[]>`
      SELECT format::text, SUM(revenue)::float8 rev, SUM(imps_own)::float8 imps
      FROM v_format_daily WHERE site_id = ${s.siteId} AND date BETWEEN ${D(s.from)} AND ${D(s.to)} GROUP BY 1`,
    db.$queryRaw<Raw[]>`
      SELECT "sourceSlug" slug, SUM("pageLoads")::float8 loads, SUM("revenueReported")::float8 rev, SUM("predictedIncome")::float8 predicted, SUM("impsOwn")::float8 imps
      FROM "FactTrafficSource" WHERE "siteId" = ${s.siteId} AND date BETWEEN ${D(s.from)} AND ${D(s.to)} GROUP BY 1`,
    db.costSource.findMany(),
  ]);
  const sel = (r: Raw) => !s.formats || s.formats.includes(String(r.format));
  // v_format_daily: the ad_type cut, or the zone sums for days without it
  const tot = (rows: Raw[]) => ({ rev: rows.reduce((a, r) => a + num(r.rev), 0), imps: rows.reduce((a, r) => a + num(r.imps), 0) });
  const fmtAll = tot(fmt), fmtSel = tot(fmt.filter(sel));
  return {
    geo: geo.map((r) => ({ cc: String(r.cc), tier: num(r.tier), loads: num(r.loads), rev: num(r.rev) })),
    siteLoads: geo.reduce((a, r) => a + num(r.loads), 0), siteRev: geo.reduce((a, r) => a + num(r.rev), 0),
    fmtAll, fmtSel, fmtShare: !s.formats ? 1 : fmtAll.rev > 0 ? fmtSel.rev / fmtAll.rev : 0,
    src: src.map((r) => ({ slug: String(r.slug), loads: num(r.loads), rev: num(r.rev), predicted: num(r.predicted), imps: num(r.imps) })),
    sources,
  };
}

/**
 * The slice from the stored cuts only (no requests): a source's traffic in a tier is taken as the
 * tier's share of the site (loads by loads, revenue by revenue), the formats as their share of the
 * site's format revenue. An estimate: it assumes every source has the site's geo and format mix.
 */
export async function estimateSlice(db: PrismaClient, sel: SliceSel): Promise<SliceData> {
  const s = normSel(sel), st = await stored(db, s);
  const title = new Map(st.sources.map((x) => [x.slug, x.title]));
  const tiers = s.tiers.map((tier) => {
    const g = st.geo.filter((x) => x.tier === tier);
    const tLoads = g.reduce((a, x) => a + x.loads, 0), tRev = g.reduce((a, x) => a + x.rev, 0);
    const loadShare = st.siteLoads > 0 ? tLoads / st.siteLoads : 0, revShare = st.siteRev > 0 ? tRev / st.siteRev : 0;
    return { tier, exact: false, sources: st.src.map((x) => {
      // the source's own revenue where ADOK reported it; otherwise its loads earn like the tier's average load
      const loads = x.loads * loadShare, revenueAll = x.rev > 0 ? x.rev * revShare : tLoads > 0 ? (tRev / tLoads) * loads : 0;
      return { slug: x.slug, title: title.get(x.slug) ?? x.slug, loads, revenueAll, revenueFmt: revenueAll * st.fmtShare };
    })
      .filter((x) => x.loads > 0 || x.revenueAll > 0) };
  });
  return { exact: false, fmtExact: false, notes: [], requests: 0, computedAt: null, tiers,
    countries: st.geo.filter((x) => s.tiers.includes(x.tier)).map((x) => ({ cc: x.cc, tier: x.tier, loads: x.loads, revenueAll: x.rev, revenueFmt: x.rev * st.fmtShare })) };
}

export async function cachedSlice(db: PrismaClient, sel: SliceSel): Promise<SliceData | null> {
  const row = await db.buyingSlice.findUnique({ where: { key: sliceKey(sel) } });
  return row ? (row.data as unknown as SliceData) : null;
}

/**
 * Computes the slice from ADOK and caches it. Per tier: traffic_source filtered to the tier's
 * countries, and — when formats are chosen — once more with the formats' zones. Every answer is
 * checked (a filter ADOK ignores comes back unfiltered); a tier that fails falls back to the
 * estimate with a note. Throws when nothing could be computed exactly.
 */
export async function computeSlice(db: PrismaClient, cfg: Config, sel: SliceSel, fetchImpl?: typeof fetch): Promise<SliceData> {
  const s = normSel(sel);
  if (!s.tiers.length) throw new RuleError("tiers", "Выберите хотя бы один тир");
  const site = await db.site.findUniqueOrThrow({ where: { id: s.siteId } });
  if (!site.adsgSiteId) throw new RuleError("site", "У сайта не задан ID AdSpyglass", "site");
  const filters = await readBuyingFilters(db);
  if (!filters.countries) throw new RuleError("filters", "Фильтр ADOK по странам не найден — нажмите «Проверить фильтры ADOK». Пока показана оценка");
  const cf = filters.countries;
  const [st, est, countries, resolver] = await Promise.all([stored(db, s), estimateSlice(db, s), db.country.findMany({ where: { tier: { in: s.tiers } }, select: { code: true, tier: true } }), loadResolver(db)]);
  const notes: string[] = [];
  let spot: { param: string; values: string[] } | null = null;
  if (s.formats) {
    const zoneIds = (await db.zone.findMany({ where: { siteId: s.siteId, format: { in: s.formats as never[] }, isActive: true }, select: { adsgZoneId: true } })).map((z) => z.adsgZoneId);
    const values = filters.spots ? spotValues(filters.spots, zoneIds, s.formats) : [];
    if (filters.spots && values.length) spot = { param: filters.spots.param, values };
    else notes.push(filters.spots ? "у сайта нет зон выбранных форматов — форматы по доле в выручке сайта" : "фильтр ADOK по зонам не найден — форматы по доле в выручке сайта");
  }
  const bySlug = new Map(st.sources.map((x) => [x.asgName ?? "", x]));
  const known = new Map(st.sources.map((x) => [x.slug, x]));
  const srcStored = new Map(st.src.map((x) => [x.slug, { pageLoads: x.loads, impsOwn: x.imps, impsNetwork: 0, clicks: 0, revenue: x.rev, predicted: x.predicted } as Measures]));
  const expectedShare = st.fmtAll.imps > 0 ? st.fmtSel.imps / st.fmtAll.imps : null;
  const base = { from: s.from, to: s.to, websiteId: site.adsgSiteId };
  const res = await withAsg(db, cfg, async (c) => {
    let requests = 0, fmtExact = Boolean(spot) || !s.formats;
    const idRows: AsgRow[] = cf.kind === "id" ? (requests++, await c.report({ ...base, groupBy: "country" })) : [];
    const tiers: SliceData["tiers"] = [];
    for (const tier of s.tiers) {
      const fallback = est.tiers.find((t) => t.tier === tier)!;
      const values = countryValues(cf, idRows, new Set(countries.filter((x) => x.tier === tier).map((x) => x.code)));
      if (!values.length) { notes.push(`T${tier}: ADOK не отдал ID стран — оценка`); tiers.push(fallback); continue; }
      requests++;
      const rowsAll = await c.report({ ...base, groupBy: "traffic_source", extra: { [cf.param]: values } });
      const v = t12Scoped(rowsAll, st.geo.filter((x) => x.tier === tier).reduce((a, x) => a + x.loads, 0), st.siteLoads || null);
      if (!v.ok) { notes.push(`T${tier}: ${v.why} — оценка`); tiers.push(fallback); continue; }
      const all = mapTrafficSourceRows(rowsAll);
      let fmt: Map<string, Measures> | null = null;
      if (spot) {
        requests++;
        const part = mapTrafficSourceRows(await c.report({ ...base, groupBy: "traffic_source", extra: { [cf.param]: values, [spot.param]: spot.values } }));
        const sum = (xs: { m: Measures }[]) => xs.reduce((a, x) => a + x.m.impsOwn, 0);
        const fv = formatScoped(sum(part), sum(all), expectedShare);
        if (fv.ok) fmt = new Map(part.map((x) => [x.slug, x.m]));
        else { notes.push(`T${tier}: форматы — ${fv.why}; взята доля форматов в выручке сайта`); fmtExact = false; }
      }
      tiers.push({ tier, exact: true, sources: all.map((x) => {
        const src = bySlug.get(x.name) ?? known.get(x.slug);
        const slug = src?.slug ?? x.slug;
        const revenueAll = t12Revenue(x.m, srcStored.get(slug));
        const part = fmt?.get(x.slug);
        const revenueFmt = !s.formats ? revenueAll : fmt ? (part ? formatRevenue(part, x.m, revenueAll) : 0) : revenueAll * st.fmtShare;
        return { slug, title: src?.title ?? x.name, loads: x.m.pageLoads, revenueAll, revenueFmt };
      }).filter((x) => x.loads > 0 || x.revenueAll > 0) });
    }
    // countries: the formats' revenue by country from the zone-filtered country cut, spread from the stored format total
    let cc = est.countries;
    if (spot && tiers.some((t) => t.exact)) {
      requests++;
      const rows = await c.report({ ...base, groupBy: "country", extra: { [spot.param]: spot.values } });
      const pv = popunderScoped(rows, st.fmtSel.imps > 0 ? { impsOwn: st.fmtSel.imps } : null, st.fmtAll.imps > 0 ? { impsOwn: st.fmtAll.imps } : null);
      if (pv.ok) {
        const cells = allocateBroker(mapCountryRows(rows, resolver), { pageLoads: 0, impsOwn: 0, impsNetwork: 0, clicks: 0, revenue: st.fmtSel.rev, predicted: 0 });
        const rev = new Map(cells.map((x) => [x.countryCode, x.m.revenue]));
        cc = cc.map((x) => ({ ...x, revenueFmt: Math.min(x.revenueAll, rev.get(x.cc) ?? 0) }));
      } else notes.push(`страны: ${pv.why}; взята доля форматов в выручке сайта`);
    }
    return { tiers, countries: cc, requests, fmtExact };
  }, fetchImpl);
  if (!res.ok) throw new RuleError("asg", res.error);
  const { tiers, requests, fmtExact } = res.value;
  if (!tiers.some((t) => t.exact)) throw new RuleError("asg", `ADOK не дал точного среза: ${notes.join("; ")}. Показана оценка`);
  const data: SliceData = { exact: tiers.every((t) => t.exact), fmtExact, notes, requests, computedAt: new Date().toISOString(), tiers, countries: res.value.countries };
  const json = data as unknown as Prisma.InputJsonValue;
  await db.buyingSlice.upsert({ where: { key: sliceKey(s) }, create: { key: sliceKey(s), siteId: s.siteId, data: json }, update: { data: json, createdAt: new Date() } });
  return data;
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
