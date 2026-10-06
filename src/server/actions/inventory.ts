"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { addPlacement, attachDealPlaces, detachDealPlace, setPlacementUse, setZonePlacement } from "@/server/services/inventory";
import { requireSession } from "@/server/session";
import { guarded, opt, str, type ActionResult } from "./result";

export async function addPlacementAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await addPlacement(db, str(f, "title"));
    revalidatePath("/inventory");
    return { ok: true, message: "Формат добавлен" };
  });
}

export async function setPlacementUseAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await setPlacementUse(db, str(f, "siteId"), str(f, "slug"), str(f, "use") || "AUTO", opt(f, "note"), opt(f, "networkId"));
    revalidatePath("/inventory");
    return { ok: true, message: "Сохранено" };
  });
}

export async function attachDealPlacesAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const n = await attachDealPlaces(db, str(f, "siteId"), str(f, "slug"), f.getAll("dealIds").map(String));
    revalidatePath("/inventory");
    revalidatePath("/deals");
    return { ok: true, message: n === 1 ? "Дил привязан к месту" : `Привязано дилов: ${n}` };
  });
}

export async function detachDealPlaceAction(siteId: string, slug: string, dealId: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await detachDealPlace(db, siteId, slug, dealId);
    revalidatePath("/inventory");
    revalidatePath("/deals");
    return { ok: true, message: "Дил убран с места" };
  });
}

export async function setZonePlacementAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await setZonePlacement(db, str(f, "zoneId"), opt(f, "slug"));
    revalidatePath("/inventory");
    const domain = opt(f, "domain");
    if (domain) revalidatePath(`/sites/${domain}`);
    return { ok: true, message: "Формат зоны сохранён" };
  });
}
