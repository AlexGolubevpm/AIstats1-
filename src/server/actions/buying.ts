"use server";
// «Окупаемость закупки» (/buying, ADR 0023): the ADOK filter check, the exact slice, the bids.
import { revalidatePath } from "next/cache";
import { addDays } from "@/lib/period";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { RuleError } from "@/server/domain/errors";
import { checkBuyingFilters, computeSlice, deleteBid, saveBid } from "@/server/services/buying";
import { requireSession } from "@/server/session";
import { guarded, money, str, type ActionResult } from "./result";

export async function checkBuyingFiltersAction(siteId: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    if (!siteId) throw new RuleError("site", "Выберите сайт");
    // the last full day: the nightly cuts of yesterday are in by the morning, today is partial
    const day = addDays(new Date().toISOString().slice(0, 10), -2);
    const r = await checkBuyingFilters(db, config(), siteId, day);
    revalidatePath("/buying");
    const found = [r.spots && "по форматам (зоны)", r.countries && "по странам (тиры)"].filter(Boolean);
    return { ok: true, data: { tried: r.tried },
      message: found.length ? `Фильтры найдены: ${found.join(", ")}. Теперь «Посчитать точно в ADOK»` : "ADOK не принял ни один фильтр — отчёт остаётся на оценке" };
  });
}

/** Computes the slice from ADOK (a few requests) and caches it. */
export async function computeSliceAction(i: { siteId: string; from: string; to: string; formats: string[] | null; tiers: number[] }): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const d = await computeSlice(db, config(), i);
    revalidatePath("/buying");
    return { ok: true, message: `Посчитано в ADOK: запросов ${d.requests}${d.notes.length ? `. ${d.notes.join("; ")}` : ""}` };
  });
}

export async function saveBidAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await saveBid(db, { sourceSlug: str(f, "sourceSlug"), siteId: f.get("allSites") === "1" ? null : str(f, "siteId") || null, tier: Number(str(f, "tier")),
      cpm: money(f, "cpm"), loadsPerVisit: money(f, "loadsPerVisit") || "1", validFrom: str(f, "validFrom") });
    revalidatePath("/buying");
    return { ok: true, message: "Ставка сохранена" };
  });
}

export async function deleteBidAction(id: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await deleteBid(db, id);
    revalidatePath("/buying");
    return { ok: true, message: "Ставка удалена" };
  });
}
