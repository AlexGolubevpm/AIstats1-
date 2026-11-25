"use server";
// «Закупка T1/T2» (/buying, ADR 0023): finding the ADOK filters the report needs.
import { revalidatePath } from "next/cache";
import { addDays } from "@/lib/period";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { RuleError } from "@/server/domain/errors";
import { checkBuyingFilters } from "@/server/services/buying";
import { requireSession } from "@/server/session";
import { guarded, type ActionResult } from "./result";

export async function checkBuyingFiltersAction(siteId: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    if (!siteId) throw new RuleError("site", "Выберите сайт");
    // the last full day: the nightly cuts of yesterday are in by the morning, today is partial
    const day = addDays(new Date().toISOString().slice(0, 10), -2);
    const r = await checkBuyingFilters(db, config(), siteId, day);
    revalidatePath("/buying");
    const found = [r.spots && "попсы по странам", r.countries && "источники на T1/T2"].filter(Boolean);
    return { ok: true, data: { tried: r.tried },
      message: found.length ? `Фильтры найдены: ${found.join(", ")}. Разрезы включены — данные появятся после ночного прогона или бэкфилла`
        : "ADOK не принял ни один фильтр — отчёт остаётся на оценке" };
  });
}
