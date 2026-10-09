"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { parseGeoInput, type BillingPeriod, type DealInput, type PaymentBasis } from "@/server/domain/deals";
import { db } from "@/server/db";
import { requireSession } from "@/server/session";
import {
  calculatePeriodAmount, correctPeriod, deleteDeal, enterPeriod, markDisputed, recordPayment, reforecastAll, saveDeal, setDealStatus, type EnterPeriodInput,
} from "@/server/services/deals";
import { guarded, int, money, opt, str, type ActionResult } from "./result";

async function dealInput(f: FormData): Promise<DealInput> {
  // Tiers come from the T1–T5 checkboxes (or «T1» tokens typed into the geo field); they are stored as tiers, not expanded
  // into countries, so a tier edit on /settings/geo reaches the deal (ADR 0017).
  const geo = parseGeoInput(str(f, "geoScope"));
  const geoTiers = [...new Set([...geo.tiers, ...f.getAll("geoTiers").map(Number).filter((t) => Number.isInteger(t) && t >= 1 && t <= 5)])].sort();
  const siteIds = [...new Set(f.getAll("siteIds").map(String).filter(Boolean))];
  const slugs = [...new Set(f.getAll("placeSlugs").map(String).filter(Boolean))];
  const places = siteIds.flatMap((siteId) => slugs.map((placementSlug) => ({ siteId, placementSlug }))); // every chosen zone on every chosen site
  return {
    title: str(f, "title"), advertiser: str(f, "advertiser"), paymentBasis: (str(f, "paymentBasis") || "PER_1000_LOADS") as PaymentBasis,
    price: money(f, "price"), siteIds, geoScope: geo.codes, geoTiers, geoExclude: str(f, "geoExclude") === "1",
    startsAt: str(f, "startsAt"), endsAt: opt(f, "endsAt"), billingPeriod: (str(f, "billingPeriod") || "MONTH") as BillingPeriod,
    paymentTermsDays: int(f, "paymentTermsDays") ?? 30, counterSource: (str(f, "counterSource") || "ASG_ZONE") as DealInput["counterSource"],
    billedVia: (str(f, "billedVia") || "DIRECT") as DealInput["billedVia"], notes: opt(f, "notes"),
    zoneBySite: Object.fromEntries(siteIds.map((id) => [id, opt(f, `zone_${id}`)])), places,
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
  revalidatePath("/inventory"); // the Formats tab lists every deal
  if (!str(f, "id")) redirect(`/deals/${id}`);
  revalidatePath(`/deals/${id}`);
  return { ok: true, message: "Условия сохранены, прогноз пересчитан" };
}

export async function dealStatusAction(id: string, status: "ACTIVE" | "PAUSED" | "ENDED"): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await setDealStatus(db, id, status);
    revalidatePath(`/deals/${id}`);
    revalidatePath("/deals");
    revalidatePath("/inventory");
    return { ok: true, message: status === "PAUSED" ? "Дил на паузе" : status === "ENDED" ? "Дил завершён" : "Дил активен" };
  });
}

export async function deleteDealAction(id: string): Promise<ActionResult> {
  await requireSession();
  const r = await guarded(() => deleteDeal(db, id));
  if (r.error) return r;
  revalidatePath("/deals");
  revalidatePath("/inventory"); // the Formats tab lists every deal
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

/** «Пересчитать прогноз» on /deals: all deals, the last 92 days up to today. */
export async function reforecastDealsAction(): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const rows = await reforecastAll(db);
    for (const p of ["/deals", "/finance", "/inventory", "/forecast", "/"]) revalidatePath(p);
    return { ok: true, message: `Прогноз пересчитан: ${rows} строк` };
  });
}
