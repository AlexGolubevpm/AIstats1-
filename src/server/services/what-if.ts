// «Что если» on /forecast (ADR 0020 addendum): optimisations to weigh next to the plan — never in the plan or the facts
// unless moved there on purpose («В план» → a planned line of the plan, after which this one stops counting).
import type { PrismaClient } from "@/generated/prisma/client";
import { whatIfEffect, type WhatIfKind } from "@/lib/forecast";
import { RuleError, parseDecimal } from "@/server/domain/errors";
import { savePlanItem } from "./forecast-plan";

export const WHAT_IF_KINDS = ["OPEX", "TRAFFIC_SOURCE", "TRAFFIC_COST", "REVENUE", "OTHER_COST"] as const;
export const WHAT_IF_LABEL: Record<WhatIfKind, string> = {
  OPEX: "Опер. расход", TRAFFIC_SOURCE: "Источник трафика", TRAFFIC_COST: "Весь расход на трафик", REVENUE: "Выручка", OTHER_COST: "Другой расход",
};
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export interface WhatIfInputForm { title: string; kind: string; ref?: string | null; current: string; target: string; fromMonth: string; note?: string | null }

export async function saveWhatIf(db: PrismaClient, i: WhatIfInputForm, id?: string): Promise<string> {
  if (!WHAT_IF_KINDS.includes(i.kind as WhatIfKind)) throw new RuleError("kind", "Что меняем?", "kind");
  if (!MONTH.test(i.fromMonth)) throw new RuleError("fromMonth", "С какого месяца", "fromMonth");
  const current = parseDecimal(i.current), target = parseDecimal(i.target);
  if (!current.isFinite() || current.lt(0)) throw new RuleError("current", "Сейчас — сумма в месяц, не меньше нуля", "current");
  if (!target.isFinite() || target.lt(0)) throw new RuleError("target", "Станет — сумма в месяц, не меньше нуля", "target");
  if (current.equals(target)) throw new RuleError("target", "«Станет» совпадает с «сейчас» — эффекта нет", "target");
  const title = i.title.trim() || `${WHAT_IF_LABEL[i.kind as WhatIfKind]}${i.ref ? ` · ${i.ref}` : ""}`;
  const data = { title, kind: i.kind as WhatIfKind, ref: i.ref || null, current: current.toFixed(2), target: target.toFixed(2), fromMonth: new Date(`${i.fromMonth}-01T00:00:00Z`), note: i.note?.trim() || null };
  if (id) { await db.whatIf.update({ where: { id }, data }); return id; }
  return (await db.whatIf.create({ data })).id;
}

export async function toggleWhatIf(db: PrismaClient, id: string, active: boolean) { await db.whatIf.update({ where: { id }, data: { active } }); }
export async function deleteWhatIf(db: PrismaClient, id: string) { await db.whatIf.delete({ where: { id } }); }

/**
 * «В план»: the change becomes a planned line every month from its start — a cost cut as «экономия расходов», a revenue
 * gain as «рост выручки», a revenue drop as «новый расход» — and the «что если» stops counting so it is not added twice.
 */
export async function whatIfToPlan(db: PrismaClient, id: string, today = new Date().toISOString().slice(0, 10)): Promise<string> {
  const w = await db.whatIf.findUniqueOrThrow({ where: { id } });
  if (w.planItemId) throw new RuleError("plan", "Уже в плане");
  const effect = whatIfEffect({ kind: w.kind as WhatIfKind, current: Number(w.current), target: Number(w.target) });
  const kind = w.kind === "REVENUE" ? (effect > 0 ? "REVENUE" : "COST") : effect > 0 ? "SAVING" : "COST";
  const start = w.fromMonth.toISOString().slice(0, 7) < today.slice(0, 7) ? today.slice(0, 7) : w.fromMonth.toISOString().slice(0, 7);
  const planItemId = await savePlanItem(db, { month: start, kind, title: w.title, amount: Math.abs(effect).toFixed(2), recurring: true, note: `из «Что если»: ${Number(w.current)} → ${Number(w.target)} $/мес` }, undefined, today);
  await db.whatIf.update({ where: { id }, data: { planItemId, active: false } });
  return planItemId;
}
