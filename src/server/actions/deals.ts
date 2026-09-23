"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseGeoList, type BillingPeriod, type DealInput, type PaymentBasis } from "@/server/domain/deals";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";
import {
  calculatePeriodAmount, correctPeriod, deleteDeal, enterPeriod, markDisputed, recordPayment, saveDeal, setDealStatus, type EnterPeriodInput,
} from "@/server/services/deals";
import { guarded, int, money, opt, str, type ActionResult } from "./result";

const TIERS: Record<string, number> = { T1: 1, T2: 2, T3: 3 };

async function dealInput(f: FormData): Promise<DealInput> {
  // "T1" in the geo field expands to all tier-1 countries.
  const codes = parseGeoList(str(f, "geoScope"));
  const tiers = codes.filter((c) => c in TIERS).map((c) => TIERS[c]);
  const tierCodes = tiers.length ? (await db.country.findMany({ where: { tier: { in: tiers } } })).map((c) => c.code) : [];
  const siteIds = f.getAll("siteIds").map(String).filter(Boolean);
  return {
    title: str(f, "title"), advertiser: str(f, "advertiser"), format: str(f, "format") || "BANNER", paymentBasis: (str(f, "paymentBasis") || "PER_1000_LOADS") as PaymentBasis,
    price: money(f, "price"), siteIds, geoScope: [...new Set([...codes.filter((c) => !(c in TIERS)), ...tierCodes])], geoExclude: str(f, "geoExclude") === "1",
    startsAt: str(f, "startsAt"), endsAt: opt(f, "endsAt"), billingPeriod: (str(f, "billingPeriod") || "MONTH") as BillingPeriod,
    paymentTermsDays: int(f, "paymentTermsDays") ?? 30, counterSource: (str(f, "counterSource") || "ASG_ZONE") as DealInput["counterSource"],
    billedVia: (str(f, "billedVia") || "DIRECT") as DealInput["billedVia"], notes: opt(f, "notes"),
    zoneBySite: Object.fromEntries(siteIds.map((id) => [id, opt(f, `zone_${id}`)])),
  };
}

export async function saveDealAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  let id = str(f, "id") || undefined;
  const r = await guarded(async () => {
    id = await saveDeal(db, await dealInput(f), id, opt(f, "reason"));
  });
  if (r.error) return r;
  revalidatePath("/deals");
  if (!str(f, "id")) redirect(`/deals/${id}`);
  revalidatePath(`/deals/${id}`);
  return { ok: true, message: "Условия сохранены" };
}

export async function dealStatusAction(id: string, status: "ACTIVE" | "PAUSED" | "ENDED"): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await setDealStatus(db, id, status);
    revalidatePath(`/deals/${id}`);
    revalidatePath("/deals");
    return { ok: true, message: status === "PAUSED" ? "Дил на паузе" : status === "ENDED" ? "Дил завершён" : "Дил активен" };
  });
}

export async function deleteDealAction(id: string): Promise<ActionResult> {
  await requireSession();
  const r = await guarded(() => deleteDeal(db, id));
  if (r.error) return r;
  revalidatePath("/deals");
  redirect("/deals");
}

export async function calcPeriodAction(dealId: string, from: string, to: string, impsReported: number | null, siteId: string | null) {
  await requireSession();
  if (!from || !to || from > to) return null;
  return calculatePeriodAmount(db, dealId, from, to, impsReported, siteId);
}

const periodInput = (f: FormData): EnterPeriodInput => ({
  from: str(f, "from"), to: str(f, "to"), siteId: opt(f, "siteId"), impsReported: int(f, "impsReported"), amountInvoiced: money(f, "amountInvoiced"),
  overrideReason: str(f, "override") === "1" ? opt(f, "overrideReason") : null, invoiceNo: opt(f, "invoiceNo"), dueAt: opt(f, "dueAt"),
});

export async function enterPeriodAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  const dealId = str(f, "dealId");
  return guarded(async () => {
    const input = periodInput(f);
    if (!input.amountInvoiced) return { error: "Укажите сумму к оплате", field: "amountInvoiced" };
    const periodId = str(f, "periodId");
    if (periodId) await correctPeriod(db, periodId, input, str(f, "reason"));
    else await enterPeriod(db, dealId, input);
    revalidatePath(`/deals/${dealId}`); revalidatePath("/deals"); revalidatePath("/finance");
    return { ok: true, message: periodId ? "Создана исправленная версия периода" : "Период внесён — Выставлено" };
  });
}

export async function paymentAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  const dealId = str(f, "dealId");
  return guarded(async () => {
    const remainder = str(f, "remainder") as "open" | "write_off" | "";
    const status = await recordPayment(db, str(f, "periodId"), { amountPaid: money(f, "amountPaid"), paidAt: str(f, "paidAt"),
      remainder: remainder || undefined, writeOffReason: opt(f, "writeOffReason") ?? undefined, comment: opt(f, "comment") ?? undefined });
    revalidatePath(`/deals/${dealId}`); revalidatePath("/deals"); revalidatePath("/finance");
    return { ok: true, message: status === "PAID" ? "Оплата подтверждена" : status === "PARTIAL" ? "Частичная оплата, остаток ожидается" : "Оплата внесена, остаток списан" };
  });
}

export async function disputeAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  const dealId = str(f, "dealId");
  return guarded(async () => {
    await markDisputed(db, str(f, "periodId"), str(f, "reason"));
    revalidatePath(`/deals/${dealId}`); revalidatePath("/deals");
    return { ok: true, message: "Период помечен как спорный" };
  });
}
