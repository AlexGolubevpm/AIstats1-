// Inventory: which ad place on which site is taken, by what, and which are free.
// Reference: docs/product/03-pages.md#inventory.

export type PlaceUse = "ROTATION" | "OWN_DEAL" | "FIX" | "CPA" | "FREE" | "NONE";
/** A deal as the grid shows it: who, for how much, from when to when. */
export interface PlaceDeal { id: string; title: string; advertiser: string; price: string; basis: string; startsAt: string; endsAt: string | null; billedVia: "DIRECT" | "VIA_ASG" }
/** The ad network the owner says buys the place (a note, not an ADOK fact). */
export interface PlaceNetwork { id: string; slug: string; title: string }
export interface PlaceCell {
  use: PlaceUse; by: "deal" | "manual" | "zone" | "default"; label: string | null; deals: PlaceDeal[]; network: PlaceNetwork | null;
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

/**
 * The owner's list of places, the same on every site (ADR 0012); more can be added on the
 * inventory page. AdSpyglass zones are mapped onto these by the type in their name.
 */
export const DEFAULT_PLACEMENTS = [
  "Tablink 1", "Tablink 2", "Tablink 3", "Underplayer", "Video link 1", "Video link 2",
  "Under bar", "Above bar", "Welcome bar", "Video pause banner",
  "Pop", "Slider", "NTV A", "NTV B", "Footer A", "Footer B", "Footer C", "Footer D", "OutStream", "InVideo", "Push",
].map((title, i) => ({ slug: placementSlug(title), title, sortOrder: (i + 1) * 10 }));

export function placementSlug(title: string): string {
  return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "place";
}

/**
 * Zone names in ADOK carry a site prefix ("GX_NTV_A", "HS_OutStream", "GXhub_Slider", "footer_1",
 * "POP player"): the type after the prefix decides the place. Each rule is a regex over the
 * lower-cased name with the prefix removed; first match wins, the generic word match below is the fallback.
 */
const ZONE_RULES: [RegExp, string][] = [
  [/^tablink[\s_-]*1(?![0-9])/, "tablink_1"], [/^tablink[\s_-]*2(?![0-9])/, "tablink_2"], [/^tablink[\s_-]*3(?![0-9])/, "tablink_3"],
  [/^underplayer|^under[\s_-]*player/, "underplayer"],
  [/^video[\s_-]*link[\s_-]*1(?![0-9])/, "video_link_1"], [/^video[\s_-]*link[\s_-]*2(?![0-9])/, "video_link_2"],
  [/^under[\s_-]*bar/, "under_bar"], [/^above[\s_-]*bar/, "above_bar"], [/^welcome[\s_-]*bar/, "welcome_bar"],
  [/^video[\s_-]*pause/, "video_pause_banner"],
  [/^pop|popunder|^tabunder/, "pop"],
  [/^slider/, "slider"],
  [/^ntv[\s_-]*(a|1)(?![a-z0-9])/, "ntv_a"], [/^ntv[\s_-]*(b|2)(?![a-z0-9])/, "ntv_b"], [/^native[\s_-]*(a|1)(?![a-z0-9])/, "ntv_a"], [/^native[\s_-]*(b|2)(?![a-z0-9])/, "ntv_b"],
  [/^(banners?[\s_-]*)?footer[\s_-]*(a|1)(?![a-z0-9])/, "footer_a"], [/^(banners?[\s_-]*)?footer[\s_-]*(b|2)(?![a-z0-9])/, "footer_b"],
  [/^(banners?[\s_-]*)?footer[\s_-]*(c|3)(?![a-z0-9])/, "footer_c"], [/^(banners?[\s_-]*)?footer[\s_-]*(d|4)(?![a-z0-9])/, "footer_d"],
  [/^outstream|^out[\s_-]*stream/, "outstream"],
  [/^invideo|^in[\s_-]*video|^instream|^preroll|vast/, "invideo"],
  [/^inpp|^in[\s_-]*page[\s_-]*push|^push/, "push"],
];

/** "GX_NTV_A" → "ntv_a", "GXhub_Slider" → "slider", "491. HS_InPP (site.com)" → "inpp": lower-case, no id/domain, no site prefix. */
export function zoneTypeName(zoneName: string): string {
  let n = zoneName.toLowerCase().replace(/^\d+\.\s*/, "").replace(/\s*\([^()]*\)\s*$/, "").trim();
  // A short alphanumeric site prefix ("gx_", "hs_", "gxhub_") before a type that still has letters.
  const m = n.match(/^([a-z0-9]{1,8})_(.+)$/);
  if (m && /[a-z]/.test(m[2]) && !/^(tablink|video|under|above|welcome|ntv|native|footer|pop|out|in|banners?)$/.test(m[1])) n = m[2];
  return n;
}

/**
 * Zone name → place. First the type rules (ZONE_RULES) on the name without its site prefix, then
 * the words of a place title appearing in order as whole words ("Tablink 1" does not match
 * "Tablink 12"; the longest matching title wins). Only places that exist are returned.
 */
export function matchPlacement(zoneName: string, places: { slug: string; title: string }[]): string | null {
  const have = new Set(places.map((p) => p.slug));
  const type = zoneTypeName(zoneName);
  for (const [re, slug] of ZONE_RULES) if (re.test(type) && have.has(slug)) return slug;
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
  manual?: { use: PlaceUse; note: string | null; network?: PlaceNetwork | null } | null;
  zones: { name: string }[];
  revenue?: number; imps?: number;
}): PlaceCell {
  const money = { revenue: i.revenue ?? 0, imps: i.imps ?? 0 };
  const network = i.manual?.network ?? null;
  if (i.deals.length) {
    const fix = i.deals.filter((d) => d.billedVia === "DIRECT");
    return { use: fix.length ? "FIX" : "OWN_DEAL", by: "deal", label: i.deals.map((d) => `${d.advertiser} — ${d.title}`).join(", "), deals: i.deals, network, ...money };
  }
  if (i.manual) return { use: i.manual.use, by: "manual", label: i.manual.note || network?.title || null, deals: [], network, ...money };
  if (i.zones.length) return { use: "ROTATION", by: "zone", label: i.zones.map((z) => z.name).join(", "), deals: [], network: null, ...money };
  return { use: "FREE", by: "default", label: null, deals: [], network: null, ...money };
}

/** Cell text in the grid: money if any, else who is there (one deal — advertiser, more — a count), else the network, else the state. */
export function cellText(c: PlaceCell, moneyText: string | null, short: Record<PlaceUse, string>): string {
  if (moneyText) return moneyText;
  if (c.deals.length === 1) return c.deals[0].advertiser;
  if (c.deals.length > 1) return `${c.deals.length} фикс-дила`;
  if (c.network) return c.network.title;
  return short[c.use];
}
