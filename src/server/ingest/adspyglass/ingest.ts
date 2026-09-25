// AdSpyglass ingest. Request plan is built for ADOK's limits:
//  - hourly: ONE account-level request per day (group_by=website) → site totals (country ZZ);
//  - nightly: ONE account-level spot cut per day (the spot name carries the domain) → zones,
//    and per-site country cuts — written only if ADOK really scoped them to the site.
// Probing showed ADOK ignores website_id (and similar names): a "per-site" country cut is the
// whole account. Each per-site response is checked against the site's own hits and rejected
// when it is larger, so account data is never written into a site (docs/architecture/08-backend.md#asg-limits).
// Country-level rows for a (date, site) replace its site-total row, never add to it,
// so a day is never counted twice whichever job ran last.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import { CountryResolver } from "@/server/ingest/normalize";
import { rawKey, type RawStore } from "@/server/ingest/raw-store";
import { AsgClient, AsgError } from "./client";
import { mapCountryRows, mapSpotRows, mapWebsiteRows, type GeoCell } from "./map";

export interface AsgIngestDeps { db: PrismaClient; client: AsgClient; raw: RawStore; runId: string }

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const dec = (v: number) => new Decimal(v).toDecimalPlaces(4).toString();

export async function loadResolver(db: PrismaClient): Promise<CountryResolver> {
  const [countries, aliases] = await Promise.all([db.country.findMany(), db.countryAlias.findMany()]);
  return new CountryResolver(countries, aliases);
}

export async function saveUnresolved(db: PrismaClient, r: CountryResolver): Promise<void> {
  for (const u of r.unresolved.values()) {
    await db.unresolvedAlias.upsert({
      where: { source_raw: { source: u.source, raw: u.raw } },
      create: { source: u.source, raw: u.raw, rows: u.rows },
      update: { rows: { increment: u.rows }, lastSeenAt: new Date() },
    });
  }
}

async function networkId(db: PrismaClient, slug = "asg_all"): Promise<string> {
  return (await db.network.findUniqueOrThrow({ where: { slug } })).id;
}

/** Replaces all geo rows of (date, site). `level = site` never overwrites country-level data. */
export async function writeGeo(db: PrismaClient, date: string, siteId: string, cells: GeoCell[], level: "site" | "country", netId: string): Promise<number> {
  return db.$transaction(async (tx) => {
    if (level === "site") {
      const detailed = await tx.factRevenueGeo.count({ where: { date: d(date), siteId, countryCode: { not: "ZZ" } } });
      if (detailed > 0) return 0;
    }
    await tx.factRevenueGeo.deleteMany({ where: { date: d(date), siteId } });
    const data = cells.filter((c) => c.m.pageLoads || c.m.impsOwn || c.m.revenue).map((c) => ({
      date: d(date), siteId, networkId: netId, countryCode: c.countryCode, device: "UNKNOWN" as const,
      pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork, clicks: c.m.clicks, revenueReported: dec(c.m.revenue),
    }));
    if (data.length) await tx.factRevenueGeo.createMany({ data });
    return data.length;
  });
}

/** Hourly: account-level totals per site. Unknown sites are recorded for /settings/sites. */
export async function ingestSiteTotals(deps: AsgIngestDeps, dates: string[]): Promise<{ rows: number; unknown: string[] }> {
  const { db, client, raw, runId } = deps;
  const sites = await db.site.findMany({ where: { status: "ACTIVE" } });
  const byId = new Map(sites.filter((s) => s.adsgSiteId).map((s) => [s.adsgSiteId!, s]));
  const byDomain = new Map(sites.map((s) => [s.domain, s]));
  const netId = await networkId(db);
  const unknown = new Set<string>();
  let rows = 0;
  for (const date of dates) {
    const body = await client.report({ from: date, to: date, groupBy: "website" });
    await raw.put(rawKey("adspyglass", "website", date, runId), body);
    for (const t of mapWebsiteRows(body)) {
      const site = (t.adsgSiteId && byId.get(t.adsgSiteId)) || byDomain.get(t.domain);
      if (!site) { unknown.add(`${t.adsgSiteId ?? ""}|${t.domain}`); continue; }
      rows += await writeGeo(db, date, site.id, [{ countryCode: "ZZ", m: t.m }], "site", netId);
    }
  }
  if (unknown.size) {
    await db.appSetting.upsert({ where: { key: "asg_unknown_sites" }, create: { key: "asg_unknown_sites", value: JSON.stringify([...unknown]) },
      update: { value: JSON.stringify([...unknown]) } });
  }
  return { rows, unknown: [...unknown] };
}

export const FILTER_IGNORED_KEY = "asg_site_filter_ignored";
const RECHECK_DAYS = 7;

/** A per-site response larger than the site itself means the filter was ignored. */
export function scopedToSite(cellsHits: number, siteHits: number | undefined): boolean {
  if (siteHits == null) return true; // no reference: cannot tell, trust it
  return cellsHits <= siteHits * 1.05 + 10;
}

async function filterIgnoredRecently(db: PrismaClient): Promise<string | null> {
  const s = await db.appSetting.findUnique({ where: { key: FILTER_IGNORED_KEY } });
  if (!s) return null;
  return Date.now() - s.updatedAt.getTime() < RECHECK_DAYS * 86_400_000 ? s.value : null;
}

/**
 * Nightly: country cut per site. One account-level website request per day gives each site's
 * hits to check the per-site responses against; the first unscoped response stops the cut
 * for the whole run (and for a week), since every further request would be wasted.
 */
export async function ingestSiteGeo(deps: AsgIngestDeps, dates: string[], siteFilter?: string): Promise<{ rows: number; failed: string[]; skipped?: string }> {
  const { db, client, raw, runId } = deps;
  const ignored = await filterIgnoredRecently(db);
  if (ignored) return { rows: 0, failed: [], skipped: `гео по сайтам пропущено: ${ignored}` };
  const sites = await db.site.findMany({ where: { status: "ACTIVE", adsgSiteId: { not: null }, ...(siteFilter ? { id: siteFilter } : {}) } });
  const resolver = await loadResolver(db);
  const netId = await networkId(db);
  let rows = 0;
  const failed: string[] = [];
  for (const date of dates) {
    const totals = new Map(mapWebsiteRows(await client.report({ from: date, to: date, groupBy: "website" }))
      .filter((t) => t.adsgSiteId != null).map((t) => [t.adsgSiteId!, t.m.pageLoads]));
    for (const s of sites) {
      try {
        const body = await client.report({ from: date, to: date, groupBy: "country", websiteId: s.adsgSiteId! });
        const cells = mapCountryRows(body, resolver);
        const hits = cells.reduce((a, c) => a + c.m.pageLoads, 0);
        if (!scopedToSite(hits, totals.get(s.adsgSiteId!))) {
          const why = `AdSpyglass игнорирует website_id (${s.domain} ${date}: ответ в ${(hits / Math.max(1, totals.get(s.adsgSiteId!) ?? 1)).toFixed(1)}× больше сайта)`;
          await db.appSetting.upsert({ where: { key: FILTER_IGNORED_KEY }, create: { key: FILTER_IGNORED_KEY, value: why }, update: { value: why } });
          failed.push(why);
          return { rows, failed };
        }
        await raw.put(rawKey("adspyglass", `country/${s.adsgSiteId}`, date, runId), body);
        rows += await writeGeo(db, date, s.id, cells, "country", netId);
      } catch (e) {
        if (e instanceof AsgError && (e.pausesQueue || e.kind === "budget")) throw e; // stop the whole run
        failed.push(`${s.domain} ${date}: ${(e as Error).message}`);
      }
    }
  }
  await saveUnresolved(db, resolver);
  return { rows, failed };
}

/**
 * Nightly: zones from ONE account-level spot cut per day. "491410. Name (domain.com)": the
 * domain assigns the zone to a site; spots of unknown domains are skipped.
 */
export async function ingestSiteZones(deps: AsgIngestDeps, dates: string[], siteFilter?: string): Promise<{ rows: number; failed: string[] }> {
  const { db, client, raw, runId } = deps;
  const sites = await db.site.findMany({ where: { status: "ACTIVE", ...(siteFilter ? { id: siteFilter } : {}) } });
  const byDomain = new Map(sites.map((s) => [s.domain, s]));
  let rows = 0;
  const failed: string[] = [];
  for (const date of dates) {
    try {
      const body = await client.report({ from: date, to: date, groupBy: "spot" });
      await raw.put(rawKey("adspyglass", "spot", date, runId), body);
      const bySite = new Map<string, ReturnType<typeof mapSpotRows>>();
      for (const c of mapSpotRows(body)) {
        const site = c.domain ? byDomain.get(c.domain) : undefined;
        if (!site) continue;
        bySite.set(site.id, [...(bySite.get(site.id) ?? []), c]);
      }
      for (const [siteId, cells] of bySite) {
        await db.$transaction(async (tx) => {
          await tx.factRevenueZone.deleteMany({ where: { date: d(date), siteId } });
          for (const c of cells) {
            const zone = await tx.zone.upsert({
              where: { adsgZoneId: c.adsgZoneId },
              create: { adsgZoneId: c.adsgZoneId, siteId, name: c.name, format: c.format, position: c.position },
              update: { name: c.name },
            });
            await tx.factRevenueZone.upsert({
              where: { date_zoneId: { date: d(date), zoneId: zone.id } },
              create: { date: d(date), siteId, zoneId: zone.id, format: zone.format, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn,
                impsNetwork: c.m.impsNetwork, views: c.views, clicks: c.m.clicks, revenueReported: dec(c.m.revenue) },
              update: { pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork, views: c.views, clicks: c.m.clicks, revenueReported: dec(c.m.revenue) },
            });
            rows++;
          }
        });
      }
    } catch (e) {
      if (e instanceof AsgError && (e.pausesQueue || e.kind === "budget")) throw e;
      failed.push(`зоны ${date}: ${(e as Error).message}`);
    }
  }
  return { rows, failed };
}

/** Re-applies country mapping from stored raw responses (after an alias was fixed) — no API calls. */
export async function reprocessGeoFromRaw(db: PrismaClient, raw: RawStore, keys: { key: string; date: string; siteId: string }[]): Promise<number> {
  const resolver = await loadResolver(db);
  const netId = await networkId(db);
  let rows = 0;
  for (const k of keys) rows += await writeGeo(db, k.date, k.siteId, mapCountryRows((await raw.get(k.key)) as never, resolver), "country", netId);
  return rows;
}

/**
 * Latest stored country response per site × day in a window (runs are ordered by cuid, so the
 * lexicographically last key of a day is the latest run).
 */
export async function rawGeoKeys(db: PrismaClient, raw: RawStore, from: string, to: string): Promise<{ key: string; date: string; siteId: string }[]> {
  const sites = new Map((await db.site.findMany({ where: { adsgSiteId: { not: null } } })).map((s) => [String(s.adsgSiteId), s.id]));
  const latest = new Map<string, { key: string; date: string; siteId: string }>();
  for (const key of await raw.list("raw/adspyglass/country/")) {
    const m = /^raw\/adspyglass\/country\/(\d+)\/(\d{4}-\d{2}-\d{2})\//.exec(key);
    if (!m || m[2] < from || m[2] > to || !sites.has(m[1])) continue;
    latest.set(`${m[1]}|${m[2]}`, { key, date: m[2], siteId: sites.get(m[1])! });
  }
  return [...latest.values()];
}
