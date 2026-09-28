// Mapping of ADOK report rows to fact rows. The field mapping lives here in one place:
// confirm it against real responses (scripts/asg-probe.sh) and adjust only this file.
import { normalizeDevice, normalizeFormat, parseSpotName, parseWebsiteName, guessPosition, type CountryResolver, type FormatCode } from "@/server/ingest/normalize";
import type { AsgRow } from "./client";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v) || 0);

/** ADOK field → TubeStat measure. */
export function measures(r: AsgRow) {
  return {
    pageLoads: Math.round(num(r.hits)),
    impsOwn: Math.round(num(r.impressions)),
    impsNetwork: Math.round(num(r.broker_hits)),
    clicks: Math.round(num(r.clicks)),
    revenue: num(r.broker_income),
  };
}

/** banner_view_rate may come as a fraction or a percentage. */
export function viewRate(r: AsgRow): number {
  const v = num(r.banner_view_rate);
  return v > 1 ? v / 100 : v;
}

export interface SiteTotal { adsgSiteId: number | null; domain: string; m: ReturnType<typeof measures> }
export function mapWebsiteRows(rows: AsgRow[]): SiteTotal[] {
  return rows.map((r) => { const w = parseWebsiteName(String(r.name)); return { adsgSiteId: w.id, domain: w.domain, m: measures(r) }; });
}

export interface GeoCell { countryCode: string; m: ReturnType<typeof measures> }
/**
 * group_by=country rows; several raw names may map to the same code (and to XX) — summed.
 * ADOK sends an `iso` field next to the name: a known code wins, the name is the fallback.
 */
export function mapCountryRows(rows: AsgRow[], resolver: CountryResolver): GeoCell[] {
  const acc = new Map<string, ReturnType<typeof measures>>();
  for (const r of rows) {
    const iso = typeof r.iso === "string" ? r.iso : null;
    const code = resolver.knows(iso) ? iso!.trim().toUpperCase() : resolver.resolve(String(r.name), "adspyglass");
    const m = measures(r), cur = acc.get(code);
    acc.set(code, cur ? { pageLoads: cur.pageLoads + m.pageLoads, impsOwn: cur.impsOwn + m.impsOwn, impsNetwork: cur.impsNetwork + m.impsNetwork,
      clicks: cur.clicks + m.clicks, revenue: cur.revenue + m.revenue } : m);
  }
  return [...acc].map(([countryCode, m]) => ({ countryCode, m }));
}

export interface ZoneCell { adsgZoneId: number; name: string; domain: string | null; format: FormatCode; position: string | null; views: number; m: ReturnType<typeof measures> }
/** group_by=spot rows. Views only for BANNER / NATIVE, from banner_view_rate × impressions. */
export function mapSpotRows(rows: AsgRow[]): ZoneCell[] {
  const out: ZoneCell[] = [];
  for (const r of rows) {
    const s = parseSpotName(String(r.name));
    if (s.id == null) continue;
    const format = normalizeFormat(String(r.ad_type ?? s.name));
    const m = measures(r);
    const views = format === "BANNER" || format === "NATIVE" ? Math.round(m.impsOwn * viewRate(r)) : 0;
    out.push({ adsgZoneId: s.id, name: s.name, domain: s.domain, format, position: guessPosition(s.name), views, m });
  }
  return out;
}

export interface NetworkCell { slug: string; title: string; m: ReturnType<typeof measures> }
/** "AdPulsar.io" → slug "adpulsar" (matches seeded networks), title as sent. Duplicates summed. */
export function networkSlug(name: string): string {
  return name.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\.[a-z]{2,}$/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}
/** group_by=adnetwork_squashed rows. */
export function mapNetworkRows(rows: AsgRow[]): NetworkCell[] {
  const acc = new Map<string, NetworkCell>();
  for (const r of rows) {
    const title = String(r.name ?? "").trim() || "unknown";
    const slug = networkSlug(title), m = measures(r), cur = acc.get(slug);
    acc.set(slug, cur ? { slug, title: cur.title, m: { pageLoads: cur.m.pageLoads + m.pageLoads, impsOwn: cur.m.impsOwn + m.impsOwn,
      impsNetwork: cur.m.impsNetwork + m.impsNetwork, clicks: cur.m.clicks + m.clicks, revenue: cur.m.revenue + m.revenue } } : { slug, title, m });
  }
  return [...acc.values()];
}

export interface DeviceCell { device: ReturnType<typeof normalizeDevice>; m: ReturnType<typeof measures> }
/** group_by=device rows ("Desktop", "Mobile", …); unknown names land in UNKNOWN, duplicates summed. */
export function mapDeviceRows(rows: AsgRow[]): DeviceCell[] {
  const acc = new Map<string, DeviceCell>();
  for (const r of rows) {
    const device = normalizeDevice(String(r.name ?? "")), m = measures(r), cur = acc.get(device);
    acc.set(device, cur ? { device, m: { pageLoads: cur.m.pageLoads + m.pageLoads, impsOwn: cur.m.impsOwn + m.impsOwn,
      impsNetwork: cur.m.impsNetwork + m.impsNetwork, clicks: cur.m.clicks + m.clicks, revenue: cur.m.revenue + m.revenue } } : { device, m });
  }
  return [...acc.values()];
}
