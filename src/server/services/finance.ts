// AdSpyglass payouts: the money actually received for a month confirms mediated revenue.
// The received sum is spread over that month's geo rows pro rata to reported revenue,
// exact to 1/10000: the rounding remainder goes to the largest row. docs/product/04 §4.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import { DealRuleError } from "@/server/domain/deals";
import { parseDecimal } from "@/server/domain/errors";

const monthStart = (m: string) => new Date(`${m.slice(0, 7)}-01T00:00:00Z`);
const nextMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

export async function reportedAsgRevenue(db: PrismaClient, month: string): Promise<Decimal> {
  const from = monthStart(month);
  const r = await db.factRevenueGeo.aggregate({ _sum: { revenueReported: true }, where: { date: { gte: from, lt: nextMonth(from) } } });
  return new Decimal(r._sum.revenueReported?.toString() ?? 0);
}

/** Share of the month's payout that differs from reported revenue (0.03 = 3%). */
export const payoutDiff = (reported: Decimal.Value, received: Decimal.Value): number | null => {
  const r = new Decimal(reported);
  return r.isZero() ? null : new Decimal(received).minus(r).div(r).toNumber();
};

/**
 * Spreads a month's received payout over its FactRevenueGeo rows pro rata to reported revenue,
 * exact to 1/10000 (remainder on the largest row). Re-run after any re-ingest of a day in a
 * paid month: writeGeo recreates rows and would otherwise drop the confirmed amounts.
 */
export async function applyPayout(db: PrismaClient, month: string): Promise<boolean> {
  const from = monthStart(month), to = nextMonth(from);
  const payout = await db.asgPayout.findUnique({ where: { month: from } });
  if (!payout) return false;
  const reported = await reportedAsgRevenue(db, month);
  if (reported.isZero()) return false;
  const received = new Decimal(payout.amountReceived.toString()), ratio = received.div(reported);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "FactRevenueGeo" SET "revenueConfirmed" = ROUND("revenueReported" * ${ratio.toString()}::numeric, 4)
      WHERE date >= ${from} AND date < ${to}`;
    const [{ s }] = await tx.$queryRaw<{ s: string | null }[]>`SELECT SUM("revenueConfirmed")::text s FROM "FactRevenueGeo" WHERE date >= ${from} AND date < ${to}`;
    const rest = received.minus(s ?? 0);
    if (!rest.isZero()) {
      await tx.$executeRaw`UPDATE "FactRevenueGeo" SET "revenueConfirmed" = "revenueConfirmed" + ${rest.toString()}::numeric
        WHERE ctid = (SELECT ctid FROM "FactRevenueGeo" WHERE date >= ${from} AND date < ${to} ORDER BY "revenueReported" DESC LIMIT 1)`;
    }
  });
  return true;
}

/** Re-applies payouts of every paid month that the given dates touch (called after ingest writes). */
export async function reapplyPayouts(db: PrismaClient, dates: string[]): Promise<number> {
  const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
  let n = 0;
  for (const m of months) if (await applyPayout(db, m)) n++;
  return n;
}

export async function recordAsgPayout(db: PrismaClient, input: { month: string; amountReceived: string; receivedAt: string; note?: string | null }): Promise<{ reported: string; diff: number | null }> {
  if (!/^\d{4}-\d{2}/.test(input.month)) throw new DealRuleError("month", "Укажите месяц", "month");
  const received = parseDecimal(input.amountReceived);
  if (!received.isFinite() || received.isNegative()) throw new DealRuleError("amount", "Сумма должна быть неотрицательным числом", "amountReceived");
  const from = monthStart(input.month);
  const reported = await reportedAsgRevenue(db, input.month);
  if (reported.isZero()) throw new DealRuleError("empty", "За этот месяц нет выручки AdSpyglass — нечего подтверждать", "month");
  await db.$transaction(async (tx) => {
    const data = { amountReported: reported.toString(), amountReceived: received.toString(), receivedAt: new Date(`${input.receivedAt}T00:00:00Z`), note: input.note || null };
    await tx.asgPayout.upsert({ where: { month: from }, create: { month: from, ...data }, update: data });
    await tx.auditLog.create({ data: { entity: "AsgPayout", entityId: input.month.slice(0, 7), field: "payout", after: received.toString(), reason: input.note || null } });
  });
  await applyPayout(db, input.month);
  return { reported: reported.toString(), diff: payoutDiff(reported, received) };
}
