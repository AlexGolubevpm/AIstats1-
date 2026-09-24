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

export async function recordAsgPayout(db: PrismaClient, input: { month: string; amountReceived: string; receivedAt: string; note?: string | null }): Promise<{ reported: string; diff: number | null }> {
  if (!/^\d{4}-\d{2}/.test(input.month)) throw new DealRuleError("month", "Укажите месяц", "month");
  const received = parseDecimal(input.amountReceived);
  if (!received.isFinite() || received.isNegative()) throw new DealRuleError("amount", "Сумма должна быть неотрицательным числом", "amountReceived");
  const from = monthStart(input.month), to = nextMonth(from);
  const reported = await reportedAsgRevenue(db, input.month);
  if (reported.isZero()) throw new DealRuleError("empty", "За этот месяц нет выручки AdSpyglass — нечего подтверждать", "month");
  const ratio = received.div(reported);
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE "FactRevenueGeo" SET "revenueConfirmed" = ROUND("revenueReported" * ${ratio.toString()}::numeric, 4)
      WHERE date >= ${from} AND date < ${to}`;
    const [{ s }] = await tx.$queryRaw<{ s: string | null }[]>`SELECT SUM("revenueConfirmed")::text s FROM "FactRevenueGeo" WHERE date >= ${from} AND date < ${to}`;
    const rest = received.minus(s ?? 0);
    if (!rest.isZero()) {
      await tx.$executeRaw`UPDATE "FactRevenueGeo" SET "revenueConfirmed" = "revenueConfirmed" + ${rest.toString()}::numeric
        WHERE ctid = (SELECT ctid FROM "FactRevenueGeo" WHERE date >= ${from} AND date < ${to} ORDER BY "revenueReported" DESC LIMIT 1)`;
    }
    const data = { amountReported: reported.toString(), amountReceived: received.toString(), receivedAt: new Date(`${input.receivedAt}T00:00:00Z`), note: input.note || null };
    await tx.asgPayout.upsert({ where: { month: from }, create: { month: from, ...data }, update: data });
    await tx.auditLog.create({ data: { entity: "AsgPayout", entityId: input.month.slice(0, 7), field: "payout", after: received.toString(), reason: input.note || null } });
  });
  return { reported: reported.toString(), diff: payoutDiff(reported, received) };
}
