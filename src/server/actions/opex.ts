"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";
import { deleteOpex, saveOpex } from "@/server/services/opex";
import { guarded, money, opt, str, type ActionResult } from "./result";

const touched = () => { revalidatePath("/finance"); revalidatePath("/"); };

export async function saveOpexAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await saveOpex(db, { month: str(f, "month"), title: str(f, "title"), category: str(f, "category"), amount: money(f, "amount"),
      siteId: opt(f, "siteId"), note: opt(f, "note") }, opt(f, "id") ?? undefined);
    touched();
    return { ok: true, message: "Расход сохранён" };
  });
}

export async function deleteOpexAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await deleteOpex(db, str(f, "id")); touched(); return { ok: true, message: "Расход удалён" }; });
}
