"use server";
import { revalidatePath } from "next/cache";
import { parseHorizon } from "@/lib/forecast";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";
import { copyOpexToMonth, deletePlanItem, resetPlanMonth, saveForecastPlan, savePlanItem, savePlanMonth } from "@/server/services/forecast-plan";
import { guarded, money, opt, str, type ActionResult } from "./result";

const touched = () => revalidatePath("/forecast");
/** A percentage typed by a person ("5", "-2,5", "") as a fraction. */
const pct = (f: FormData, k: string) => { const v = Number(money(f, k).replace("%", "") || "0"); return Number.isFinite(v) ? v / 100 : NaN; };

/** «Сценарий»: growth of the rotation and of the traffic cost per month, drafts in or out, the horizon. */
export async function saveForecastPlanAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  const revenueGrowth = pct(f, "revenueGrowth"), costGrowth = pct(f, "costGrowth");
  if (!Number.isFinite(revenueGrowth) || revenueGrowth < -0.5 || revenueGrowth > 1) return { error: "Рост — число процентов в месяц, от −50 до 100", field: "revenueGrowth" };
  if (!Number.isFinite(costGrowth) || costGrowth < -0.5 || costGrowth > 1) return { error: "Рост — число процентов в месяц, от −50 до 100", field: "costGrowth" };
  return guarded(async () => {
    await saveForecastPlan(db, { horizon: parseHorizon(str(f, "horizon")), revenueGrowth, costGrowth, includeDrafts: f.get("includeDrafts") === "1" });
    touched();
    return { ok: true, message: "Сценарий сохранён" };
  });
}

export async function savePlanItemAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const hypothesisId = opt(f, "hypothesisId");
    await savePlanItem(db, { month: str(f, "month"), kind: str(f, "kind"), title: str(f, "title"), amount: money(f, "amount"), siteId: opt(f, "siteId"), note: opt(f, "note"),
      recurring: f.get("recurring") === "1", untilMonth: opt(f, "untilMonth"), hypothesisId }, opt(f, "id") ?? undefined);
    touched();
    if (hypothesisId) revalidatePath(`/hypotheses/${hypothesisId}`);
    return { ok: true, message: "Статья сохранена" };
  });
}

export async function deletePlanItemAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await deletePlanItem(db, str(f, "id")); touched(); revalidatePath("/hypotheses/[id]", "page"); return { ok: true, message: "Статья удалена" }; });
}

/** The month panel form: one field per line (`line:<key>`); an empty field is «по умолчанию» (carried from the month before). */
export async function savePlanMonthAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const lines: Record<string, string | null> = {};
    for (const [k, v] of f.entries()) if (k.startsWith("line:")) lines[k.slice(5)] = money(f, k) || null;
    const n = await savePlanMonth(db, str(f, "month"), lines);
    touched();
    return { ok: true, message: n ? "Месяц сохранён — следующие месяцы берут его цифры" : "Изменений нет" };
  });
}

export async function resetPlanMonthAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => { await resetPlanMonth(db, str(f, "month")); touched(); return { ok: true, message: "Месяц как прошлый" }; });
}

export async function copyOpexAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const r = await copyOpexToMonth(db, str(f, "month"));
    touched(); revalidatePath("/finance");
    return { ok: true, message: `Скопировано ${r.count} ${r.count === 1 ? "расход" : "расходов"} из ${r.from}` };
  });
}
