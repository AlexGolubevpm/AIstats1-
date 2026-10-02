// Inventory: which ad place on which site is taken, by what, and which are free.
// Reference: docs/product/03-pages.md#inventory.

export type PlaceUse = "ROTATION" | "OWN_DEAL" | "FIX" | "CPA" | "FREE" | "NONE";
/** A deal as the grid shows it: who, for how much, from when to when. */
export interface PlaceDeal { id: string; title: string; advertiser: string; price: string; basis: string; startsAt: string; endsAt: string | null; billedVia: "DIRECT" | "VIA_ASG" }
export interface PlaceCell {
  use: PlaceUse; by: "deal" | "manual" | "zone" | "default"; label: string | null; deals: PlaceDeal[];
  /** Period revenue of the place on the site: zones mapped to it + direct fix deals with it. */
  revenue: number; imps: number;
}

/** Whole days from `today` to `endsAt`; null for an open-ended deal. */
export function daysLeft(endsAt: string | null, today: string): number | null {
  if (!endsAt) return null;
  return Math.round((new Date(`${endsAt}T00:00:00Z`).getTime() - new Date(`${today}T00:00:00Z`).getTime()) / 86_400_000);
}

export const USE_LABEL: Record<PlaceUse, string> = {
  ROTATION: "Ротация ASG", OWN_DEAL: "Own deal ASG", FIX: "Фикс", CPA: "CPA", FREE: "Свободно", NONE: "Нет места",
};

/** The owner's list of places present on every site; more can be added on the inventory page. */
export const DEFAULT_PLACEMENTS = [
  "Tablink 1", "Tablink 2", "Tablink 3", "Underplayer", "Video link 1", "Video link 2",
  "Under bar", "Above bar", "Welcome bar", "Video pause banner",
].map((title, i) => ({ slug: placementSlug(title), title, sortOrder: (i + 1) * 10 }));

export function placementSlug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "place";
}

/**
 * Zone name → place, e.g. "491410. Tablink 1 (site.com)" → tablink_1. Words of the place title
 * must appear in order as whole words (so "Tablink 1" does not match "Tablink 12"); the longest
 * matching title wins ("Video pause banner" over a hypothetical "Banner").
 */
export function matchPlacement(zoneName: string, places: { slug: string; title: string }[]): string | null {
  const name = zoneName.toLowerCase();
  let best: { slug: string; len: number } | null = null;
  for (const p of places) {
    const words = p.title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    if (!words.length) continue;
    const re = new RegExp(`(^|[^a-z0-9])${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s_-]*")}($|[^a-z0-9])`);
    if (re.test(name) && (!best || p.title.length > best.len)) best = { slug: p.slug, len: p.title.length };
  }
  return best?.slug ?? null;
}

/**
 * What occupies a place on a site. A running deal is authoritative (outside ASG → fix, inside →
 * own deal); then what the owner set by hand (CPA, no such place, …); then an AdSpyglass zone
 * mapped to the place → rotation; otherwise the place is free.
 */
export function resolvePlace(i: {
  deals: PlaceDeal[];
  manual?: { use: PlaceUse; note: string | null } | null;
  zones: { name: string }[];
  revenue?: number; imps?: number;
}): PlaceCell {
  const money = { revenue: i.revenue ?? 0, imps: i.imps ?? 0 };
  if (i.deals.length) {
    const fix = i.deals.filter((d) => d.billedVia === "DIRECT");
    return { use: fix.length ? "FIX" : "OWN_DEAL", by: "deal", label: i.deals.map((d) => `${d.advertiser} — ${d.title}`).join(", "), deals: i.deals, ...money };
  }
  if (i.manual) return { use: i.manual.use, by: "manual", label: i.manual.note, deals: [], ...money };
  if (i.zones.length) return { use: "ROTATION", by: "zone", label: i.zones.map((z) => z.name).join(", "), deals: [], ...money };
  return { use: "FREE", by: "default", label: null, deals: [], ...money };
}
