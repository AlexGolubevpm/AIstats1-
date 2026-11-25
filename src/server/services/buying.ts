// «Закупка T1/T2» (ADR 0023): finding the ADOK filters the report needs. One site-day, a handful of
// requests through the usual budget and pause (probe.ts withAsg). Found filters are stored and the
// two cuts are switched on in the request plan, so the nightly ingest starts filling the report.
import type { PrismaClient } from "@/generated/prisma/client";
import type { Config } from "@/server/config";
import { RuleError } from "@/server/domain/errors";
import { AsgError, type AsgRow } from "@/server/ingest/adspyglass/client";
import {
  COUNTRY_CANDIDATES, SPOT_CANDIDATES, T12_TIERS, countryValues, popunderScoped, readBuyingFilters, saveBuyingFilters, spotValues, t12Scoped,
  type BuyingFilters, type CountryFilter, type SpotFilter,
} from "@/server/ingest/adspyglass/filters";
import { mapFormatRows, mapWebsiteRows, measures } from "@/server/ingest/adspyglass/map";
import { readPlan, savePlan } from "@/server/ingest/adspyglass/plan";
import { withAsg } from "@/server/ingest/probe";

export interface FilterTry { what: "popunder" | "t12"; param: string; kind: string; ok: boolean; why: string }
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
    return { spots, countries, tried };
  }, fetchImpl);
  if (!res.ok) throw new RuleError("asg", res.error);
  const { spots, countries, tried } = res.value;
  const prev = await readBuyingFilters(db);
  const next: BuyingFilters = { spots: spots ?? undefined, countries: countries ?? undefined, checkedAt: new Date().toISOString(), site: site.domain, day };
  await saveBuyingFilters(db, next);
  const plan = await readPlan(db);
  await savePlan(db, { ...plan, cuts: { ...plan.cuts, popunder_geo: Boolean(spots), source_t12: Boolean(countries) } });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: "asg_buying_filters", field: "filters",
    before: prev.checkedAt ? `${prev.spots?.param ?? "—"} · ${prev.countries?.param ?? "—"}` : null,
    after: `${spots ? label(spots) : "попсы: фильтр не найден"} · ${countries ? label(countries) : "T1/T2: фильтр не найден"}` } });
  return { spots, countries, tried, day, site: site.domain };
}
