// The inventory grid: active sites × places, each cell resolved by domain/inventory.resolvePlace.
import { db } from "@/server/db";
import { resolvePlace, type PlaceCell } from "@/server/domain/inventory";

const D = (s: string) => new Date(`${s}T00:00:00Z`);

export interface InventoryGrid {
  places: { slug: string; title: string; free: number }[];
  sites: { id: string; domain: string; cells: Record<string, PlaceCell>; free: number }[];
}

export async function inventoryGrid(today = new Date().toISOString().slice(0, 10)): Promise<InventoryGrid> {
  const [places, sites, deals, zones, manual] = await Promise.all([
    db.placement.findMany({ orderBy: [{ sortOrder: "asc" }, { title: "asc" }] }),
    db.site.findMany({ where: { status: "ACTIVE" }, orderBy: { domain: "asc" } }),
    db.deal.findMany({ where: { placementSlug: { not: null }, status: { in: ["ACTIVE", "PAUSED"] }, startsAt: { lte: D(today) },
      OR: [{ endsAt: null }, { endsAt: { gte: D(today) } }] }, include: { sites: true } }),
    db.zone.findMany({ where: { placementSlug: { not: null }, isActive: true } }),
    db.sitePlacement.findMany(),
  ]);
  const key = (siteId: string, slug: string) => `${siteId}|${slug}`;
  const dealsAt = new Map<string, { id: string; title: string; billedVia: "DIRECT" | "VIA_ASG" }[]>();
  for (const d of deals) for (const s of d.sites) {
    const k = key(s.siteId, d.placementSlug!);
    dealsAt.set(k, [...(dealsAt.get(k) ?? []), { id: d.id, title: d.title, billedVia: d.billedVia }]);
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
