"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";
import { createHypothesis, hypothesisFromAlert, setHypothesisStatus, type HypothesisTransition } from "@/server/services/hypotheses";
import { guarded, money, opt, str, type ActionResult } from "./result";

const touched = () => { revalidatePath("/hypotheses"); revalidatePath("/alerts"); revalidatePath("/"); };

export async function createHypothesisAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await createHypothesis(db, { title: str(f, "title"), hypothesis: str(f, "hypothesis"), bundleId: opt(f, "bundleId"), siteId: opt(f, "siteId"), format: opt(f, "format"),
      countryCode: opt(f, "countryCode"), impactMonth: opt(f, "impactMonth") ? money(f, "impactMonth") : null, metric: opt(f, "metric") });
    touched();
    return { ok: true, message: "Гипотеза добавлена" };
  });
}

const MESSAGE: Record<HypothesisTransition, string> = { ACCEPTED: "Гипотеза в работе — базовое значение метрики зафиксировано", DONE: "Гипотеза проверена", REJECTED: "Гипотеза отклонена", PROPOSED: "Гипотеза возвращена" };

export async function hypothesisStatusAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const to = str(f, "to") as HypothesisTransition;
    if (!["ACCEPTED", "DONE", "REJECTED", "PROPOSED"].includes(to)) return { error: "Неизвестный статус" };
    await setHypothesisStatus(db, str(f, "id"), to, opt(f, "note"));
    touched();
    return { ok: true, message: MESSAGE[to] };
  });
}

export async function hypothesisFromAlertAction(alertId: string): Promise<void> {
  await requireSession();
  await hypothesisFromAlert(db, alertId);
  touched();
}
