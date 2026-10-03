// Inventory: the place catalog, zone → place mapping and the owner's manual states.
import type { PrismaClient } from "@/generated/prisma/client";
import { RuleError } from "@/server/domain/errors";
import { matchPlacement, placementSlug, type PlaceUse } from "@/server/domain/inventory";

/** Maps zones without a place to one by their name. Never overrides a mapping already set. */
export async function matchZonesToPlacements(db: PrismaClient): Promise<number> {
  const places = await db.placement.findMany();
  if (!places.length) return 0;
  let n = 0;
  for (const z of await db.zone.findMany({ where: { placementSlug: null } })) {
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

/** Sets the place's state on a site by hand; "AUTO" removes it (deals and zones decide again). */
export async function setPlacementUse(db: PrismaClient, siteId: string, slug: string, use: string, note?: string | null): Promise<void> {
  if (use === "AUTO") { await db.sitePlacement.deleteMany({ where: { siteId, placementSlug: slug } }); return; }
  if (!USES.includes(use as PlaceUse)) throw new RuleError("use", "Неизвестное состояние", "use");
  await db.sitePlacement.upsert({ where: { siteId_placementSlug: { siteId, placementSlug: slug } },
    create: { siteId, placementSlug: slug, use: use as PlaceUse, note: note?.trim() || null }, update: { use: use as PlaceUse, note: note?.trim() || null } });
}
