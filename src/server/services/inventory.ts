// Inventory: the place catalog, zone → place mapping and the owner's manual states.
import type { PrismaClient } from "@/generated/prisma/client";
import { RuleError } from "@/server/domain/errors";
import { matchPlacement, placementSlug, type PlaceUse } from "@/server/domain/inventory";

/**
 * Maps every active zone without a place onto the catalog by the type in its name (ADR 0012):
 * "GX_NTV_A" → NTV A, "HS_OutStream" → OutStream, "footer_1" → Footer A. Zones no rule knows stay
 * unmapped for the owner to place by hand; the catalog itself does not grow from zone names (a
 * site prefix per zone would make a column per site). A mapping already set is never overridden.
 * Returns the number of zones mapped.
 */
export async function matchZonesToPlacements(db: PrismaClient): Promise<number> {
  const unmapped = await db.zone.findMany({ where: { placementSlug: null, isActive: true } });
  if (!unmapped.length) return 0;
  const places = await db.placement.findMany();
  let n = 0;
  for (const z of unmapped) {
    const slug = matchPlacement(z.name, places);
    if (slug) { await db.zone.update({ where: { id: z.id }, data: { placementSlug: slug } }); n++; }
  }
  return n;
}

export async function addPlacement(db: PrismaClient, title: string): Promise<string> {
  const t = title.trim();
  if (!t) throw new RuleError("title", "Укажите название формата", "title");
  const slug = placementSlug(t);
  if (await db.placement.findUnique({ where: { slug } })) throw new RuleError("exists", "Такой формат уже есть", "title");
  const last = await db.placement.aggregate({ _max: { sortOrder: true } });
  await db.placement.create({ data: { slug, title: t, sortOrder: (last._max.sortOrder ?? 0) + 10 } });
  await matchZonesToPlacements(db);
  return slug;
}

/** Maps a zone to a place by hand (null = no place). Automatic matching never overrides it. */
export async function setZonePlacement(db: PrismaClient, zoneId: string, slug: string | null): Promise<void> {
  if (slug && !(await db.placement.findUnique({ where: { slug } }))) throw new RuleError("placement", "Формат не найден", "placementSlug");
  await db.zone.update({ where: { id: zoneId }, data: { placementSlug: slug } });
}

const USES: PlaceUse[] = ["ROTATION", "OWN_DEAL", "FIX", "CPA", "FREE", "NONE"];

/**
 * Sets the place's state on a site by hand; "AUTO" removes it (deals and zones decide again).
 * `networkId` names the ad network that buys the place; with a network and no explicit state the
 * place counts as an own deal inside AdSpyglass (DIRECT networks) or rotation (mediated ones).
 */
export async function setPlacementUse(db: PrismaClient, siteId: string, slug: string, use: string, note?: string | null, networkId?: string | null): Promise<void> {
  if (use === "AUTO" && !networkId) { await db.sitePlacement.deleteMany({ where: { siteId, placementSlug: slug } }); return; }
  const network = networkId ? await db.network.findUnique({ where: { id: networkId } }) : null;
  if (networkId && !network) throw new RuleError("network", "Сетка не найдена", "networkId");
  const resolved = use === "AUTO" ? (network!.kind === "DIRECT" ? "OWN_DEAL" : "ROTATION") : use;
  if (!USES.includes(resolved as PlaceUse)) throw new RuleError("use", "Неизвестное состояние", "use");
  const data = { use: resolved as PlaceUse, note: note?.trim() || null, networkId: network?.id ?? null };
  await db.sitePlacement.upsert({ where: { siteId_placementSlug: { siteId, placementSlug: slug } }, create: { siteId, placementSlug: slug, ...data }, update: data });
}

/** Puts deals on a place of a site (several deals may share a cell, e.g. split by geo tier). A deal not yet on the site joins it. */
export async function attachDealPlaces(db: PrismaClient, siteId: string, slug: string, dealIds: string[]): Promise<number> {
  const ids = [...new Set(dealIds.filter(Boolean))];
  if (!ids.length) throw new RuleError("deals", "Выберите хотя бы один дил", "dealIds");
  if (!(await db.placement.findUnique({ where: { slug } }))) throw new RuleError("placement", "Место не найдено", "slug");
  if (!(await db.site.findUnique({ where: { id: siteId } }))) throw new RuleError("site", "Сайт не найден", "siteId");
  if ((await db.deal.count({ where: { id: { in: ids } } })) !== ids.length) throw new RuleError("deals", "Дил не найден", "dealIds");
  await db.$transaction(async (tx) => {
    for (const dealId of ids) {
      await tx.dealSite.upsert({ where: { dealId_siteId: { dealId, siteId } }, create: { dealId, siteId }, update: {} });
      await tx.dealPlace.upsert({ where: { dealId_siteId_placementSlug: { dealId, siteId, placementSlug: slug } }, create: { dealId, siteId, placementSlug: slug }, update: {} });
    }
  });
  return ids.length;
}

/** Takes a deal off a place of a site; the deal keeps the site. */
export async function detachDealPlace(db: PrismaClient, siteId: string, slug: string, dealId: string): Promise<void> {
  await db.dealPlace.deleteMany({ where: { dealId, siteId, placementSlug: slug } });
}
