// Reference data behind /settings (docs/product/05-settings.md). Nothing here deletes facts:
// archiving hides, history stays.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import { RuleError, parseDecimal } from "@/server/domain/errors";
import { normalizeDomain, parseWebsiteName } from "@/server/ingest/normalize";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const isoOf = (x: Date) => x.toISOString().slice(0, 10);
const addDays = (s: string, n: number) => isoOf(new Date(d(s).getTime() + n * 86_400_000));

// ---------- sites ----------

export interface SiteInput { id?: string; domain: string; title?: string; adsgSiteId?: number | null; metrikaId?: string | null; status?: "ACTIVE" | "PAUSED" | "ARCHIVED"; launchedAt?: string | null }

export async function saveSite(db: PrismaClient, i: SiteInput): Promise<string> {
  const domain = normalizeDomain(i.domain);
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw new RuleError("domain", "Некорректный домен", "domain");
  if (!i.adsgSiteId && !i.metrikaId) throw new RuleError("ids", "Нужен хотя бы один ID: AdSpyglass или Метрика", "adsgSiteId");
  if (i.adsgSiteId != null && (!Number.isInteger(i.adsgSiteId) || i.adsgSiteId <= 0)) throw new RuleError("adsg", "ID AdSpyglass — целое число", "adsgSiteId");
  if (i.metrikaId && !/^\d+$/.test(i.metrikaId)) throw new RuleError("metrika", "Номер счётчика Метрики — только цифры", "metrikaId");
  const dup = await db.site.findFirst({ where: { domain, NOT: i.id ? { id: i.id } : undefined } });
  if (dup) throw new RuleError("domain_taken", "Такой домен уже есть", "domain");
  if (i.adsgSiteId) {
    const taken = await db.site.findFirst({ where: { adsgSiteId: i.adsgSiteId, NOT: i.id ? { id: i.id } : undefined } });
    if (taken) throw new RuleError("adsg_taken", `ID AdSpyglass уже у ${taken.domain}`, "adsgSiteId");
  }
  const data = { domain, title: i.title?.trim() || domain, adsgSiteId: i.adsgSiteId ?? null, metrikaId: i.metrikaId || null,
    status: i.status ?? "ACTIVE", launchedAt: i.launchedAt ? d(i.launchedAt) : null };
  const s = i.id ? await db.site.update({ where: { id: i.id }, data }) : await db.site.create({ data });
  return s.id;
}

export async function setSitesStatus(db: PrismaClient, ids: string[], status: "ACTIVE" | "PAUSED" | "ARCHIVED"): Promise<number> {
  return (await db.site.updateMany({ where: { id: { in: ids } }, data: { status } })).count;
}

export async function addSitesToBundle(db: PrismaClient, ids: string[], bundleId: string): Promise<number> {
  return (await db.bundleSite.createMany({ data: ids.map((siteId) => ({ siteId, bundleId })), skipDuplicates: true })).count;
}
export async function removeSitesFromBundle(db: PrismaClient, ids: string[], bundleId: string): Promise<number> {
  return (await db.bundleSite.deleteMany({ where: { bundleId, siteId: { in: ids } } })).count;
}

/** AdSpyglass website list rows ("137648. domain.com") that are not in TubeStat yet. */
export async function missingAsgSites(db: PrismaClient, rows: { name?: string }[]): Promise<{ adsgSiteId: number; domain: string }[]> {
  const sites = await db.site.findMany();
  const ids = new Set(sites.map((s) => s.adsgSiteId)), domains = new Set(sites.map((s) => s.domain));
  const out = new Map<number, string>();
  for (const r of rows) {
    const p = parseWebsiteName(String(r.name ?? ""));
    const domain = normalizeDomain(p.domain);
    if (p.id && !ids.has(p.id) && !domains.has(domain)) out.set(p.id, domain);
  }
  return [...out].map(([adsgSiteId, domain]) => ({ adsgSiteId, domain })).sort((a, b) => a.domain.localeCompare(b.domain));
}

// ---------- bundles ----------

export const PALETTE = ["#4F8DF7", "#A78BFA", "#F59E0B", "#14B8A6", "#EC4899", "#22C55E", "#F97316", "#06B6D4", "#8B5CF6", "#EF4444"];

export async function saveBundle(db: PrismaClient, i: { id?: string; slug: string; title: string; color: string }): Promise<string> {
  const slug = i.slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new RuleError("slug", "Слаг: латиница, цифры и дефис", "slug");
  if (!i.title.trim()) throw new RuleError("title", "Укажите название", "title");
  if (!/^#[0-9A-Fa-f]{6}$/.test(i.color)) throw new RuleError("color", "Цвет в формате #RRGGBB", "color");
  const dup = await db.bundle.findFirst({ where: { slug, NOT: i.id ? { id: i.id } : undefined } });
  if (dup) throw new RuleError("slug_taken", "Такой слаг уже есть", "slug");
  const data = { slug, title: i.title.trim(), color: i.color.toUpperCase() };
  return (i.id ? await db.bundle.update({ where: { id: i.id }, data }) : await db.bundle.create({ data })).id;
}

export async function setBundleSites(db: PrismaClient, bundleId: string, siteIds: string[]): Promise<void> {
  await db.$transaction([
    db.bundleSite.deleteMany({ where: { bundleId, siteId: { notIn: siteIds } } }),
    db.bundleSite.createMany({ data: siteIds.map((siteId) => ({ bundleId, siteId })), skipDuplicates: true }),
  ]);
}

export async function deleteBundle(db: PrismaClient, id: string): Promise<void> {
  await db.bundle.delete({ where: { id } }); // membership cascades; facts are per site and stay
}

// ---------- cost rates ----------

export interface RateInput { sourceSlug: string; siteId?: string | null; countryCode?: string | null; rateModel: "CPM" | "CPC" | "CPU" | "FLAT"; rate: string; validFrom: string; validTo?: string | null }

/** A new rate with the same scope closes the previous one at validFrom − 1 day. */
export async function addCostRate(db: PrismaClient, i: RateInput): Promise<{ id: string; closed: number }> {
  const rate = parseDecimal(i.rate);
  if (!rate.isFinite() || rate.isNegative()) throw new RuleError("rate", "Ставка — неотрицательное число", "rate");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(i.validFrom)) throw new RuleError("validFrom", "Укажите дату начала", "validFrom");
  if (i.validTo && i.validTo < i.validFrom) throw new RuleError("validTo", "Конец раньше начала", "validTo");
  if (!(await db.costSource.findUnique({ where: { slug: i.sourceSlug } }))) throw new RuleError("source", "Неизвестный источник", "sourceSlug");
  const scope = { sourceSlug: i.sourceSlug, siteId: i.siteId || null, countryCode: i.countryCode || null };
  return db.$transaction(async (tx) => {
    const open = await tx.costRate.findMany({ where: { ...scope, validFrom: { lt: d(i.validFrom) }, OR: [{ validTo: null }, { validTo: { gte: d(i.validFrom) } }] } });
    for (const r of open) await tx.costRate.update({ where: { id: r.id }, data: { validTo: d(addDays(i.validFrom, -1)) } });
    const same = await tx.costRate.findFirst({ where: { ...scope, validFrom: d(i.validFrom) } });
    if (same) throw new RuleError("dup", "Ставка с такой областью и датой начала уже есть", "validFrom");
    const r = await tx.costRate.create({ data: { ...scope, rateModel: i.rateModel, rate: rate.toString(), validFrom: d(i.validFrom), validTo: i.validTo ? d(i.validTo) : null } });
    return { id: r.id, closed: open.length };
  });
}

/** Active sites with traffic in the last 7 days and no applicable rate at all. */
export async function sitesWithoutRates(db: PrismaClient, today = isoOf(new Date())): Promise<string[]> {
  const rows = await db.$queryRaw<{ domain: string }[]>`
    SELECT s.domain FROM "Site" s WHERE s.status = 'ACTIVE'
      AND EXISTS (SELECT 1 FROM "FactTraffic" t WHERE t."siteId" = s.id AND t.date >= ${d(addDays(today, -7))})
      AND NOT EXISTS (SELECT 1 FROM "CostRate" r WHERE (r."siteId" IS NULL OR r."siteId" = s.id) AND (r."validTo" IS NULL OR r."validTo" >= ${d(today)}))
      AND NOT EXISTS (SELECT 1 FROM "FactCost" c WHERE c."siteId" = s.id AND c.origin = 'IMPORT' AND c.date >= ${d(addDays(today, -7))})
    ORDER BY 1`;
  return rows.map((r) => r.domain);
}

export async function addCostSource(db: PrismaClient, slug: string, title: string): Promise<void> {
  const s = slug.trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,40}$/.test(s)) throw new RuleError("slug", "Слаг: латиница, цифры, дефис", "slug");
  if (!title.trim()) throw new RuleError("title", "Укажите название", "title");
  await db.costSource.upsert({ where: { slug: s }, create: { slug: s, title: title.trim() }, update: { title: title.trim() } });
}

// ---------- networks ----------

export const MAX_LEGEND_COLORS = 6;

export async function saveNetwork(db: PrismaClient, i: { id: string; title: string; color: string; kind: "MEDIATED" | "DIRECT" | "MARKETPLACE"; showInLegend: boolean }): Promise<void> {
  if (!/^#[0-9A-Fa-f]{6}$/.test(i.color)) throw new RuleError("color", "Цвет в формате #RRGGBB", "color");
  const n = await db.network.findUniqueOrThrow({ where: { id: i.id } });
  if (i.showInLegend && !n.showInLegend) {
    const shown = await db.network.count({ where: { showInLegend: true, isSystem: false } });
    if (!n.isSystem && shown >= MAX_LEGEND_COLORS) throw new RuleError("legend", `Больше ${MAX_LEGEND_COLORS} цветных сеток нельзя — остальные идут в «Прочее»`, "showInLegend");
  }
  const color = n.slug === "own_deals" ? n.color : i.color.toUpperCase(); // own_deals is always green
  await db.network.update({ where: { id: i.id }, data: { title: i.title.trim() || n.title, color, kind: i.kind, showInLegend: i.showInLegend } });
}

// ---------- geo aliases ----------

export async function mapAlias(db: PrismaClient, source: string, raw: string, countryCode: string): Promise<void> {
  const cc = countryCode.trim().toUpperCase();
  if (!(await db.country.findUnique({ where: { code: cc } }))) throw new RuleError("country", "Неизвестный код страны", "countryCode");
  await db.$transaction([
    db.countryAlias.upsert({ where: { source_raw: { source, raw } }, create: { source, raw, countryCode: cc }, update: { countryCode: cc } }),
    db.unresolvedAlias.delete({ where: { source_raw: { source, raw } } }),
  ]);
}
