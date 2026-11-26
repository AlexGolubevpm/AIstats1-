// ADOK filters for the «Окупаемость закупки» report (ADR 0023). ADOK answers 422 to two group_by
// dimensions, so «popunder × country» and «traffic source × T1/T2» are one dimension plus a filter:
//  - the country cut filtered to the site's popunder zones;
//  - the traffic_source cut filtered to the T1/T2 countries.
// The names of those filters are not documented (only platforms_ids[] is known, from the web UI).
// «Проверить фильтры» tries candidates on one site-day and keeps the first one whose answer is
// really narrower than the unfiltered one: an unknown filter is silently ignored by ADOK.
import type { PrismaClient } from "@/generated/prisma/client";
import { measures, type Measures } from "./map";
import type { AsgRow } from "./client";

export const FILTERS_KEY = "asg_buying_filters";
/** Tiers of the report: tier 1 and 2 countries (ADR 0017). */
export const T12_TIERS = [1, 2];
export const T12 = "T12";

export interface SpotFilter { param: string; kind: "zone_ids" | "ad_type"; value?: string }
export interface CountryFilter { param: string; kind: "iso" | "id" }
export interface BuyingFilters { spots?: SpotFilter; countries?: CountryFilter; checkedAt?: string; site?: string; day?: string }

export const SPOT_CANDIDATES: SpotFilter[] = [
  { param: "spots_ids[]", kind: "zone_ids" },
  { param: "spot_ids[]", kind: "zone_ids" },
  { param: "ad_types[]", kind: "ad_type", value: "popunder" },
  { param: "ad_types_ids[]", kind: "ad_type", value: "popunder" },
];
export const COUNTRY_CANDIDATES: CountryFilter[] = [
  { param: "countries_ids[]", kind: "id" },
  { param: "countries[]", kind: "iso" },
  { param: "countries_ids[]", kind: "iso" },
  { param: "country_codes[]", kind: "iso" },
];

export async function readBuyingFilters(db: PrismaClient): Promise<BuyingFilters> {
  const row = await db.appSetting.findUnique({ where: { key: FILTERS_KEY } });
  if (!row) return {};
  try { return JSON.parse(row.value) as BuyingFilters; } catch { return {}; }
}
export async function saveBuyingFilters(db: PrismaClient, f: BuyingFilters): Promise<void> {
  await db.appSetting.upsert({ where: { key: FILTERS_KEY }, create: { key: FILTERS_KEY, value: JSON.stringify(f) }, update: { value: JSON.stringify(f) } });
}

/** ADOK's names of the ad types, for a filter that takes the type instead of zone ids. */
export const FORMAT_ADOK: Record<string, string> = { POPUNDER: "popunder", BANNER: "banner", NATIVE: "native", SLIDER: "slider", OUTSTREAM: "outstream", INVIDEO: "invideo", INPAGEPUSH: "inpage_push" };
/** The values a spot filter sends: the zone ids of the formats, or the formats' names (popunder when none is given). */
export const spotValues = (f: SpotFilter, zoneIds: number[], formats?: string[]): string[] =>
  f.kind === "zone_ids" ? zoneIds.map(String) : formats ? formats.map((x) => FORMAT_ADOK[x]).filter(Boolean) : [f.value ?? "popunder"];

/** The values a country filter sends for the T1/T2 countries, from the unfiltered country rows of the same day (ADOK ids ride along as `id`). */
export function countryValues(f: CountryFilter, rows: AsgRow[], t12: Set<string>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    const iso = typeof r.iso === "string" ? r.iso.trim().toUpperCase() : null;
    if (!iso || !t12.has(iso)) continue;
    if (f.kind === "iso") out.add(iso);
    else if (r.id != null && String(r.id).trim()) out.add(String(r.id));
  }
  if (f.kind === "iso" && !out.size) for (const c of t12) out.add(c);
  return [...out];
}

const sumOf = (rows: AsgRow[]): Measures => rows.map(measures).reduce((a, m) => ({ ...a, pageLoads: a.pageLoads + m.pageLoads, impsOwn: a.impsOwn + m.impsOwn,
  revenue: a.revenue + m.revenue, predicted: a.predicted + m.predicted, impsNetwork: a.impsNetwork + m.impsNetwork, clicks: a.clicks + m.clicks }),
{ pageLoads: 0, impsOwn: 0, impsNetwork: 0, clicks: 0, revenue: 0, predicted: 0 } as Measures);

/**
 * Is a zone-filtered country answer really popunder only? Popunder loads on nearly every page, so
 * loads cannot tell; own impressions can: banners add many more. Accepted when the answer has
 * impressions, no more than the popunder format has (+10%), and, where popunder is a clear part
 * of the site, less than the whole site.
 */
export function popunderScoped(rows: AsgRow[], pop: { impsOwn: number } | null, site: { impsOwn: number } | null): { ok: boolean; why: string } {
  const imps = sumOf(rows).impsOwn;
  if (imps <= 0) return { ok: false, why: "пустой ответ" };
  if (pop && imps > pop.impsOwn * 1.1 + 10) return { ok: false, why: `показов ${imps} больше, чем у попсов (${pop.impsOwn}) — фильтр не сработал` };
  if (site && (!pop || pop.impsOwn < site.impsOwn * 0.9) && imps >= site.impsOwn * 0.95) return { ok: false, why: "ответ равен всему сайту — фильтр не сработал" };
  return { ok: true, why: `показов ${imps}${pop ? ` из ${pop.impsOwn} у попсов` : ""}` };
}

/** Is a country-filtered traffic source answer really T1/T2 only? Its loads must match the T1/T2 loads of the country cut (±10%). */
export function t12Scoped(rows: AsgRow[], t12Loads: number, siteLoads: number | null): { ok: boolean; why: string } {
  const loads = sumOf(rows).pageLoads;
  if (loads <= 0) return { ok: false, why: "пустой ответ" };
  if (siteLoads != null && t12Loads < siteLoads * 0.9 && loads >= siteLoads * 0.95) return { ok: false, why: "ответ равен всему сайту — фильтр не сработал" };
  if (Math.abs(loads - t12Loads) > Math.max(10, t12Loads * 0.1)) return { ok: false, why: `загрузок ${loads}, а у T1/T2 по странам ${t12Loads}` };
  return { ok: true, why: `загрузок ${loads} ≈ T1/T2 по странам ${t12Loads}` };
}

/**
 * ADOK may filter only the site's own fields and leave broker_income unfiltered (ADR 0005). Then the
 * T1/T2 source revenue is the source's whole revenue spread by its own estimate: revenue_all × predicted_t12 / predicted_all.
 */
export function t12Revenue(t12: Measures, all: Measures | undefined): number {
  if (!all) return t12.revenue;
  const loadShare = all.pageLoads > 0 ? t12.pageLoads / all.pageLoads : 1;
  const unfiltered = all.revenue > 0 && t12.revenue >= all.revenue * 0.98 && loadShare < 0.9;
  if (!unfiltered) return t12.revenue;
  if (all.predicted > 0) return (all.revenue * t12.predicted) / all.predicted;
  return all.revenue * loadShare;
}

/** Is a «formats inside a slice» answer really narrower? By own impressions: some, not above the slice, and not the whole slice when the formats are a clear part of the site. */
export function formatScoped(partImps: number, wholeImps: number, expectedShare: number | null): { ok: boolean; why: string } {
  if (partImps <= 0) return { ok: false, why: "пустой ответ" };
  if (partImps > wholeImps * 1.1 + 10) return { ok: false, why: "показов больше, чем во всём срезе" };
  if (expectedShare != null && expectedShare < 0.9 && partImps >= wholeImps * 0.95) return { ok: false, why: "ответ равен всему срезу — фильтр по зонам не сработал" };
  return { ok: true, why: `показов ${partImps} из ${wholeImps}` };
}
