"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { SESSION_COOKIE, changePassword, issueMcpToken } from "@/server/auth";
import { config } from "@/server/config";
import { db } from "@/server/db";
import { RuleError } from "@/server/domain/errors";
import { checkSite, withAsg } from "@/server/ingest/probe";
import { resumeAsg } from "@/server/ingest/run";
import { JOB_NAMES, type JobName } from "@/server/jobs/handlers";
import { clearData } from "@/server/seed/demo";
import { loadDemo } from "@/server/seed/load-demo";
import { applyCostImport, previewCostImport, revertCostImport, type ImportPreview } from "@/server/services/costs";
import {
  addCostRate, addCostSource, addSitesToBundle, deleteBundle, mapAlias, missingAsgSites, removeSitesFromBundle, saveBundle, saveNetwork, saveSite,
  setBundleSites, setSitesStatus, type RateInput,
} from "@/server/services/settings";
import { requireSession } from "@/server/session";
import { guarded, int, opt, str, type ActionResult } from "./result";

const yesterday = () => new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

// ---------- sites ----------

export async function saveSiteAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await saveSite(db, { id: opt(f, "id") ?? undefined, domain: str(f, "domain"), title: opt(f, "title") ?? undefined, adsgSiteId: int(f, "adsgSiteId"),
      metrikaId: opt(f, "metrikaId"), status: (opt(f, "status") ?? "ACTIVE") as "ACTIVE", launchedAt: opt(f, "launchedAt") });
    revalidatePath("/settings/sites");
    return { ok: true, message: "Сайт сохранён" };
  });
}

export async function bulkSitesAction(ids: string[], op: string, arg: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    if (!ids.length) throw new RuleError("empty", "Не выбраны сайты");
    const n = op === "status" ? await setSitesStatus(db, ids, arg as "ACTIVE")
      : op === "add" ? await addSitesToBundle(db, ids, arg) : await removeSitesFromBundle(db, ids, arg);
    revalidatePath("/settings/sites"); revalidatePath("/", "layout");
    return { ok: true, message: `Изменено: ${n}` };
  });
}

export async function checkSiteAction(siteId: string): Promise<ActionResult> {
  await requireSession();
  const day = yesterday();
  const r = await checkSite(db, config(), siteId, day);
  const asg = r.asg.ok ? `AdSpyglass: ${r.asg.value.pageLoads.toLocaleString("ru")} загрузок` : `AdSpyglass: ${r.asg.error}`;
  const met = r.metrika.ok ? `Метрика: ${r.metrika.value.uniques.toLocaleString("ru")} уников` : `Метрика: ${r.metrika.error}`;
  return r.asg.ok || r.metrika.ok ? { ok: true, message: `${day} · ${asg} · ${met}` } : { error: `${day} · ${asg} · ${met}` };
}

export async function asgSitesAction(): Promise<ActionResult> {
  await requireSession();
  const day = yesterday();
  const r = await withAsg(db, config(), (c) => c.report({ from: day, to: day, groupBy: "website" }));
  if (!r.ok) return { error: r.error };
  const missing = await missingAsgSites(db, r.value);
  return { ok: true, message: missing.length ? `Найдено новых: ${missing.length}` : "Все сайты AdSpyglass уже добавлены", data: { missing } };
}

export async function importAsgSitesAction(rows: { adsgSiteId: number; domain: string }[]): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    for (const r of rows) await saveSite(db, { domain: r.domain, adsgSiteId: r.adsgSiteId });
    revalidatePath("/settings/sites");
    return { ok: true, message: `Добавлено сайтов: ${rows.length}` };
  });
}

// ---------- bundles ----------

export async function saveBundleAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const id = await saveBundle(db, { id: opt(f, "id") ?? undefined, slug: str(f, "slug"), title: str(f, "title"), color: str(f, "color") });
    if (f.has("members")) await setBundleSites(db, id, f.getAll("siteIds").map(String));
    revalidatePath("/settings/bundles"); revalidatePath("/", "layout");
    return { ok: true, message: "Бандл сохранён" };
  });
}

export async function deleteBundleAction(id: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await deleteBundle(db, id);
    revalidatePath("/settings/bundles"); revalidatePath("/", "layout");
    return { ok: true, message: "Бандл удалён, сайты и данные остались" };
  });
}

// ---------- costs ----------

export async function addRateAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const r = await addCostRate(db, { sourceSlug: str(f, "sourceSlug"), siteId: opt(f, "siteId"), countryCode: opt(f, "countryCode")?.toUpperCase() ?? null,
      rateModel: str(f, "rateModel") as RateInput["rateModel"], rate: str(f, "rate").replace(",", "."), validFrom: str(f, "validFrom"), validTo: opt(f, "validTo") });
    revalidatePath("/settings/costs");
    return { ok: true, message: r.closed ? `Ставка добавлена, предыдущая закрыта (${r.closed})` : "Ставка добавлена" };
  });
}

export async function deleteRateAction(id: string): Promise<ActionResult> {
  await requireSession();
  await db.costRate.delete({ where: { id } });
  revalidatePath("/settings/costs");
  return { ok: true, message: "Ставка удалена. Пересчитайте расход за затронутый период" };
}

export async function addSourceAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await addCostSource(db, str(f, "slug"), str(f, "title"));
    revalidatePath("/settings/costs");
    return { ok: true, message: "Источник добавлен" };
  });
}

export async function previewImportAction(csv: string): Promise<ImportPreview | { error: string }> {
  await requireSession();
  try { return await previewCostImport(db, csv); } catch (e) { return { error: (e as Error).message }; }
}

export async function applyImportAction(csv: string, fileName: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const r = await applyCostImport(db, csv, fileName || "import.csv");
    revalidatePath("/settings/costs");
    return { ok: true, message: `Импортировано строк: ${r.rows}` };
  });
}

export async function revertImportAction(batchId: string): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await revertCostImport(db, batchId);
    revalidatePath("/settings/costs");
    return { ok: true, message: "Импорт откатан, расход пересчитан по ставкам" };
  });
}

// ---------- networks ----------

export async function saveNetworkAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await saveNetwork(db, { id: str(f, "id"), title: str(f, "title"), color: str(f, "color"), kind: str(f, "kind") as "MEDIATED", showInLegend: str(f, "showInLegend") === "1" });
    revalidatePath("/settings/networks");
    return { ok: true, message: "Сетка сохранена" };
  });
}

// ---------- integrations ----------

/** Puts a job on the queue. The worker applies the same limits as scheduled runs. */
export async function runJobAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  const job = str(f, "job") as JobName;
  if (!JOB_NAMES.includes(job)) return { error: "Неизвестный джоб", field: "job" };
  const from = opt(f, "from"), to = opt(f, "to");
  if ((from && !to) || (to && !from) || (from && to && from > to)) return { error: "Проверьте диапазон дат", field: "from" };
  if (job === "asg:sites" && from && to) {
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    const sites = await db.site.count({ where: { status: "ACTIVE", adsgSiteId: { not: null }, ...(opt(f, "siteId") ? { id: opt(f, "siteId")! } : {}) } });
    const requests = days * sites * 2;
    const budget = config().asg.dailyBudget;
    if (requests > budget && str(f, "confirm") !== "1") {
      return { error: `Бэкфилл потребует ~${requests} запросов к AdSpyglass при дневном бюджете ${budget}. Сократите диапазон или отметьте подтверждение — джоб продолжит на следующий день.`, field: "confirm" };
    }
  }
  try {
    const { enqueue } = await import("@/server/jobs/queue");
    const id = await enqueue(job, { ...(from && to ? { from, to } : {}), ...(opt(f, "siteId") ? { siteId: opt(f, "siteId")! } : {}) });
    revalidatePath("/settings/integrations");
    return { ok: true, message: `Джоб ${job} поставлен в очередь (#${id})` };
  } catch (e) {
    return { error: `Очередь недоступна: ${(e as Error).message}` };
  }
}

export async function resumeAsgAction(): Promise<ActionResult> {
  await requireSession();
  await resumeAsg(db);
  revalidatePath("/settings/integrations");
  return { ok: true, message: "Пауза снята. Следующий запрос уйдёт по расписанию" };
}

export async function testAsgAction(): Promise<ActionResult> {
  await requireSession();
  const day = yesterday();
  const r = await withAsg(db, config(), (c) => c.report({ from: day, to: day, groupBy: "date" }));
  revalidatePath("/settings/integrations");
  return r.ok ? { ok: true, message: `AdSpyglass отвечает: ${r.value.length} строк за ${day}` } : { error: r.error };
}

export async function mapAliasAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    await mapAlias(db, str(f, "source"), str(f, "raw"), str(f, "countryCode"));
    revalidatePath("/settings/integrations");
    return { ok: true, message: "Сопоставлено. Нажмите «Пересчитать», чтобы переписать строки из сырья" };
  });
}

export async function demoAction(op: "load" | "clear"): Promise<ActionResult> {
  await requireSession();
  return guarded(async () => {
    const demo = await db.appSetting.findUnique({ where: { key: "demo_data" } });
    const sites = await db.site.count();
    if (op === "load" && sites > 0 && !demo) throw new RuleError("real_data", "В базе уже есть настоящие сайты — демо-данные не загружаются поверх них");
    if (op === "clear" && !demo) throw new RuleError("not_demo", "Сейчас в базе не демо-данные — очистка отсюда запрещена");
    if (op === "load") await loadDemo(db); else await clearData(db);
    revalidatePath("/", "layout");
    return { ok: true, message: op === "load" ? "Демо-данные загружены" : "Демо-данные удалены" };
  });
}

// ---------- access ----------

export async function changePasswordAction(_: ActionResult, f: FormData): Promise<ActionResult> {
  await requireSession();
  const next = str(f, "next");
  if (next.length < 10) return { error: "Не короче 10 символов", field: "next" };
  if (next !== str(f, "repeat")) return { error: "Пароли не совпадают", field: "repeat" };
  const r = await changePassword(db, str(f, "current"), next, (await cookies()).get(SESSION_COOKIE)?.value, config().appPassword);
  return r.ok ? { ok: true, message: "Пароль изменён, остальные сессии сброшены" } : { error: r.error, field: "current" };
}

export async function issueMcpTokenAction(): Promise<ActionResult> {
  await requireSession();
  const token = await issueMcpToken(db);
  revalidatePath("/settings/access");
  return { ok: true, message: "Новый токен выпущен, старый больше не работает", data: { token } };
}
