"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { addPlacement, setPlacementUse } from "@/server/services/inventory";
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
    await setPlacementUse(db, str(f, "siteId"), str(f, "slug"), str(f, "use"), opt(f, "note"));
    revalidatePath("/inventory");
    return { ok: true, message: "Сохранено" };
  });
}
