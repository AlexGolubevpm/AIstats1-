// Operating expenses: a figure per calendar month (hosting, people, software…), spread evenly
// over the month's days by v_opex_daily. docs/product/04-finance-and-deals.md#opex, ADR 0007.
import type { PrismaClient } from "@/generated/prisma/client";
import { RuleError, parseDecimal } from "@/server/domain/errors";

export const OPEX_CATEGORIES = ["HOSTING", "SALARY", "SOFTWARE", "CONTENT", "MARKETING", "OTHER"] as const;
export type OpexCategory = (typeof OPEX_CATEGORIES)[number];
export const OPEX_LABEL: Record<OpexCategory, string> = {
  HOSTING: "Хостинг и домены", SALARY: "Люди", SOFTWARE: "Сервисы и софт", CONTENT: "Контент", MARKETING: "Маркетинг", OTHER: "Прочее",
};

export interface OpexInput { month: string; title: string; category: string; amount: string; siteId?: string | null; note?: string | null }

export async function saveOpex(db: PrismaClient, i: OpexInput, id?: string): Promise<string> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(i.month)) throw new RuleError("month", "Укажите месяц", "month");
  if (!i.title.trim()) throw new RuleError("title", "Назовите расход", "title");
  if (!OPEX_CATEGORIES.includes(i.category as OpexCategory)) throw new RuleError("category", "Неизвестная категория", "category");
  const amount = parseDecimal(i.amount);
  if (!amount.isFinite() || amount.lte(0)) throw new RuleError("amount", "Сумма должна быть больше нуля", "amount");
  if (i.siteId && !(await db.site.findUnique({ where: { id: i.siteId } }))) throw new RuleError("site", "Сайт не найден", "siteId");
  const data = { month: new Date(`${i.month}-01T00:00:00Z`), title: i.title.trim(), category: i.category as OpexCategory,
    amount: amount.toFixed(2), siteId: i.siteId || null, note: i.note?.trim() || null };
  if (id) { await db.opexEntry.update({ where: { id }, data }); return id; }
  return (await db.opexEntry.create({ data })).id;
}

export async function deleteOpex(db: PrismaClient, id: string): Promise<void> {
  await db.opexEntry.delete({ where: { id } });
}
