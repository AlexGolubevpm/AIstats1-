// The inventory grid: active sites × places, each cell resolved by domain/inventory.resolvePlace,
// and the list of every fix deal with who / how much / from / to (docs/product/03-pages.md#inventory).
import { db } from "@/server/db";
import { daysLeft, resolvePlace, type PlaceCell, type PlaceDeal } from "@/server/domain/inventory";
import { BASIS_LABEL } from "./deals";

const D = (s: string) => new Date(`${s}T00:00:00Z`);
const iso = (d: Date) => d.toISOString().slice(0, 10);

export interface InventoryGrid {
  places: { slug: string; title: string; free: number }[];
  sites: { id: string; domain: string; cells: Record<string, PlaceCell>; free: number }[];
}

export async function inventoryGrid(today = iso(new Date())): Promise<InventoryGrid> {
  const [places, sites, deals, zones, manual] = await Promise.all([
    db.placement.findMany({ orderBy: [{ sortOrder: "asc" }, { title: "asc" }] }),
    db.site.findMany({ where: { status: "ACTIVE" }, orderBy: { domain: "asc" } }),
    db.deal.findMany({ where: { placementSlug: { not: null }, status: { in: ["ACTIVE", "PAUSED"] }, startsAt: { lte: D(today) },
      OR: [{ endsAt: null }, { endsAt: { gte: D(today) } }] }, include: { sites: true, advertiser: true } }),
    db.zone.findMany({ where: { placementSlug: { not: null }, isActive: true } }),
    db.sitePlacement.findMany(),
  ]);
  const key = (siteId: string, slug: string) => `${siteId}|${slug}`;
  const dealsAt = new Map<string, PlaceDeal[]>();
  for (const d of deals) for (const s of d.sites) {
    const k = key(s.siteId, d.placementSlug!);
    dealsAt.set(k, [...(dealsAt.get(k) ?? []), { id: d.id, title: d.title, advertiser: d.advertiser.name, price: d.price.toString(),
      basis: BASIS_LABEL[d.paymentBasis] ?? d.paymentBasis, startsAt: iso(d.startsAt), endsAt: d.endsAt ? iso(d.endsAt) : null, billedVia: d.billedVia }]);
  }
  const zonesAt = new Map<string, { name: string }[]>();
  for (const z of zones) { const k = key(z.siteId, z.placementSlug!); zonesAt.set(k, [...(zonesAt.get(k) ?? []), { name: z.name }]); }
  const manualAt = new Map(manual.map((m) => [key(m.siteId, m.placementSlug), { use: m.use, note: m.note }]));
  const rows = sites.map((s) => {
    const cells = Object.fromEntries(places.map((p) => [p.slug, resolvePlace({
      deals: dealsAt.get(key(s.id, p.slug)) ?? [], manual: manualAt.get(key(s.id, p.slug)), zones: zonesAt.get(key(s.id, p.slug)) ?? [] })]));
    return { id: s.id, domain: s.domain, cells, free: Object.values(cells).filter((c) => c.use === "FREE").length };
  });
  return {
    places: places.map((p) => ({ slug: p.slug, title: p.title, free: rows.filter((r) => r.cells[p.slug].use === "FREE").length })),
    sites: rows,
  };
}

export interface InventoryDeal {
  id: string; title: string; advertiser: string; placement: string | null; sites: string[]; price: number; basis: string;
  startsAt: string; endsAt: string | null; daysLeft: number | null; status: string; billedVia: string;
}

/**
 * Every fix deal for the Formats tab: running and paused ones, plus deals that ended within the
 * last 30 days (greyed in the UI). Ending soonest first, open-ended after, ended at the bottom.
 */
export async function inventoryDeals(today = iso(new Date())): Promise<InventoryDeal[]> {
  const deals = await db.deal.findMany({
    where: { OR: [{ status: { in: ["ACTIVE", "PAUSED"] } }, { status: "ENDED", endsAt: { gte: D(iso(new Date(D(today).getTime() - 30 * 86_400_000))) } }] },
    include: { advertiser: true, placement: true, sites: { include: { site: true } } },
  });
  const rows = deals.map((d) => {
    const endsAt = d.endsAt ? iso(d.endsAt) : null;
    return { id: d.id, title: d.title, advertiser: d.advertiser.name, placement: d.placement?.title ?? null, sites: d.sites.map((s) => s.site.domain).sort(),
      price: Number(d.price), basis: BASIS_LABEL[d.paymentBasis] ?? d.paymentBasis, startsAt: iso(d.startsAt), endsAt, daysLeft: daysLeft(endsAt, today),
      status: d.status, billedVia: d.billedVia };
  });
  const rank = (r: InventoryDeal) => (r.status === "ENDED" ? 2 : r.daysLeft == null ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0) || a.title.localeCompare(b.title));
}
