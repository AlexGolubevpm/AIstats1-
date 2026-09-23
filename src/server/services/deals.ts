// Fixed deals on the database: nightly forecast, entering advertiser numbers, payments,
// corrections (versioned, never in place) and distribution of period amounts to days.
// Reference: docs/product/04-finance-and-deals.md.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  DealRuleError, calcAmount, checkInvoiceAmount, distribute, effectiveAmount, inGeoScope, periodsOverlap,
  revenueStateOf, statusAfterPayment, weightOf, type PaymentBasis, type PeriodStatus,
} from "@/server/domain/deals";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const isoOf = (x: Date) => x.toISOString().slice(0, 10);
const DAY = 86_400_000;
const daysIn = (from: string, to: string) => Math.round((d(to).getTime() - d(from).getTime()) / DAY) + 1;

type Counter = { date: string; siteId: string; countryCode: string; pageLoads: number; impsOwn: number };

/** Our own counter for a deal in a window, per day × site × country. */
export async function dealCounters(db: PrismaClient, dealId: string, from: string, to: string): Promise<Counter[]> {
  const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId }, include: { sites: true } });
  const out: Counter[] = [];
  const range = { gte: d(from), lte: d(to) };
  for (const ds of deal.sites) {
    if (deal.counterSource === "ASG_ZONE" && ds.zoneId) {
      const rows = await db.factRevenueZone.findMany({ where: { zoneId: ds.zoneId, date: range } });
      out.push(...rows.map((r) => ({ date: isoOf(r.date), siteId: ds.siteId, countryCode: "ZZ", pageLoads: r.pageLoads, impsOwn: r.impsOwn })));
    } else if (deal.counterSource === "ASG_ZONE") {
      const rows = await db.factRevenueGeo.groupBy({ by: ["date", "countryCode"], _sum: { pageLoads: true, impsOwn: true }, where: { siteId: ds.siteId, date: range } });
      out.push(...rows.filter((r) => inGeoScope(deal, r.countryCode)).map((r) => ({ date: isoOf(r.date), siteId: ds.siteId, countryCode: r.countryCode,
        pageLoads: r._sum.pageLoads ?? 0, impsOwn: r._sum.impsOwn ?? 0 })));
    } else if (deal.counterSource === "METRIKA") {
      const rows = await db.factTraffic.groupBy({ by: ["date", "countryCode"], _sum: { pageviews: true }, where: { siteId: ds.siteId, date: range } });
      out.push(...rows.filter((r) => inGeoScope(deal, r.countryCode)).map((r) => ({ date: isoOf(r.date), siteId: ds.siteId, countryCode: r.countryCode,
        pageLoads: r._sum.pageviews ?? 0, impsOwn: r._sum.pageviews ?? 0 })));
    }
  }
  return out;
}

/** Active (non-superseded, entered) periods of a deal. */
async function enteredPeriods(db: PrismaClient, dealId: string) {
  return db.dealPeriod.findMany({ where: { dealId, supersededById: null, status: { not: "OPEN" } } });
}

/**
 * Nightly forecast: counters and forecast revenue for days not covered by an entered period.
 * Days inside entered periods keep their distributed amounts; only counters are refreshed.
 */
export async function forecastDeals(db: PrismaClient, from: string, to: string): Promise<number> {
  const deals = await db.deal.findMany({ where: { status: { in: ["ACTIVE", "PAUSED", "ENDED"] }, startsAt: { lte: d(to) } } });
  let rows = 0;
  for (const deal of deals) {
    const start = isoOf(deal.startsAt) > from ? isoOf(deal.startsAt) : from;
    const end = deal.endsAt && isoOf(deal.endsAt) < to ? isoOf(deal.endsAt) : to;
    if (start > end) continue;
    const counters = await dealCounters(db, deal.id, start, end);
    const periods = await enteredPeriods(db, deal.id);
    const covered = (date: string) => periods.some((p) => isoOf(p.from) <= date && isoOf(p.to) >= date);
    const basis = deal.paymentBasis as PaymentBasis;
    const byDay = new Map<string, Counter[]>();
    for (const c of counters) byDay.set(c.date, [...(byDay.get(c.date) ?? []), c]);
    await db.$transaction(async (tx) => {
      await tx.factFixDeal.deleteMany({ where: { dealId: deal.id, date: { gte: d(start), lte: d(end) }, dealPeriodId: null } });
      for (const [date, cells] of byDay) {
        const inPeriod = covered(date);
        let amounts: Decimal[];
        if (basis === "FLAT_DAILY" || basis === "FLAT_PERIOD") {
          const perDay = basis === "FLAT_DAILY" ? new Decimal(deal.price.toString())
            : new Decimal(deal.price.toString()).div(deal.endsAt ? daysIn(isoOf(deal.startsAt), isoOf(deal.endsAt)) : 30);
          amounts = distribute(perDay, cells.map((c) => ({ ...c, weight: c.pageLoads }))).map((x) => x.amount);
        } else {
          amounts = cells.map((c) => calcAmount(basis, deal.price.toString(), { ...c, days: 1 }));
        }
        for (const [i, c] of cells.entries()) {
          const key = { date_dealId_siteId_countryCode: { date: d(date), dealId: deal.id, siteId: c.siteId, countryCode: c.countryCode } };
          if (inPeriod) {
            await tx.factFixDeal.updateMany({ where: { date: d(date), dealId: deal.id, siteId: c.siteId, countryCode: c.countryCode },
              data: { pageLoads: c.pageLoads, impsOwn: c.impsOwn } });
            continue;
          }
          await tx.factFixDeal.upsert({ ...{ where: key },
            create: { date: d(date), dealId: deal.id, siteId: c.siteId, countryCode: c.countryCode, pageLoads: c.pageLoads, impsOwn: c.impsOwn,
              revenue: amounts[i].toString(), revenueState: "FORECAST" },
            update: { pageLoads: c.pageLoads, impsOwn: c.impsOwn, revenue: amounts[i].toString(), revenueState: "FORECAST", dealPeriodId: null } });
          rows++;
        }
      }
    });
  }
  return rows;
}

/** Spreads the period's effective amount over its days by the deal's counter; exact to 4 dp. */
export async function distributePeriod(db: PrismaClient, periodId: string): Promise<void> {
  const p = await db.dealPeriod.findUniqueOrThrow({ where: { id: periodId }, include: { deal: { include: { sites: true } } } });
  const from = isoOf(p.from), to = isoOf(p.to);
  let counters = await dealCounters(db, p.dealId, from, to);
  if (p.siteId) counters = counters.filter((c) => c.siteId === p.siteId);
  const basis = p.deal.paymentBasis as PaymentBasis;
  const amount = effectiveAmount({ status: p.status as PeriodStatus, amountInvoiced: p.amountInvoiced?.toString() ?? null,
    amountPaid: p.amountPaid?.toString() ?? null, amountCalculated: p.amountCalculated?.toString() ?? null });
  const state = revenueStateOf(p.status as PeriodStatus);
  const cells = counters.length ? counters.map((c) => ({ ...c, weight: weightOf(basis, c) }))
    : [{ date: to, siteId: p.siteId ?? p.deal.sites[0]?.siteId, countryCode: "ZZ", pageLoads: 0, impsOwn: 0, weight: 1 }];
  if (!cells[0].siteId) throw new DealRuleError("no_site", "У дила нет сайтов — некуда разложить сумму");
  const parts = distribute(amount, cells as never);
  const reported = p.impsReported ?? 0;
  const totalW = cells.reduce((a, c) => a + c.impsOwn, 0);
  await db.$transaction(async (tx) => {
    await tx.factFixDeal.deleteMany({ where: { dealId: p.dealId, date: { gte: p.from, lte: p.to }, ...(p.siteId ? { siteId: p.siteId } : {}) } });
    let reportedLeft = reported;
    for (const [i, c] of parts.entries()) {
      const src = cells.find((x) => x.date === c.date && x.siteId === c.siteId && x.countryCode === c.countryCode)!;
      const share = i === parts.length - 1 ? reportedLeft : totalW ? Math.floor((reported * src.impsOwn) / totalW) : 0;
      reportedLeft -= share;
      await tx.factFixDeal.create({ data: {
        date: d(c.date), dealId: p.dealId, siteId: c.siteId, countryCode: c.countryCode, pageLoads: src.pageLoads, impsOwn: src.impsOwn,
        impsReported: share, revenue: c.amount.toString(), revenueState: state, dealPeriodId: p.id,
      } });
    }
  });
}

export interface EnterPeriodInput {
  from: string; to: string; siteId?: string | null; impsReported?: number | null;
  amountInvoiced: string; overrideReason?: string | null; invoiceNo?: string | null; dueAt?: string | null;
}

/** Suggested amount for the entry form, from our counters and the advertiser's impressions. */
export async function calculatePeriodAmount(db: PrismaClient, dealId: string, from: string, to: string, impsReported: number | null, siteId?: string | null) {
  const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId } });
  let counters = await dealCounters(db, dealId, from, to);
  if (siteId) counters = counters.filter((c) => c.siteId === siteId);
  const sum = counters.reduce((a, c) => ({ pageLoads: a.pageLoads + c.pageLoads, impsOwn: a.impsOwn + c.impsOwn }), { pageLoads: 0, impsOwn: 0 });
  const days = daysIn(from, to);
  const periodDays = deal.endsAt ? daysIn(isoOf(deal.startsAt), isoOf(deal.endsAt)) : days;
  const amount = calcAmount(deal.paymentBasis as PaymentBasis, deal.price.toString(), { ...sum, impsReported, days }, periodDays);
  const forecast = await db.factFixDeal.aggregate({ _sum: { revenue: true }, where: { dealId, date: { gte: d(from), lte: d(to) }, ...(siteId ? { siteId } : {}) } });
  return { ...sum, days, amount: amount.toString(), forecast: (forecast._sum.revenue ?? 0).toString() };
}

export async function enterPeriod(db: PrismaClient, dealId: string, input: EnterPeriodInput): Promise<string> {
  if (input.from > input.to) throw new DealRuleError("period", "Начало периода позже конца", "from");
  const existing = await enteredPeriods(db, dealId);
  const clash = existing.find((p) => (!input.siteId || !p.siteId || p.siteId === input.siteId) && periodsOverlap({ from: isoOf(p.from), to: isoOf(p.to) }, input));
  if (clash) throw new DealRuleError("overlap", `Период пересекается с уже внесённым ${isoOf(clash.from)} — ${isoOf(clash.to)}`, "from");
  const calc = await calculatePeriodAmount(db, dealId, input.from, input.to, input.impsReported ?? null, input.siteId);
  checkInvoiceAmount(calc.amount, input.amountInvoiced, input.overrideReason);
  const deal = await db.deal.findUniqueOrThrow({ where: { id: dealId } });
  const due = input.dueAt ?? isoOf(new Date(d(input.to).getTime() + deal.paymentTermsDays * DAY));
  const p = await db.dealPeriod.create({ data: {
    dealId, siteId: input.siteId ?? null, from: d(input.from), to: d(input.to), impsReported: input.impsReported ?? null,
    amountCalculated: calc.amount, amountInvoiced: input.amountInvoiced, overrideReason: input.overrideReason || null,
    invoiceNo: input.invoiceNo || null, dueAt: d(due), status: "INVOICED",
  } });
  await db.auditLog.create({ data: { entity: "DealPeriod", entityId: p.id, field: "created", after: `${input.amountInvoiced}`,
    reason: input.overrideReason ? `переопределено: ${input.overrideReason}` : null } });
  await distributePeriod(db, p.id);
  return p.id;
}

export interface PaymentInput { amountPaid: string; paidAt: string; remainder?: "open" | "write_off"; writeOffReason?: string; comment?: string }

export async function recordPayment(db: PrismaClient, periodId: string, input: PaymentInput): Promise<PeriodStatus> {
  const p = await db.dealPeriod.findUniqueOrThrow({ where: { id: periodId } });
  if (p.supersededById) throw new DealRuleError("superseded", "Этот период заменён исправленной версией");
  const total = new Decimal(p.amountPaid?.toString() ?? 0).add(input.amountPaid);
  const status = statusAfterPayment(p.amountInvoiced?.toString() ?? "0", total, input.remainder, input.writeOffReason);
  await db.dealPeriod.update({ where: { id: periodId }, data: { amountPaid: total.toString(), paidAt: d(input.paidAt), status, writeOffReason: input.writeOffReason || null } });
  await db.auditLog.create({ data: { entity: "DealPeriod", entityId: periodId, field: "payment", before: p.amountPaid?.toString() ?? null,
    after: total.toString(), reason: input.comment || input.writeOffReason || null } });
  await distributePeriod(db, periodId);
  return status;
}

export async function markDisputed(db: PrismaClient, periodId: string, reason: string): Promise<void> {
  if (!reason.trim()) throw new DealRuleError("reason_required", "Укажите причину спора", "reason");
  await db.dealPeriod.update({ where: { id: periodId }, data: { status: "DISPUTED" } });
  await db.auditLog.create({ data: { entity: "DealPeriod", entityId: periodId, field: "status", after: "DISPUTED", reason } });
  await distributePeriod(db, periodId);
}

/** Corrections create a new version; the old one stays in history, linked via supersededById. */
export async function correctPeriod(db: PrismaClient, periodId: string, input: EnterPeriodInput, reason: string): Promise<string> {
  if (!reason.trim()) throw new DealRuleError("reason_required", "Укажите причину исправления", "reason");
  const old = await db.dealPeriod.findUniqueOrThrow({ where: { id: periodId } });
  if (old.supersededById) throw new DealRuleError("superseded", "Этот период уже исправлен");
  const calc = await calculatePeriodAmount(db, old.dealId, input.from, input.to, input.impsReported ?? null, input.siteId);
  checkInvoiceAmount(calc.amount, input.amountInvoiced, input.overrideReason);
  const next = await db.$transaction(async (tx) => {
    const n = await tx.dealPeriod.create({ data: {
      dealId: old.dealId, siteId: input.siteId ?? old.siteId, from: d(input.from), to: d(input.to), impsReported: input.impsReported ?? null,
      amountCalculated: calc.amount, amountInvoiced: input.amountInvoiced, overrideReason: input.overrideReason || null,
      invoiceNo: input.invoiceNo ?? old.invoiceNo, dueAt: input.dueAt ? d(input.dueAt) : old.dueAt,
      amountPaid: old.amountPaid, paidAt: old.paidAt, status: old.status === "OPEN" ? "INVOICED" : old.status, version: old.version + 1,
    } });
    await tx.dealPeriod.update({ where: { id: old.id }, data: { supersededById: n.id } });
    await tx.auditLog.create({ data: { entity: "DealPeriod", entityId: n.id, field: "correction",
      before: old.amountInvoiced?.toString() ?? null, after: input.amountInvoiced, reason } });
    return n;
  });
  await distributePeriod(db, next.id);
  return next.id;
}
