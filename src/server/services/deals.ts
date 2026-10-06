// Fixed deals on the database: nightly forecast, entering advertiser numbers, payments,
// corrections (versioned, never in place) and distribution of period amounts to days.
// Reference: docs/product/04-finance-and-deals.md.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  DealRuleError, calcAmount, checkInvoiceAmount, distribute, effectiveAmount, flatPerDay, flatPeriodDays, inGeoScope, isFlat, periodsOverlap,
  placeKey, revenueStateOf, statusAfterPayment, validateDeal, weightOf, type BillingPeriod, type DealInput, type PaymentBasis, type PeriodStatus,
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
      // A day with only the ZZ site total (no country cut yet) keeps it whatever the geo scope: otherwise a scoped deal gets no counters at all.
      const onlyZZ = new Set(rows.filter((r) => r.countryCode === "ZZ").map((r) => isoOf(r.date)));
      for (const r of rows) if (r.countryCode !== "ZZ") onlyZZ.delete(isoOf(r.date));
      out.push(...rows.filter((r) => onlyZZ.has(isoOf(r.date)) || inGeoScope(deal, r.countryCode)).map((r) => ({ date: isoOf(r.date), siteId: ds.siteId, countryCode: r.countryCode,
        pageLoads: r._sum.pageLoads ?? 0, impsOwn: r._sum.impsOwn ?? 0 })));
    } else if (deal.counterSource === "METRIKA") {
      const rows = await db.factTraffic.groupBy({ by: ["date", "countryCode"], _sum: { pageviews: true }, where: { siteId: ds.siteId, date: range } });
      out.push(...rows.filter((r) => inGeoScope(deal, r.countryCode)).map((r) => ({ date: isoOf(r.date), siteId: ds.siteId, countryCode: r.countryCode,
        pageLoads: r._sum.pageviews ?? 0, impsOwn: r._sum.pageviews ?? 0 })));
    }
  }
  return out;
}

const eachDay = (from: string, to: string) => Array.from({ length: Math.max(0, daysIn(from, to)) }, (_, i) => isoOf(new Date(d(from).getTime() + i * DAY)));

/**
 * Flat deals are not tied to traffic: every day of the window × every site of the deal gets an
 * equal share, in country ZZ. Our counters are attached to the cells for reference only.
 */
function flatCells(siteIds: string[], from: string, to: string, counters: Counter[]): Counter[] {
  const sum = new Map<string, { pageLoads: number; impsOwn: number }>();
  for (const c of counters) {
    const k = `${c.date}|${c.siteId}`, cur = sum.get(k) ?? { pageLoads: 0, impsOwn: 0 };
    sum.set(k, { pageLoads: cur.pageLoads + c.pageLoads, impsOwn: cur.impsOwn + c.impsOwn });
  }
  return eachDay(from, to).flatMap((date) => siteIds.map((siteId) => ({ date, siteId, countryCode: "ZZ", ...(sum.get(`${date}|${siteId}`) ?? { pageLoads: 0, impsOwn: 0 }) })));
}

const termDaysOf = (deal: { startsAt: Date; endsAt: Date | null }) => (deal.endsAt ? daysIn(isoOf(deal.startsAt), isoOf(deal.endsAt)) : null);

/** Active (non-superseded, entered) periods of a deal. */
async function enteredPeriods(db: PrismaClient, dealId: string) {
  return db.dealPeriod.findMany({ where: { dealId, supersededById: null, status: { not: "OPEN" } } });
}

/**
 * Nightly forecast: counters and forecast revenue for days not covered by an entered period.
 * Days inside entered periods keep their distributed amounts; only counters are refreshed.
 */
export async function forecastDeals(db: PrismaClient, from: string, to: string, dealId?: string): Promise<number> {
  const deals = await db.deal.findMany({ where: { status: { in: ["ACTIVE", "PAUSED", "ENDED"] }, startsAt: { lte: d(to) }, ...(dealId ? { id: dealId } : {}) }, include: { sites: true } });
  let rows = 0;
  for (const deal of deals) {
    const start = isoOf(deal.startsAt) > from ? isoOf(deal.startsAt) : from;
    const end = deal.endsAt && isoOf(deal.endsAt) < to ? isoOf(deal.endsAt) : to;
    if (start > end) continue;
    const basis = deal.paymentBasis as PaymentBasis;
    const raw = await dealCounters(db, deal.id, start, end);
    const counters = isFlat(basis) ? flatCells(deal.sites.map((s) => s.siteId), start, end, raw) : raw;
    const periods = await enteredPeriods(db, deal.id);
    const covered = (date: string) => periods.some((p) => isoOf(p.from) <= date && isoOf(p.to) >= date);
    const byDay = new Map<string, Counter[]>();
    for (const c of counters) byDay.set(c.date, [...(byDay.get(c.date) ?? []), c]);
    await db.$transaction(async (tx) => {
      await tx.factFixDeal.deleteMany({ where: { dealId: deal.id, date: { gte: d(start), lte: d(end) }, dealPeriodId: null } });
      for (const [date, cells] of byDay) {
        const inPeriod = covered(date);
        let amounts: Decimal[];
        if (isFlat(basis)) {
          const perDay = flatPerDay(basis, deal.price.toString(), deal.billingPeriod as BillingPeriod, termDaysOf(deal), date);
          amounts = cells.map(() => perDay.div(cells.length).toDecimalPlaces(4)); // evenly between the deal's sites
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
  const basis = p.deal.paymentBasis as PaymentBasis;
  let counters = await dealCounters(db, p.dealId, from, to);
  if (isFlat(basis)) counters = flatCells(p.siteId ? [p.siteId] : p.deal.sites.map((s) => s.siteId), from, to, counters);
  if (p.siteId) counters = counters.filter((c) => c.siteId === p.siteId);
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
  const periodDays = flatPeriodDays(deal.billingPeriod as BillingPeriod, termDaysOf(deal) ?? days, from);
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

// ---------- deal terms ----------

const TERM_FIELDS = ["title", "format", "paymentBasis", "price", "geoScope", "geoExclude", "startsAt", "endsAt", "billingPeriod",
  "paymentTermsDays", "counterSource", "billedVia", "notes"] as const;

/**
 * The format of a deal follows the AdSpyglass zones mapped to its places on its sites: one
 * format → that one; none or several → the explicit/previous value, else OTHER.
 */
async function formatOf(db: PrismaClient, places: { siteId: string; placementSlug: string }[], fallback: string | undefined): Promise<string> {
  if (places.length) {
    const zones = await db.zone.findMany({ where: { OR: places.map((p) => ({ siteId: p.siteId, placementSlug: p.placementSlug })) }, select: { format: true } });
    const formats = [...new Set(zones.map((z) => z.format))];
    if (formats.length === 1) return formats[0];
  }
  return fallback || "OTHER";
}

export async function saveDeal(db: PrismaClient, raw: DealInput, id?: string, reason?: string | null): Promise<string> {
  const i = validateDeal(raw);
  const known = await db.site.count({ where: { id: { in: i.siteIds } } });
  if (known !== i.siteIds.length) throw new DealRuleError("sites", "Сайт не найден", "siteIds");
  const places = i.places ?? [];
  const slugs = [...new Set(places.map((p) => p.placementSlug))];
  if (slugs.length && (await db.placement.count({ where: { slug: { in: slugs } } })) !== slugs.length) throw new DealRuleError("place", "Место не найдено", "place");
  const advertiser = await db.advertiser.upsert({ where: { name: i.advertiser }, create: { name: i.advertiser }, update: {} });
  const before = id ? await db.deal.findUniqueOrThrow({ where: { id } }) : null;
  const format = await formatOf(db, places, i.format ?? before?.format);
  const data = {
    title: i.title, advertiserId: advertiser.id, format: format as never, paymentBasis: i.paymentBasis, price: i.price, geoScope: i.geoScope,
    geoExclude: i.geoExclude, startsAt: d(i.startsAt), endsAt: i.endsAt ? d(i.endsAt) : null, billingPeriod: i.billingPeriod,
    paymentTermsDays: i.paymentTermsDays, counterSource: i.counterSource, billedVia: i.billedVia, notes: i.notes || null,
  };
  const sites = i.siteIds.map((siteId) => ({ siteId, zoneId: i.zoneBySite?.[siteId] || null }));
  if (!id || !before) {
    const deal = await db.deal.create({ data: { ...data, status: "ACTIVE", sites: { create: sites }, places: { create: places } } });
    await db.auditLog.create({ data: { entity: "Deal", entityId: deal.id, field: "created", after: `${i.paymentBasis} ${i.price}` } });
    await reforecast(db, deal.id);
    return deal.id;
  }
  const hasPeriods = (await db.dealPeriod.count({ where: { dealId: id, status: { not: "OPEN" } } })) > 0;
  const priceChanged = before.price.toString() !== new Decimal(i.price).toString() || before.paymentBasis !== i.paymentBasis;
  if (hasPeriods && priceChanged && !reason?.trim()) throw new DealRuleError("reason_required", "По дилу уже внесены периоды — укажите причину изменения условий", "reason");
  await db.$transaction(async (tx) => {
    await tx.deal.update({ where: { id }, data });
    await tx.dealSite.deleteMany({ where: { dealId: id } });
    await tx.dealSite.createMany({ data: sites.map((s) => ({ ...s, dealId: id })) });
    const was = (await tx.dealPlace.findMany({ where: { dealId: id } })).map(placeKey).sort().join(",");
    await tx.dealPlace.deleteMany({ where: { dealId: id } });
    await tx.dealPlace.createMany({ data: places.map((p) => ({ ...p, dealId: id })) });
    const now = places.map(placeKey).sort().join(",");
    if (was !== now) await tx.auditLog.create({ data: { entity: "Deal", entityId: id, field: "places", before: was, after: now, reason: reason || null } });
    const norm = (v: unknown) => (v instanceof Date ? isoOf(v) : Array.isArray(v) ? v.join(",") : v == null ? "" : String(v));
    for (const f of TERM_FIELDS) {
      const a = norm((before as Record<string, unknown>)[f]), b = norm(f === "price" ? new Decimal(i.price) : (data as Record<string, unknown>)[f]);
      if (f === "price" ? !new Decimal(a || 0).equals(b || 0) : a !== b) await tx.auditLog.create({ data: { entity: "Deal", entityId: id, field: f, before: a, after: b, reason: reason || null } });
    }
  });
  await reforecast(db, id);
  return id;
}

/** Forecast window after a save: from the deal's start (at most 92 days back) up to today, so the pages show it at once. */
export const REFORECAST_DAYS = 92;
/** Recomputes the forecast of every deal for the last REFORECAST_DAYS days up to today (button on /deals, worker start). */
export async function reforecastAll(db: PrismaClient, today = isoOf(new Date())): Promise<number> {
  const from = isoOf(new Date(d(today).getTime() - (REFORECAST_DAYS - 1) * DAY));
  return forecastDeals(db, from, today);
}
async function reforecast(db: PrismaClient, id: string, today = isoOf(new Date())): Promise<void> {
  const deal = await db.deal.findUniqueOrThrow({ where: { id } });
  const floor = isoOf(new Date(d(today).getTime() - (REFORECAST_DAYS - 1) * DAY));
  const from = isoOf(deal.startsAt) > floor ? isoOf(deal.startsAt) : floor;
  // Rows after a new, earlier end date are stale: the forecast only rewrites days inside the window.
  await db.factFixDeal.deleteMany({ where: { dealId: id, dealPeriodId: null, ...(deal.endsAt ? { date: { gt: deal.endsAt } } : {}) } });
  if (from <= today) await forecastDeals(db, from, today, id);
}

export async function setDealStatus(db: PrismaClient, id: string, status: "ACTIVE" | "PAUSED" | "ENDED", endsAt?: string): Promise<void> {
  const before = await db.deal.findUniqueOrThrow({ where: { id } });
  await db.deal.update({ where: { id }, data: { status, ...(status === "ENDED" && !before.endsAt ? { endsAt: d(endsAt ?? isoOf(new Date())) } : {}) } });
  await db.auditLog.create({ data: { entity: "Deal", entityId: id, field: "status", before: before.status, after: status } });
  await reforecast(db, id);
}

/** Only a draft deal without entered periods can be deleted; everything else keeps history. */
export async function deleteDeal(db: PrismaClient, id: string): Promise<void> {
  const deal = await db.deal.findUniqueOrThrow({ where: { id } });
  const entered = await db.dealPeriod.count({ where: { dealId: id, status: { not: "OPEN" } } });
  if (deal.status !== "DRAFT" || entered) throw new DealRuleError("delete", "Удалить можно только черновик без внесённых периодов — завершите дил");
  await db.deal.delete({ where: { id } });
}
