// The plan for the months ahead (ADR 0020): the scenario (growth per month, drafts in or out, horizon)
// and planned lines of future months. Read by /forecast «На месяцы вперёд» and MCP get_forecast.
import type { PrismaClient } from "@/generated/prisma/client";
import { parseHorizon, type Horizon, type PlanScenario } from "@/lib/forecast";
import { RuleError, parseDecimal } from "@/server/domain/errors";

export const PLAN_KEY = "forecast_plan";
export interface ForecastPlan extends PlanScenario { horizon: Horizon }
export const DEFAULT_FORECAST_PLAN: ForecastPlan = { horizon: 6, revenueGrowth: 0, costGrowth: 0, includeDrafts: false };

/** Growth is stored as a fraction per month; anything outside −50…+100% is a typo, not a plan. */
const growth = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? Math.min(1, Math.max(-0.5, x)) : 0; };

export function normalizeForecastPlan(raw: unknown): ForecastPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return { horizon: parseHorizon(r.horizon as number, DEFAULT_FORECAST_PLAN.horizon), revenueGrowth: growth(r.revenueGrowth), costGrowth: growth(r.costGrowth), includeDrafts: r.includeDrafts === true };
}

export async function readForecastPlan(db: PrismaClient): Promise<ForecastPlan> {
  const row = await db.appSetting.findUnique({ where: { key: PLAN_KEY } });
  if (!row) return DEFAULT_FORECAST_PLAN;
  try { return normalizeForecastPlan(JSON.parse(row.value)); } catch { return DEFAULT_FORECAST_PLAN; }
}

export async function saveForecastPlan(db: PrismaClient, plan: ForecastPlan): Promise<ForecastPlan> {
  const p = normalizeForecastPlan(plan);
  const before = await db.appSetting.findUnique({ where: { key: PLAN_KEY } });
  const value = JSON.stringify(p);
  await db.$transaction([
    db.appSetting.upsert({ where: { key: PLAN_KEY }, create: { key: PLAN_KEY, value }, update: { value } }),
    db.auditLog.create({ data: { entity: "AppSetting", entityId: PLAN_KEY, field: "scenario", before: before?.value ?? null, after: value } }),
  ]);
  return p;
}

export const PLAN_ITEM_KINDS = ["REVENUE", "COST", "SAVING"] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];
export const PLAN_ITEM_LABEL: Record<PlanItemKind, string> = { REVENUE: "Рост выручки", COST: "Новый расход", SAVING: "Экономия расходов" };
export interface PlanItemInput {
  month: string; kind: string; title: string; amount: string; siteId?: string | null; note?: string | null;
  /** Every month from `month` (up to `untilMonth` when given), not just the one. */
  recurring?: boolean; untilMonth?: string | null; hypothesisId?: string | null;
}
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** A planned line of a month: the current one or later (the past already has facts). */
export async function savePlanItem(db: PrismaClient, i: PlanItemInput, id?: string, today = new Date().toISOString().slice(0, 10)): Promise<string> {
  if (!MONTH.test(i.month)) throw new RuleError("month", "Укажите месяц", "month");
  const before = id ? await db.planItem.findUniqueOrThrow({ where: { id } }) : null;
  // A new line starts this month or later; a repeating one that already runs keeps its start when edited.
  if (i.month < today.slice(0, 7) && before?.month.toISOString().slice(0, 7) !== i.month) throw new RuleError("month", "Плановая статья — на текущий месяц или вперёд", "month");
  const until = i.recurring && i.untilMonth ? i.untilMonth : null;
  if (until && (!MONTH.test(until) || until < i.month)) throw new RuleError("untilMonth", "«По» — месяц не раньше начала", "untilMonth");
  if (i.hypothesisId && !(await db.hypothesis.findUnique({ where: { id: i.hypothesisId } }))) throw new RuleError("hypothesis", "Гипотеза не найдена", "hypothesisId");
  if (!PLAN_ITEM_KINDS.includes(i.kind as PlanItemKind)) throw new RuleError("kind", "Доход или расход", "kind");
  if (!i.title.trim()) throw new RuleError("title", "Назовите статью", "title");
  const amount = parseDecimal(i.amount);
  if (!amount.isFinite() || amount.lte(0)) throw new RuleError("amount", "Сумма должна быть больше нуля", "amount");
  if (i.siteId && !(await db.site.findUnique({ where: { id: i.siteId } }))) throw new RuleError("site", "Сайт не найден", "siteId");
  const data = { month: new Date(`${i.month}-01T00:00:00Z`), recurring: Boolean(i.recurring), untilMonth: until ? new Date(`${until}-01T00:00:00Z`) : null,
    kind: i.kind as PlanItemKind, title: i.title.trim(), amount: amount.toFixed(2), siteId: i.siteId || null, hypothesisId: i.hypothesisId || null, note: i.note?.trim() || null };
  const saved = id ? await db.planItem.update({ where: { id }, data }) : await db.planItem.create({ data });
  const show = (x: { month: Date; recurring: boolean; untilMonth: Date | null; kind: string; title: string; amount: unknown }) =>
    `${x.month.toISOString().slice(0, 7)}${x.recurring ? `…${x.untilMonth ? x.untilMonth.toISOString().slice(0, 7) : ""}` : ""} · ${x.kind} · ${x.title} · ${String(x.amount)}`;
  await db.auditLog.create({ data: { entity: "PlanItem", entityId: saved.id, field: id ? "updated" : "created", before: before ? show(before) : null, after: show(saved) } });
  return saved.id;
}

export async function deletePlanItem(db: PrismaClient, id: string): Promise<void> {
  const x = await db.planItem.findUniqueOrThrow({ where: { id } });
  await db.planItem.delete({ where: { id } });
  await db.auditLog.create({ data: { entity: "PlanItem", entityId: id, field: "deleted", before: `${x.month.toISOString().slice(0, 7)} · ${x.kind} · ${x.title} · ${String(x.amount)}`, after: null } });
}

// ---------- The month chain (ADR 0020, 2026-10-30) ----------

export const LINE_LABEL: Record<string, string> = { rotation: "Ротация ASG", traffic_cost: "Расход на трафик" };

/**
 * A future month's own figures: `{ line → amount | null }`, null = no edit (the month carries the one before).
 * Only months after the current one: the current month is data. Each change is a line in the audit log.
 */
export async function savePlanMonth(db: PrismaClient, month: string, lines: Record<string, string | null>, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  if (!MONTH.test(month)) throw new RuleError("month", "Укажите месяц", "month");
  if (month <= today.slice(0, 7)) throw new RuleError("month", "Править можно месяцы после текущего — текущий месяц это данные", "month");
  const date = new Date(`${month}-01T00:00:00Z`);
  const existing = new Map((await db.planMonthOverride.findMany({ where: { month: date } })).map((o) => [o.line, o]));
  let changed = 0;
  for (const [line, raw] of Object.entries(lines)) {
    if (line !== "rotation" && line !== "traffic_cost" && !line.startsWith("deal:")) throw new RuleError("line", "Неизвестная строка плана");
    if (line.startsWith("deal:") && !(await db.deal.findUnique({ where: { id: line.slice(5) } }))) throw new RuleError("line", "Дил не найден");
    const before = existing.get(line);
    if (raw == null || raw === "") {
      if (!before) continue;
      await db.planMonthOverride.delete({ where: { id: before.id } });
      await db.auditLog.create({ data: { entity: "PlanMonth", entityId: month, field: line, before: before.amount.toString(), after: null, reason: "по умолчанию" } });
      changed++;
      continue;
    }
    const v = parseDecimal(raw);
    if (!v.isFinite() || v.lt(0)) throw new RuleError(line, "Сумма — число не меньше нуля", line);
    if (before && before.amount.equals(v.toDecimalPlaces(2))) continue;
    await db.planMonthOverride.upsert({ where: { month_line: { month: date, line } }, create: { month: date, line, amount: v.toFixed(2) }, update: { amount: v.toFixed(2) } });
    await db.auditLog.create({ data: { entity: "PlanMonth", entityId: month, field: line, before: before?.amount.toString() ?? null, after: v.toFixed(2) } });
    changed++;
  }
  return changed;
}

/** Back to «как прошлый месяц» for every line of the month. */
export async function resetPlanMonth(db: PrismaClient, month: string): Promise<number> {
  const date = new Date(`${month}-01T00:00:00Z`);
  const rows = await db.planMonthOverride.findMany({ where: { month: date } });
  if (!rows.length) return 0;
  await db.planMonthOverride.deleteMany({ where: { month: date } });
  await db.auditLog.createMany({ data: rows.map((o) => ({ entity: "PlanMonth", entityId: month, field: o.line, before: o.amount.toString(), after: null, reason: "сброс месяца" })) });
  return rows.length;
}

/**
 * «Скопировать опер. расходы из прошлого месяца»: the entries of the last month that has any, copied onto `month`
 * (which must have none yet) — then the month owns them and can be edited line by line.
 */
export async function copyOpexToMonth(db: PrismaClient, month: string, today = new Date().toISOString().slice(0, 10)): Promise<{ from: string; count: number }> {
  if (!MONTH.test(month)) throw new RuleError("month", "Укажите месяц", "month");
  if (month < today.slice(0, 7)) throw new RuleError("month", "Копировать можно в текущий месяц или вперёд", "month");
  const date = new Date(`${month}-01T00:00:00Z`);
  if (await db.opexEntry.count({ where: { month: date } })) throw new RuleError("month", "На этот месяц расходы уже внесены — правьте их по одному", "month");
  const last = await db.opexEntry.findFirst({ where: { month: { lt: date } }, orderBy: { month: "desc" } });
  if (!last) throw new RuleError("month", "Нет месяца с внесёнными расходами, чтобы скопировать", "month");
  const src = await db.opexEntry.findMany({ where: { month: last.month } });
  await db.opexEntry.createMany({ data: src.map((e) => ({ month: date, title: e.title, category: e.category, amount: e.amount, siteId: e.siteId, note: e.note })) });
  await db.auditLog.create({ data: { entity: "PlanMonth", entityId: month, field: "opex", before: null, after: `скопировано ${src.length} из ${last.month.toISOString().slice(0, 7)}` } });
  return { from: last.month.toISOString().slice(0, 7), count: src.length };
}
