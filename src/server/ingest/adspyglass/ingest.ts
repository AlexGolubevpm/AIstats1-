// AdSpyglass ingest. Request plan is built for ADOK's limits and set on /settings/integrations (plan.ts, ADR 0016):
//  - hourly: ONE account-level request per day in the window (group_by=website) → site totals (country ZZ);
//  - nightly: zones from the spot cut — per site with platforms_ids[] when the plan says so (the
//    domain in the spot name is then only a check), otherwise ONE account-level request per day —
//    and per site the enabled cuts: country (always), network (adnetwork_squashed), device, traffic
//    source, ad_type (format), hour, platform (OS), browser.
// In the per-site country and device cuts ADOK scopes only the site's own fields; the ad network
// side (broker_income, broker_hits) is not per site there, so the site total from the website cut
// is spread over the cells instead (map.ts allocateBroker). The network cut is per site as is.
// The country cut's own revenue estimate is reconciled with the site total: > 2% apart is
// reported (spec readiness check "revenue matches the AdSpyglass cabinet ±2%").
// ADOK scopes a report to a site only with platforms_ids[] (website_id is silently ignored).
// Each per-site response is still checked against the site's own hits and rejected when it is
// larger, so account data is never written into a site (docs/architecture/08-backend.md#asg-limits).
// Country-level rows for a (date, site) replace its site-total row, never add to it,
// so a day is never counted twice whichever job ran last.
import Decimal from "decimal.js";
import { reapplyPayouts } from "@/server/services/finance";
import type { PrismaClient } from "@/generated/prisma/client";
import { matchPlacement } from "@/server/domain/inventory";
import { matchZonesToPlacements } from "@/server/services/inventory";
import { CountryResolver } from "@/server/ingest/normalize";
import { rawKey, type RawStore } from "@/server/ingest/raw-store";
import { AsgClient, AsgError } from "./client";
import { allocateBroker, mapCountryRows, mapDeviceRows, mapFormatRows, mapHourRows, mapNetworkRows, mapSpotRows, mapTechRows, mapTrafficSourceRows, mapWebsiteRows, optionalFields,
  type DeviceCell, type FormatCell, type GeoCell, type HourCell, type Measures, type NetworkCell, type TechCell, type TrafficSourceCell } from "./map";
import { DEFAULT_PLAN, type AsgPlan } from "./plan";

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
      pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork, clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m),
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
  await reapplyPayouts(db, dates); // a paid month keeps its confirmed amounts after the rows were rewritten
  return { rows, unknown: [...unknown] };
}

// Versioned by filter name: a flag raised while website_id was used does not block platforms_ids.
export const FILTER_IGNORED_KEY = "asg_site_filter_ignored:platforms_ids";
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
export async function ingestSiteGeo(deps: AsgIngestDeps, dates: string[], siteFilter?: string, plan: AsgPlan = DEFAULT_PLAN): Promise<{ rows: number; failed: string[]; skipped?: string }> {
  const { db, client, raw, runId } = deps;
  const on = plan.cuts;
  const ignored = await filterIgnoredRecently(db);
  if (ignored) return { rows: 0, failed: [], skipped: `гео по сайтам пропущено: ${ignored}` };
  const sites = await db.site.findMany({ where: { status: "ACTIVE", adsgSiteId: { not: null }, ...(siteFilter ? { id: siteFilter } : {}) } });
  const resolver = await loadResolver(db);
  const netId = await networkId(db);
  let rows = 0;
  const failed: string[] = [];
  try {
  for (const date of dates) {
    const websiteBody = await client.report({ from: date, to: date, groupBy: "website" });
    await raw.put(rawKey("adspyglass", "website", date, runId), websiteBody); // the split's reference, kept for reprocessing
    const siteRows = mapWebsiteRows(websiteBody).filter((t) => t.adsgSiteId != null);
    const siteTotal = new Map(siteRows.map((t) => [t.adsgSiteId!, t.m]));
    const totals = new Map(siteRows.map((t) => [t.adsgSiteId!, t.m.pageLoads]));
    for (const s of sites) {
      try {
        const body = await client.report({ from: date, to: date, groupBy: "country", websiteId: s.adsgSiteId! });
        const rawCells = mapCountryRows(body, resolver);
        const cells = allocateBroker(rawCells, siteTotal.get(s.adsgSiteId!));
        const hits = cells.reduce((a, c) => a + c.m.pageLoads, 0);
        if (!scopedToSite(hits, totals.get(s.adsgSiteId!))) {
          const why = `AdSpyglass игнорирует website_id (${s.domain} ${date}: ответ в ${(hits / Math.max(1, totals.get(s.adsgSiteId!) ?? 1)).toFixed(1)}× больше сайта)`;
          await db.appSetting.upsert({ where: { key: FILTER_IGNORED_KEY }, create: { key: FILTER_IGNORED_KEY, value: why }, update: { value: why } });
          failed.push(why);
          return { rows, failed };
        }
        await raw.put(rawKey("adspyglass", `country/${s.adsgSiteId}`, date, runId), body);
        const total = siteTotal.get(s.adsgSiteId!);
        if (!cells.length && total && (total.pageLoads > 0 || total.revenue > 0)) {
          // An empty country response must not wipe the day: keep (or write) the site total as ZZ.
          rows += await writeGeo(db, date, s.id, [{ countryCode: "ZZ", m: total }], "site", netId);
          failed.push(`${s.domain} ${date}: разрез по странам пуст — оставлен итог сайта`);
        } else rows += await writeGeo(db, date, s.id, cells, "country", netId);
        if (on.network) {
          const netBody = await client.report({ from: date, to: date, groupBy: "adnetwork_squashed", websiteId: s.adsgSiteId! });
          const nets = mapNetworkRows(netBody);
          if (scopedToSite(nets.reduce((a, c) => a + c.m.pageLoads, 0), totals.get(s.adsgSiteId!))) {
            await raw.put(rawKey("adspyglass", `network/${s.adsgSiteId}`, date, runId), netBody);
            rows += await writeNetworks(db, date, s.id, nets);
          } else failed.push(`${s.domain} ${date}: сетки не по сайту — пропущены`);
        }
        if (on.device) {
          const devBody = await client.report({ from: date, to: date, groupBy: "device", websiteId: s.adsgSiteId! });
          const devs = allocateBroker(mapDeviceRows(devBody), siteTotal.get(s.adsgSiteId!));
          if (scopedToSite(devs.reduce((a, c) => a + c.m.pageLoads, 0), totals.get(s.adsgSiteId!))) {
            await raw.put(rawKey("adspyglass", `device/${s.adsgSiteId}`, date, runId), devBody);
            rows += await writeDevices(db, date, s.id, devs);
          } else failed.push(`${s.domain} ${date}: устройства не по сайту — пропущены`);
        }
        if (on.traffic_source) {
          const srcBody = await client.report({ from: date, to: date, groupBy: "traffic_source", websiteId: s.adsgSiteId! });
          const srcs = mapTrafficSourceRows(srcBody);
          if (scopedToSite(srcs.reduce((a, c) => a + c.m.pageLoads, 0), totals.get(s.adsgSiteId!))) {
            await raw.put(rawKey("adspyglass", `traffic_source/${s.adsgSiteId}`, date, runId), srcBody);
            rows += await writeTrafficSources(db, date, s.id, srcs);
          } else failed.push(`${s.domain} ${date}: источники трафика не по сайту — пропущены`);
        }
        if (on.ad_type) {
          // The format cut: like countries and devices, ADOK scopes only the site's own fields, so the network side is spread over the formats.
          const fmtBody = await client.report({ from: date, to: date, groupBy: "ad_type", websiteId: s.adsgSiteId! });
          const fmts = allocateBroker(mapFormatRows(fmtBody), siteTotal.get(s.adsgSiteId!));
          if (scopedToSite(fmts.reduce((a, c) => a + c.m.pageLoads, 0), totals.get(s.adsgSiteId!))) {
            await raw.put(rawKey("adspyglass", `ad_type/${s.adsgSiteId}`, date, runId), fmtBody);
            rows += await writeFormats(db, date, s.id, fmts);
          } else failed.push(`${s.domain} ${date}: форматы не по сайту — пропущены`);
        }
        if (on.hour) {
          const hourBody = await client.report({ from: date, to: date, groupBy: "hour", websiteId: s.adsgSiteId! });
          const hours = allocateBroker(mapHourRows(hourBody), siteTotal.get(s.adsgSiteId!));
          if (scopedToSite(hours.reduce((a, c) => a + c.m.pageLoads, 0), totals.get(s.adsgSiteId!))) {
            await raw.put(rawKey("adspyglass", `hour/${s.adsgSiteId}`, date, runId), hourBody);
            rows += await writeHours(db, date, s.id, hours);
          } else failed.push(`${s.domain} ${date}: часы не по сайту — пропущены`);
        }
        for (const kind of ["PLATFORM", "BROWSER"] as const) {
          if (!(kind === "PLATFORM" ? on.platform : on.browser)) continue;
          const groupBy = kind === "PLATFORM" ? "platform" : "browser";
          const techBody = await client.report({ from: date, to: date, groupBy, websiteId: s.adsgSiteId! });
          const tech = allocateBroker(mapTechRows(techBody), siteTotal.get(s.adsgSiteId!));
          if (scopedToSite(tech.reduce((a, c) => a + c.m.pageLoads, 0), totals.get(s.adsgSiteId!))) {
            await raw.put(rawKey("adspyglass", `${groupBy}/${s.adsgSiteId}`, date, runId), techBody);
            rows += await writeTech(db, date, s.id, kind, tech);
          } else failed.push(`${s.domain} ${date}: ${kind === "PLATFORM" ? "платформы" : "браузеры"} не по сайту — пропущены`);
        }
        const gap = reconcile(rawCells.reduce((a, c) => a + c.m.predicted, 0), siteTotal.get(s.adsgSiteId!)?.predicted);
        if (gap != null) failed.push(`${s.domain} ${date}: сверка с итогом ADOK — выручка по странам расходится на ${(gap * 100).toFixed(1)}%`);
    } catch (e) {
        if (e instanceof AsgError && (e.pausesQueue || e.kind === "budget")) throw e; // stop the whole run
        failed.push(`${s.domain} ${date}: ${(e as Error).message}`);
      }
    }
  }
  } finally {
    // Even a run stopped by the budget or a pause must leave a paid month confirmed over the rows it rewrote.
    await saveUnresolved(db, resolver);
    await reapplyPayouts(db, dates);
  }
  return { rows, failed };
}

/** Relative gap between a cut's revenue and the site total, or null when within 2% (or $0.05). */
export function reconcile(cutRevenue: number, siteRevenue: number | undefined): number | null {
  if (siteRevenue == null) return null;
  const diff = Math.abs(cutRevenue - siteRevenue);
  if (diff <= 0.05 || diff <= Math.abs(siteRevenue) * 0.02) return null;
  return siteRevenue ? (cutRevenue - siteRevenue) / siteRevenue : 1;
}

/** Replaces the device rows of (date, site). */
export async function writeDevices(db: PrismaClient, date: string, siteId: string, cells: DeviceCell[]): Promise<number> {
  const data = cells.filter((c) => c.m.pageLoads || c.m.impsOwn || c.m.revenue).map((c) => ({
    date: d(date), siteId, device: c.device, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork,
    clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m),
  }));
  await db.$transaction([
    db.factRevenueDevice.deleteMany({ where: { date: d(date), siteId } }),
    db.factRevenueDevice.createMany({ data }),
  ]);
  return data.length;
}

/** Replaces the hour rows of (date, site): the day's profile (ADR 0016). */
export async function writeHours(db: PrismaClient, date: string, siteId: string, cells: HourCell[]): Promise<number> {
  const data = cells.filter((c) => c.m.pageLoads || c.m.impsOwn || c.m.revenue).map((c) => ({
    date: d(date), siteId, hour: c.hour, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork,
    clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m),
  }));
  await db.$transaction([db.factRevenueHour.deleteMany({ where: { date: d(date), siteId } }), db.factRevenueHour.createMany({ data })]);
  return data.length;
}

/** Replaces the platform (OS) or browser rows of (date, site). */
export async function writeTech(db: PrismaClient, date: string, siteId: string, kind: "PLATFORM" | "BROWSER", cells: TechCell[]): Promise<number> {
  const data = cells.filter((c) => c.m.pageLoads || c.m.impsOwn || c.m.revenue).map((c) => ({
    date: d(date), siteId, kind, name: c.name, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork,
    clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m),
  }));
  await db.$transaction([db.factRevenueTech.deleteMany({ where: { date: d(date), siteId, kind } }), db.factRevenueTech.createMany({ data })]);
  return data.length;
}

/** Replaces the format rows of (date, site): the ad_type cut (ADR 0016). */
export async function writeFormats(db: PrismaClient, date: string, siteId: string, cells: FormatCell[]): Promise<number> {
  const data = cells.filter((c) => c.m.pageLoads || c.m.impsOwn || c.m.revenue || c.m.requests).map((c) => ({
    date: d(date), siteId, format: c.format, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork,
    clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m),
  }));
  await db.$transaction([
    db.factRevenueFormat.deleteMany({ where: { date: d(date), siteId } }),
    db.factRevenueFormat.createMany({ data }),
  ]);
  return data.length;
}

/** ADOK sources that are not bought traffic: Direct, organic search, no referrer. No cost. */
export const FREE_SOURCES = new Set(["direct", "organic_se", "no_source"]);

/**
 * ADOK traffic sources map to CostSource by their ADOK name; a seeded source with the same slug
 * is linked. New ones are created paid (revShare 1), except the free ones (FREE_SOURCES).
 */
export async function sourceSlugs(db: PrismaClient, cells: TrafficSourceCell[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of cells) {
    const byName = await db.costSource.findUnique({ where: { asgName: c.name } });
    if (byName) { out.set(c.slug, byName.slug); continue; }
    const s = await db.costSource.upsert({ where: { slug: c.slug }, update: { asgName: c.name },
      create: { slug: c.slug, title: c.name, asgName: c.name, revShare: FREE_SOURCES.has(c.slug) ? 0 : 1, confirmed: FREE_SOURCES.has(c.slug) } });
    out.set(c.slug, s.slug);
  }
  return out;
}

/** Replaces the traffic source rows of (date, site). */
export async function writeTrafficSources(db: PrismaClient, date: string, siteId: string, cells: TrafficSourceCell[]): Promise<number> {
  const slugs = await sourceSlugs(db, cells);
  const data = cells.filter((c) => c.m.pageLoads || c.m.impsOwn || c.m.revenue).map((c) => ({
    date: d(date), siteId, sourceSlug: slugs.get(c.slug)!, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork, clicks: c.m.clicks, revenueReported: dec(c.m.revenue),
    ...optionalFields(c.m),
  }));
  await db.$transaction([
    db.factTrafficSource.deleteMany({ where: { date: d(date), siteId } }),
    db.factTrafficSource.createMany({ data }),
  ]);
  return data.length;
}

/** Networks unknown so far are created grey, outside the legend ("Прочее" until coloured). */
async function networkIds(db: PrismaClient, cells: NetworkCell[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const c of cells) {
    const n = await db.network.upsert({ where: { slug: c.slug }, update: {},
      create: { slug: c.slug, title: c.title, color: "#94A3B8", kind: "MEDIATED", showInLegend: false, sortOrder: 100 } });
    out.set(c.slug, n.id);
  }
  return out;
}

/** Replaces the network rows of (date, site). */
export async function writeNetworks(db: PrismaClient, date: string, siteId: string, cells: NetworkCell[]): Promise<number> {
  const ids = await networkIds(db, cells);
  const data = cells.filter((c) => c.m.pageLoads || c.m.impsOwn || c.m.revenue).map((c) => ({
    date: d(date), siteId, networkId: ids.get(c.slug)!, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork,
    clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m),
  }));
  await db.$transaction([
    db.factRevenueNetwork.deleteMany({ where: { date: d(date), siteId } }),
    db.factRevenueNetwork.createMany({ data }),
  ]);
  return data.length;
}

/**
 * Nightly: zones from the spot cut. With `plan.cuts.spot_site` one request per site with
 * platforms_ids[] (zones belong to the filtered site; a response naming other domains means the
 * filter was ignored — that day falls back to the account request). Otherwise ONE account-level
 * request per day: "491410. Name (domain.com)" — the domain assigns the zone to a site; spots of
 * unknown domains are skipped.
 */
export async function ingestSiteZones(deps: AsgIngestDeps, dates: string[], siteFilter?: string, plan: AsgPlan = DEFAULT_PLAN): Promise<{ rows: number; failed: string[] }> {
  const { db, client, raw, runId } = deps;
  const sites = await db.site.findMany({ where: { status: "ACTIVE", ...(siteFilter ? { id: siteFilter } : {}) } });
  const byDomain = new Map(sites.map((s) => [s.domain, s]));
  const places = await db.placement.findMany();
  let rows = 0;
  const failed: string[] = [];
  for (const date of dates) {
    try {
      const bySite = new Map<string, ReturnType<typeof mapSpotRows>>();
      let perSiteOk = false;
      if (plan.cuts.spot_site) {
        perSiteOk = true;
        for (const s of sites.filter((x) => x.adsgSiteId != null)) {
          const body = await client.report({ from: date, to: date, groupBy: "spot", websiteId: s.adsgSiteId! });
          const cells = mapSpotRows(body);
          const foreign = cells.filter((c) => c.domain && c.domain !== s.domain).length;
          if (foreign > 0 && foreign >= cells.length / 2) { // the account came back: the filter was ignored
            failed.push(`${s.domain} ${date}: зоны не по сайту — взят общий запрос`);
            perSiteOk = false; bySite.clear(); break;
          }
          await raw.put(rawKey("adspyglass", `spot/${s.adsgSiteId}`, date, runId), body);
          bySite.set(s.id, cells);
        }
      }
      if (!perSiteOk) {
        const body = await client.report({ from: date, to: date, groupBy: "spot" });
        await raw.put(rawKey("adspyglass", "spot", date, runId), body);
        for (const c of mapSpotRows(body)) {
          const site = c.domain ? byDomain.get(c.domain) : undefined;
          if (!site) continue;
          bySite.set(site.id, [...(bySite.get(site.id) ?? []), c]);
        }
      }
      for (const [siteId, cells] of bySite) {
        await db.$transaction(async (tx) => {
          await tx.factRevenueZone.deleteMany({ where: { date: d(date), siteId } });
          for (const c of cells) {
            const zone = await tx.zone.upsert({
              where: { adsgZoneId: c.adsgZoneId },
              create: { adsgZoneId: c.adsgZoneId, siteId, name: c.name, format: c.format, position: c.position, placementSlug: matchPlacement(c.name, places) },
              update: { name: c.name, format: c.format, position: c.position },
            });
            await tx.factRevenueZone.upsert({
              where: { date_zoneId: { date: d(date), zoneId: zone.id } },
              create: { date: d(date), siteId, zoneId: zone.id, format: zone.format, pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn,
                impsNetwork: c.m.impsNetwork, views: c.views, clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m) },
              update: { pageLoads: c.m.pageLoads, impsOwn: c.m.impsOwn, impsNetwork: c.m.impsNetwork, views: c.views, clicks: c.m.clicks, revenueReported: dec(c.m.revenue), ...optionalFields(c.m) },
            });
            rows++;
          }
        });
      }
      await matchZonesToPlacements(db); // new zone names become places at once (ADR 0010)
    } catch (e) {
      if (e instanceof AsgError && (e.pausesQueue || e.kind === "budget")) throw e;
      failed.push(`зоны ${date}: ${(e as Error).message}`);
    }
  }
  return { rows, failed };
}

/** Site totals of a day from the latest stored website response (adsgSiteId → measures). */
export async function siteTotalsFromRaw(raw: RawStore, date: string): Promise<Map<number, Measures> | null> {
  const keys = await raw.list(`raw/adspyglass/website/${date}/`);
  if (!keys.length) return null;
  const rows = mapWebsiteRows((await raw.get(keys.at(-1)!)) as never).filter((t) => t.adsgSiteId != null);
  return new Map(rows.map((t) => [t.adsgSiteId!, t.m]));
}

/**
 * Rewrites country and device rows from stored raw responses — no API calls. Used after an
 * alias was mapped and to re-apply the network revenue split to days ingested before it.
 * A day without a stored website response has no site total to split by: its cells are
 * written as the cut reported them (the behaviour before the split existed).
 */
export async function reprocessGeoFromRaw(db: PrismaClient, raw: RawStore, keys: RawCutKey[]): Promise<number> {
  const resolver = await loadResolver(db);
  const netId = await networkId(db);
  const totals = new Map<string, Map<number, Measures> | null>();
  let rows = 0;
  for (const k of keys) {
    if (!totals.has(k.date)) totals.set(k.date, await siteTotalsFromRaw(raw, k.date));
    const day = totals.get(k.date);
    const split = <T extends { m: Measures }>(cells: T[]) => (day ? allocateBroker(cells, day.get(k.adsgSiteId)) : cells);
    const body = (await raw.get(k.key)) as never;
    rows += k.cut === "country"
      ? await writeGeo(db, k.date, k.siteId, split(mapCountryRows(body, resolver)), "country", netId)
      : await writeDevices(db, k.date, k.siteId, split(mapDeviceRows(body)));
  }
  await reapplyPayouts(db, [...new Set(keys.map((k) => k.date))]);
  return rows;
}

export interface RawCutKey { key: string; date: string; siteId: string; adsgSiteId: number; cut: "country" | "device" }

/**
 * Latest stored country response per site × day in a window (runs are ordered by cuid, so the
 * lexicographically last key of a day is the latest run).
 */
export async function rawGeoKeys(db: PrismaClient, raw: RawStore, from: string, to: string): Promise<RawCutKey[]> {
  const sites = new Map((await db.site.findMany({ where: { adsgSiteId: { not: null } } })).map((s) => [String(s.adsgSiteId), s.id]));
  const latest = new Map<string, RawCutKey>();
  for (const cut of ["country", "device"] as const) {
    for (const key of await raw.list(`raw/adspyglass/${cut}/`)) {
      const m = new RegExp(`^raw/adspyglass/${cut}/(\\d+)/(\\d{4}-\\d{2}-\\d{2})/`).exec(key);
      if (!m || m[2] < from || m[2] > to || !sites.has(m[1])) continue;
      latest.set(`${cut}|${m[1]}|${m[2]}`, { key, date: m[2], siteId: sites.get(m[1])!, adsgSiteId: Number(m[1]), cut });
    }
  }
  return [...latest.values()];
}
