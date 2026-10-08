// Hypotheses on the database: the nightly generation (rules + alerts → stored proposals), the owner's
// own hypotheses, status changes and the measurement of a result. docs/product/03-pages.md#hypotheses, ADR 0013.
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { RuleError, parseDecimal } from "@/server/domain/errors";
import { METRICS, type HypScope, type HypothesisCandidate, type Metric } from "@/server/domain/hypotheses";
import { collectCandidates } from "@/server/queries/hypotheses";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const isoOf = (x: Date) => x.toISOString().slice(0, 10);
const DAY = 86_400_000;
const addDays = (s: string, n: number) => isoOf(new Date(d(s).getTime() + n * DAY));
/** A rejected proposal stays silent this long before the rules may raise it again. */
export const REJECT_QUIET_DAYS = 30;
/** Baseline and result are both measured over this many days. */
export const MEASURE_DAYS = 14;
export const MIN_MEASURE_DAYS = 7;

const fields = (c: HypothesisCandidate) => ({
  scope: c.scope, level: c.level, title: c.title, hypothesis: c.hypothesis, evidence: c.evidence as never, impactMonth: c.impactMonth.toFixed(4), link: c.link, metric: c.metric,
  alertId: c.alertId ?? null, siteId: c.siteId ?? null, bundleId: c.bundleId ?? null, format: (c.format as never) ?? null, zoneId: c.zoneId ?? null,
  networkId: c.networkId ?? null, countryCode: c.countryCode ?? null, sourceSlug: c.sourceSlug ?? null, dealId: c.dealId ?? null,
});

/**
 * Nightly (and on worker start): every candidate becomes or refreshes a stored hypothesis.
 * New → PROPOSED; known → evidence, effect and lastSeenAt refreshed, status kept; a PROPOSED one the
 * rules no longer produce → EXPIRED (back to PROPOSED when it returns); REJECTED stays quiet 30 days.
 */
export async function generateHypotheses(db: PrismaClient, today = isoOf(new Date())): Promise<{ created: number; refreshed: number; expired: number }> {
  const candidates = await collectCandidates(today);
  const now = new Date();
  const known = await db.hypothesis.findMany({ where: { ruleKey: { not: null } }, select: { id: true, ruleKey: true, objectKey: true, status: true, closedAt: true } });
  const byKey = new Map(known.map((h) => [`${h.ruleKey}|${h.objectKey}`, h]));
  let created = 0, refreshed = 0;
  const seen = new Set<string>();
  for (const c of candidates) {
    const key = `${c.ruleKey}|${c.objectKey}`;
    seen.add(key);
    const cur = byKey.get(key);
    if (!cur) {
      await db.hypothesis.create({ data: { source: c.source, status: "PROPOSED", ruleKey: c.ruleKey, objectKey: c.objectKey, ...fields(c), firstSeenAt: now, lastSeenAt: now } });
      created++;
      continue;
    }
    const quiet = cur.status === "REJECTED" && cur.closedAt && now.getTime() - cur.closedAt.getTime() < REJECT_QUIET_DAYS * DAY;
    const reopen = cur.status === "EXPIRED" || (cur.status === "REJECTED" && !quiet);
    // Accepted and done ones keep their text: the owner is working from it. Their numbers still move.
    const data = cur.status === "ACCEPTED" || cur.status === "DONE"
      ? { evidence: c.evidence as never, impactMonth: c.impactMonth.toFixed(4), lastSeenAt: now }
      : { ...fields(c), source: c.source, lastSeenAt: now, ...(reopen ? { status: "PROPOSED" as const, closedAt: null, firstSeenAt: now } : {}) };
    await db.hypothesis.update({ where: { id: cur.id }, data });
    refreshed++;
  }
  const gone = known.filter((h) => h.status === "PROPOSED" && !seen.has(`${h.ruleKey}|${h.objectKey}`)).map((h) => h.id);
  if (gone.length) await db.hypothesis.updateMany({ where: { id: { in: gone } }, data: { status: "EXPIRED", closedAt: now } });
  return { created, refreshed, expired: gone.length };
}

export interface HypothesisInput {
  title: string; hypothesis: string; bundleId?: string | null; siteId?: string | null; format?: string | null; countryCode?: string | null;
  impactMonth?: string | null; metric?: string | null;
}

const SCOPE_OF = (i: HypothesisInput): HypScope => (i.format ? "format" : i.countryCode ? "geo" : i.siteId ? "site" : "bundle");

/** The owner's own hypothesis: at least a bundle or a site, a real sentence, optional format / geo / effect / metric. */
export async function createHypothesis(db: PrismaClient, i: HypothesisInput): Promise<string> {
  if (!i.bundleId && !i.siteId) throw new RuleError("object", "Выберите бандл или сайт", "siteId");
  if (!i.title.trim()) throw new RuleError("title", "Назовите гипотезу", "title");
  if (i.hypothesis.trim().length < 10) throw new RuleError("hypothesis", "Опишите гипотезу: если …, то …", "hypothesis");
  const site = i.siteId ? await db.site.findUnique({ where: { id: i.siteId } }) : null;
  if (i.siteId && !site) throw new RuleError("site", "Сайт не найден", "siteId");
  const bundle = i.bundleId ? await db.bundle.findUnique({ where: { id: i.bundleId }, include: { sites: true } }) : null;
  if (i.bundleId && !bundle) throw new RuleError("bundle", "Бандл не найден", "bundleId");
  if (site && bundle && !bundle.sites.some((s) => s.siteId === site.id)) throw new RuleError("bundle", "Сайт не входит в этот бандл", "bundleId");
  if (i.metric && !METRICS.includes(i.metric as Metric)) throw new RuleError("metric", "Неизвестная метрика", "metric");
  let impact: string | null = null;
  if (i.impactMonth) {
    const v = parseDecimal(i.impactMonth);
    if (!v.isFinite() || v.lt(0)) throw new RuleError("impact", "Эффект — число, $ в месяц", "impactMonth");
    impact = v.toFixed(4);
  }
  const link = site ? `/sites/${site.domain}` : bundle ? `/bundles/${bundle.slug}` : "/hypotheses";
  const h = await db.hypothesis.create({ data: {
    source: "MANUAL", status: "PROPOSED", level: "INFO", scope: SCOPE_OF(i), title: i.title.trim(), hypothesis: i.hypothesis.trim(), link,
    bundleId: bundle?.id ?? null, siteId: site?.id ?? null, format: (i.format || null) as never, countryCode: i.countryCode?.toUpperCase() || null,
    impactMonth: impact, metric: (i.metric as Metric) || null, evidence: {},
  } });
  await db.auditLog.create({ data: { entity: "Hypothesis", entityId: h.id, field: "status", before: null, after: "PROPOSED", reason: "своя гипотеза" } });
  return h.id;
}

export type HypothesisTransition = "ACCEPTED" | "DONE" | "REJECTED" | "PROPOSED";

/** Accept (freezes the baseline), finish (measures the result), reject, or reopen a hypothesis. */
export async function setHypothesisStatus(db: PrismaClient, id: string, to: HypothesisTransition, note?: string | null, today = isoOf(new Date())): Promise<void> {
  const h = await db.hypothesis.findUniqueOrThrow({ where: { id } });
  const allowed: Record<HypothesisTransition, string[]> = { ACCEPTED: ["PROPOSED", "EXPIRED"], DONE: ["ACCEPTED"], REJECTED: ["PROPOSED", "ACCEPTED", "EXPIRED"], PROPOSED: ["DONE", "REJECTED", "EXPIRED"] };
  if (!allowed[to].includes(h.status)) throw new RuleError("status", `Из статуса «${h.status}» нельзя перейти в «${to}»`);
  const now = new Date();
  let data: Record<string, unknown> = { status: to };
  if (to === "ACCEPTED") {
    const base = await measureMetric(db, h, addDays(today, -MEASURE_DAYS), addDays(today, -1));
    data = { ...data, acceptedAt: now, closedAt: null, baseline: base.days >= MIN_MEASURE_DAYS && base.value != null ? base.value.toFixed(6) : null, result: null, resultNote: null };
  } else if (to === "DONE") {
    // The result is the same metric over the last 14 days, but never before the day it was accepted (minimum 7 days of data).
    const from = h.acceptedAt && isoOf(h.acceptedAt) > addDays(today, -MEASURE_DAYS) ? isoOf(h.acceptedAt) : addDays(today, -MEASURE_DAYS);
    const res = await measureMetric(db, h, from, addDays(today, -1));
    data = { ...data, closedAt: now, result: res.days >= MIN_MEASURE_DAYS && res.value != null ? res.value.toFixed(6) : null, resultNote: note?.trim() || null };
  } else if (to === "REJECTED") {
    data = { ...data, closedAt: now, resultNote: note?.trim() || null };
  } else {
    data = { ...data, closedAt: null, acceptedAt: null, baseline: null, result: null, resultNote: null, firstSeenAt: now, lastSeenAt: now };
  }
  await db.hypothesis.update({ where: { id }, data });
  await db.auditLog.create({ data: { entity: "Hypothesis", entityId: id, field: "status", before: h.status, after: to, reason: note?.trim() || null } });
}

/** A hypothesis from an alert, by hand (the nightly run makes the same one; this is for "now"). */
export async function hypothesisFromAlert(db: PrismaClient, alertId: string, today = isoOf(new Date())): Promise<string> {
  const a = await db.alert.findUniqueOrThrow({ where: { id: alertId } });
  const existing = await db.hypothesis.findUnique({ where: { ruleKey_objectKey: { ruleKey: a.rule, objectKey: a.entityKey } } });
  if (existing) {
    if (existing.status === "EXPIRED" || existing.status === "REJECTED") await setHypothesisStatus(db, existing.id, "PROPOSED", null, today);
    return existing.id;
  }
  const { fromAlert } = await import("@/server/domain/hypotheses");
  const domain = a.siteId ? (await db.site.findUnique({ where: { id: a.siteId } }))?.domain ?? null : null;
  const c = fromAlert({ id: a.id, rule: a.rule, entityKey: a.entityKey, level: a.level, title: a.title, message: a.message, link: a.link, siteId: a.siteId, domain,
    moneyAtRisk: Number(a.moneyAtRisk), action: typeof (a.payload as Record<string, unknown>)?.action === "string" ? String((a.payload as Record<string, unknown>).action) : null });
  const h = await db.hypothesis.create({ data: { source: "ALERT", status: "PROPOSED", ruleKey: c.ruleKey, objectKey: c.objectKey, ...fields(c) } });
  return h.id;
}

type Measured = { id: string; metric: string | null; siteId: string | null; bundleId: string | null; countryCode: string | null; zoneId: string | null; networkId: string | null; format: string | null; sourceSlug: string | null; dealId: string | null };
type Raw = Record<string, unknown>;
const n = (v: unknown) => (v == null ? 0 : Number(v));

/**
 * The hypothesis's metric over its object for a window: zone → v_zone_daily, network → v_network_geo,
 * format → v_format_daily, source → FactCost / FactTrafficSource, deal → v_deal_daily, otherwise the
 * site / bundle / country slice of v_site_geo_daily. Returns the value and how many days had data.
 */
export async function measureMetric(db: PrismaClient, h: Measured, from: string, to: string): Promise<{ value: number | null; days: number }> {
  const metric = h.metric as Metric | null;
  if (!metric) return { value: null, days: 0 };
  const range = { from: d(from), to: d(to) };
  const ratio = (a: number, b: number, k = 1) => (b > 0 ? (a / b) * k : null);
  let row: Raw | undefined;
  if (h.zoneId) {
    [row] = await db.$queryRaw<Raw[]>`SELECT COUNT(DISTINCT date) days, SUM(revenue)::float8 revenue, SUM(page_loads)::float8 loads, SUM(views)::float8 views, SUM(imps_own)::float8 imps
      FROM v_zone_daily WHERE zone_id = ${h.zoneId} AND date BETWEEN ${range.from} AND ${range.to}`;
  } else if (h.networkId && h.siteId) {
    [row] = await db.$queryRaw<Raw[]>`SELECT COUNT(DISTINCT date) days, SUM(revenue)::float8 revenue, SUM(page_loads)::float8 loads
      FROM v_network_geo WHERE site_id = ${h.siteId} AND network_id = ${h.networkId} AND date BETWEEN ${range.from} AND ${range.to}`;
  } else if (h.format && h.siteId && !h.dealId) {
    [row] = await db.$queryRaw<Raw[]>`SELECT COUNT(DISTINCT date) days, SUM(revenue)::float8 revenue, SUM(page_loads)::float8 loads
      FROM v_format_daily WHERE site_id = ${h.siteId} AND format = ${h.format} AND date BETWEEN ${range.from} AND ${range.to}`;
  } else if (h.sourceSlug && h.siteId) {
    [row] = await db.$queryRaw<Raw[]>`SELECT (SELECT COUNT(DISTINCT date) FROM "FactTrafficSource" WHERE "siteId" = ${h.siteId} AND "sourceSlug" = ${h.sourceSlug} AND date BETWEEN ${range.from} AND ${range.to}) days,
      (SELECT SUM(cost) FROM "FactCost" WHERE "siteId" = ${h.siteId} AND "sourceSlug" = ${h.sourceSlug} AND date BETWEEN ${range.from} AND ${range.to})::float8 cost,
      (SELECT SUM("pageLoads") FROM "FactTrafficSource" WHERE "siteId" = ${h.siteId} AND "sourceSlug" = ${h.sourceSlug} AND date BETWEEN ${range.from} AND ${range.to})::float8 loads,
      (SELECT SUM(revenue) FROM v_site_geo_daily WHERE site_id = ${h.siteId} AND date BETWEEN ${range.from} AND ${range.to})::float8 revenue`;
  } else if (h.dealId) {
    [row] = await db.$queryRaw<Raw[]>`SELECT COUNT(DISTINCT date) days, SUM(revenue)::float8 revenue, SUM(page_loads)::float8 loads
      FROM v_deal_daily WHERE deal_id = ${h.dealId} ${h.siteId ? Prisma.sql`AND site_id = ${h.siteId}` : Prisma.empty} AND date BETWEEN ${range.from} AND ${range.to}`;
  } else {
    const siteIds = h.siteId ? [h.siteId] : h.bundleId ? (await db.bundleSite.findMany({ where: { bundleId: h.bundleId } })).map((b) => b.siteId) : null;
    if (!siteIds?.length) return { value: null, days: 0 };
    [row] = await db.$queryRaw<Raw[]>`SELECT COUNT(DISTINCT date) days, SUM(revenue)::float8 revenue, SUM(cost)::float8 cost, SUM(page_loads)::float8 loads, SUM(uniques)::float8 uniques
      FROM v_site_geo_daily WHERE site_id IN (${Prisma.join(siteIds)}) ${h.countryCode ? Prisma.sql`AND country_code = ${h.countryCode}` : Prisma.empty} AND date BETWEEN ${range.from} AND ${range.to}`;
  }
  if (!row) return { value: null, days: 0 };
  const revenue = n(row.revenue), cost = n(row.cost), loads = n(row.loads), days = n(row.days);
  const value: number | null =
    metric === "revenue" ? revenue : metric === "margin" ? revenue - cost : metric === "rev_per_1k" ? ratio(revenue, loads, 1000) : metric === "rpm" ? ratio(revenue, n(row.uniques), 1000)
    : metric === "view_rate" ? ratio(n(row.views), n(row.imps)) : metric === "cost_per_1k" ? ratio(cost, loads, 1000) : metric === "cost_share" ? ratio(cost, revenue) : null;
  return { value: value == null || !Number.isFinite(value) ? null : value, days };
}
