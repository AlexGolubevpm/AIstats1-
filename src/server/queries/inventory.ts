// The inventory grid: active sites × places, each cell resolved by domain/inventory.resolvePlace,
// and the list of every fix deal with who / how much / from / to (docs/product/03-pages.md#inventory).
import { db } from "@/server/db";
import type { Period } from "@/lib/period";
import { daysLeft, resolvePlace, type PlaceCell, type PlaceDeal } from "@/server/domain/inventory";
import { BASIS_LABEL } from "./deals";

type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface ZoneRow { id: string; name: string; format: string; placementSlug: string | null; revenue: number; imps: number }
export interface InventoryGrid {
  places: { slug: string; title: string; free: number; revenue: number }[];
  sites: { id: string; domain: string; bundles: string[]; cells: Record<string, PlaceCell>; free: number; revenue: number; unmapped: number; zones: ZoneRow[] }[];
  /** Revenue of the whole network in the period (by sites, so a site in two bundles counts once). */
  revenue: number;
}

/**
 * Sites × places. Revenue of a cell for the period = zone facts of the site's zones mapped to the
 * place + fix-deal facts of deals with that place, DIRECT and VIA_ASG alike (own deals are not in the zone cut, CLAUDE.md).
 */
export async function inventoryGrid(today = iso(new Date()), p?: Period): Promise<InventoryGrid> {
  const period = p ?? { from: iso(new Date(D(today).getTime() - 6 * 86_400_000)), to: today };
  const [places, sites, deals, zones, manual, links, zoneRev, dealRev] = await Promise.all([
    db.placement.findMany({ orderBy: [{ sortOrder: "asc" }, { title: "asc" }] }),
    db.site.findMany({ where: { status: "ACTIVE" }, orderBy: { domain: "asc" } }),
    db.deal.findMany({ where: { places: { some: {} }, status: { in: ["ACTIVE", "PAUSED"] }, startsAt: { lte: D(today) },
      OR: [{ endsAt: null }, { endsAt: { gte: D(today) } }] }, include: { places: true, advertiser: true } }),
    db.zone.findMany({ where: { isActive: true }, orderBy: { name: "asc" } }),
    db.sitePlacement.findMany({ include: { network: true } }),
    db.bundleSite.findMany({ include: { bundle: true } }),
    db.$queryRaw<Raw[]>`SELECT f."zoneId" zone_id, SUM(f."revenueReported")::float8 revenue, SUM(f."impsOwn")::float8 imps
      FROM "FactRevenueZone" f WHERE f.date BETWEEN ${D(period.from)} AND ${D(period.to)} GROUP BY 1`,
    // A deal on several places of one site: its facts are per site, so they are split evenly between those places.
    db.$queryRaw<Raw[]>`WITH k AS (SELECT "dealId", "siteId", COUNT(*)::float8 n FROM "DealPlace" GROUP BY 1, 2)
      SELECT dp."siteId" site_id, dp."placementSlug" slug, SUM(f.revenue / k.n)::float8 revenue, SUM(f."impsOwn" / k.n)::float8 imps
      FROM "FactFixDeal" f JOIN "DealPlace" dp ON dp."dealId" = f."dealId" AND dp."siteId" = f."siteId" JOIN k ON k."dealId" = f."dealId" AND k."siteId" = f."siteId"
      WHERE f.date BETWEEN ${D(period.from)} AND ${D(period.to)} GROUP BY 1, 2`,
  ]);
  const key = (siteId: string, slug: string) => `${siteId}|${slug}`;
  const dealsAt = new Map<string, PlaceDeal[]>();
  for (const d of deals) for (const pl of d.places) {
    const k = key(pl.siteId, pl.placementSlug);
    dealsAt.set(k, [...(dealsAt.get(k) ?? []), { id: d.id, title: d.title, advertiser: d.advertiser.name, price: d.price.toString(),
      basis: BASIS_LABEL[d.paymentBasis] ?? d.paymentBasis, startsAt: iso(d.startsAt), endsAt: d.endsAt ? iso(d.endsAt) : null, billedVia: d.billedVia }]);
  }
  const revOfZone = new Map(zoneRev.map((r) => [String(r.zone_id), { revenue: n(r.revenue), imps: n(r.imps) }]));
  const zonesAt = new Map<string, { name: string }[]>();
  const money = new Map<string, { revenue: number; imps: number }>();
  const add = (k: string, v: { revenue: number; imps: number }) => { const cur = money.get(k) ?? { revenue: 0, imps: 0 }; money.set(k, { revenue: cur.revenue + v.revenue, imps: cur.imps + v.imps }); };
  const zonesOf = new Map<string, ZoneRow[]>();
  for (const z of zones) {
    const rv = revOfZone.get(z.id) ?? { revenue: 0, imps: 0 };
    zonesOf.set(z.siteId, [...(zonesOf.get(z.siteId) ?? []), { id: z.id, name: z.name, format: z.format, placementSlug: z.placementSlug, ...rv }]);
    if (!z.placementSlug) continue;
    const k = key(z.siteId, z.placementSlug);
    zonesAt.set(k, [...(zonesAt.get(k) ?? []), { name: z.name }]);
    add(k, rv);
  }
  for (const r of dealRev) add(key(String(r.site_id), String(r.slug)), { revenue: n(r.revenue), imps: n(r.imps) });
  const manualAt = new Map(manual.map((m) => [key(m.siteId, m.placementSlug), { use: m.use, note: m.note, network: m.network ? { id: m.network.id, slug: m.network.slug, title: m.network.title } : null }]));
  const bundlesOf = new Map<string, string[]>();
  for (const l of links) bundlesOf.set(l.siteId, [...(bundlesOf.get(l.siteId) ?? []), l.bundle.slug]);
  const rows = sites.map((s) => {
    const cells = Object.fromEntries(places.map((p) => [p.slug, resolvePlace({
      deals: dealsAt.get(key(s.id, p.slug)) ?? [], manual: manualAt.get(key(s.id, p.slug)), zones: zonesAt.get(key(s.id, p.slug)) ?? [],
      ...(money.get(key(s.id, p.slug)) ?? {}) })]));
    const zs = zonesOf.get(s.id) ?? [];
    return { id: s.id, domain: s.domain, bundles: (bundlesOf.get(s.id) ?? []).sort(), cells, free: Object.values(cells).filter((c) => c.use === "FREE").length,
      revenue: Object.values(cells).reduce((a, c) => a + c.revenue, 0), unmapped: zs.filter((z) => !z.placementSlug).length, zones: zs };
  });
  return {
    places: places.map((p) => ({ slug: p.slug, title: p.title, free: rows.filter((r) => r.cells[p.slug].use === "FREE").length,
      revenue: rows.reduce((a, r) => a + r.cells[p.slug].revenue, 0) })),
    sites: rows,
    revenue: rows.reduce((a, r) => a + r.revenue, 0),
  };
}

/** Deals the cell panel can attach: running and paused, with the sites they already cover. */
export async function attachableDeals(): Promise<{ id: string; title: string; advertiser: string; billedVia: string; siteIds: string[] }[]> {
  const deals = await db.deal.findMany({ where: { status: { in: ["ACTIVE", "PAUSED"] } }, include: { advertiser: true, sites: true }, orderBy: [{ advertiser: { name: "asc" } }, { title: "asc" }] });
  return deals.map((d) => ({ id: d.id, title: d.title, advertiser: d.advertiser.name, billedVia: d.billedVia, siteIds: d.sites.map((s) => s.siteId) }));
}

export interface InventoryDeal {
  id: string; title: string; advertiser: string; placements: string[]; sites: string[]; price: number; basis: string;
  startsAt: string; endsAt: string | null; daysLeft: number | null; status: string; billedVia: string;
}

/**
 * Every fix deal for the Formats tab: running and paused ones, plus deals that ended within the
 * last 30 days (greyed in the UI). Ending soonest first, open-ended after, ended at the bottom.
 */
export async function inventoryDeals(today = iso(new Date())): Promise<InventoryDeal[]> {
  const deals = await db.deal.findMany({
    where: { OR: [{ status: { in: ["ACTIVE", "PAUSED"] } }, { status: "ENDED", endsAt: { gte: D(iso(new Date(D(today).getTime() - 30 * 86_400_000))) } }] },
    include: { advertiser: true, places: { include: { placement: true } }, sites: { include: { site: true } } },
  });
  const rows = deals.map((d) => {
    const endsAt = d.endsAt ? iso(d.endsAt) : null;
    return { id: d.id, title: d.title, advertiser: d.advertiser.name, placements: [...new Set(d.places.map((p) => p.placement.title))].sort(), sites: d.sites.map((s) => s.site.domain).sort(),
      price: Number(d.price), basis: BASIS_LABEL[d.paymentBasis] ?? d.paymentBasis, startsAt: iso(d.startsAt), endsAt, daysLeft: daysLeft(endsAt, today),
      status: d.status, billedVia: d.billedVia };
  });
  const rank = (r: InventoryDeal) => (r.status === "ENDED" ? 2 : r.daysLeft == null ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.title.localeCompare(b.title));
}
