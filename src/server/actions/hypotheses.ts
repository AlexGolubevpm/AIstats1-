"use server";
import { revalidatePath } from "next/cache";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";
import { OWN_STATUS_LABEL, OWN_STATUSES, type OwnStatus } from "@/server/domain/hypotheses";
import { createHypothesis, hypothesisFromAlert, setHypothesisStatus, setOwnStatus, updateHypothesis, type HypothesisTransition } from "@/server/services/hypotheses";
import { guarded, money, opt, str, type ActionResult } from "./result";

const touched = () => { revalidatePath("/hypotheses"); revalidatePath("/hypotheses/[id]", "page"); revalidatePath("/alerts"); revalidatePath("/"); revalidatePath("/sites/[domain]", "page"); };

const input = (f: FormData) => ({ title: str(f, "title"), hypothesis: str(f, "hypothesis"), bundleId: opt(f, "bundleId"), siteId: opt(f, "siteId"), format: opt(f, "format"),
  countryCode: opt(f, "countryCode"), impactMonth: opt(f, "impactMonth") ? money(f, "impactMonth") : null, metric: opt(f, "metric") });

export async function createHypothesisAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await createHypothesis(db, input(f));
    touched();
    return { ok: true, message: "Гипотеза добавлена в «Наши» со статусом «Тест»" };
  });
}

/** The hypothesis page form: own ones — every field; system ones — the note only. */
export async function updateHypothesisAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await updateHypothesis(db, str(f, "id"), { ...input(f), note: opt(f, "note") });
    touched();
    return { ok: true, message: "Сохранено" };
  });
}

export async function ownHypothesisStatusAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  const to = str(f, "to") as OwnStatus;
  if (!OWN_STATUSES.includes(to)) return { error: "Неизвестный статус" };
  return guarded(async () => {
    await setOwnStatus(db, str(f, "id"), to);
    touched();
    return { ok: true, message: `Статус: ${OWN_STATUS_LABEL[to]}` };
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
