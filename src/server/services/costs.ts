// Cost facts: nightly calculation from default rates and CSV imports that override it.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import { computeCosts, parseCostCsv, type Rate } from "@/server/domain/costs";
import { CountryResolver } from "@/server/ingest/normalize";

const d = (s: string) => new Date(`${s}T00:00:00Z`);
const isoOf = (x: Date) => x.toISOString().slice(0, 10);

function toRate(r: { id: string; siteId: string | null; countryCode: string | null; sourceSlug: string; rateModel: string; rate: unknown; validFrom: Date; validTo: Date | null }): Rate {
  return { id: r.id, siteId: r.siteId, countryCode: r.countryCode, sourceSlug: r.sourceSlug, rateModel: r.rateModel as Rate["rateModel"],
    rate: String(r.rate), validFrom: isoOf(r.validFrom), validTo: r.validTo ? isoOf(r.validTo) : null };
}

/** Recomputes RATE-origin costs in a window. Imported rows are left untouched and win. */
export async function recalcCosts(db: PrismaClient, from: string, to: string, siteId?: string): Promise<number> {
  const rates = (await db.costRate.findMany()).map(toRate);
  const sources = [...new Set(rates.map((r) => r.sourceSlug))];
  const traffic = await db.factTraffic.groupBy({
    by: ["date", "siteId", "countryCode"], _sum: { uniques: true },
    where: { date: { gte: d(from), lte: d(to) }, ...(siteId ? { siteId } : {}) },
  });
  const cells = traffic.map((t) => ({ date: isoOf(t.date), siteId: t.siteId, countryCode: t.countryCode, uniques: t._sum.uniques ?? 0 }));
  const imported = new Set((await db.factCost.findMany({
    where: { origin: "IMPORT", date: { gte: d(from), lte: d(to) }, ...(siteId ? { siteId } : {}) },
    select: { date: true, siteId: true, countryCode: true, sourceSlug: true },
  })).map((c) => `${isoOf(c.date)}|${c.siteId}|${c.countryCode}|${c.sourceSlug}`));
  const rows = sources.flatMap((s) => computeCosts(cells, rates, s))
    .filter((r) => !imported.has(`${r.date}|${r.siteId}|${r.countryCode}|${r.sourceSlug}`));
  await db.$transaction(async (tx) => {
    await tx.factCost.deleteMany({ where: { origin: "RATE", date: { gte: d(from), lte: d(to) }, ...(siteId ? { siteId } : {}) } });
    if (rows.length) await tx.factCost.createMany({ data: rows.map((r) => ({
      date: d(r.date), siteId: r.siteId, countryCode: r.countryCode, sourceSlug: r.sourceSlug, uniquesBought: r.uniquesBought,
      rateModel: r.rateModel, rate: r.rate.toString(), cost: r.cost.toString(), origin: "RATE" as const,
    })) });
  });
  return rows.length;
}

export interface ImportPreview {
  rows: number; recognised: number; total: string; overrides: number; from: string | null; to: string | null;
  unknownDomains: string[]; unknownCountries: string[]; unknownSources: string[]; errors: { line: number; reason: string }[];
}

async function prepareImport(db: PrismaClient, csv: string) {
  const parsed = parseCostCsv(csv);
  const [sites, countries, aliases, sources] = await Promise.all([db.site.findMany(), db.country.findMany(), db.countryAlias.findMany(), db.costSource.findMany()]);
  const resolver = new CountryResolver(countries, aliases);
  const byDomain = new Map(sites.map((s) => [s.domain, s]));
  const srcSet = new Set(sources.map((s) => s.slug));
  const unknownDomains = new Set<string>(), unknownSources = new Set<string>();
  const good: { date: string; siteId: string; countryCode: string; sourceSlug: string; uniques: number; cost: Decimal }[] = [];
  for (const r of parsed.rows) {
    const site = byDomain.get(r.domain);
    if (!site) { unknownDomains.add(r.domain); continue; }
    if (!srcSet.has(r.source)) { unknownSources.add(r.source); continue; }
    good.push({ date: r.date, siteId: site.id, countryCode: resolver.resolve(r.country, "csv"), sourceSlug: r.source, uniques: r.uniques, cost: new Decimal(r.cost) });
  }
  return { parsed, good, unknownDomains, unknownSources, unknownCountries: [...resolver.unresolved.values()].map((u) => u.raw) };
}

/** Preview before writing: what is recognised, what is not, the total, how many computed rows get overridden. */
export async function previewCostImport(db: PrismaClient, csv: string): Promise<ImportPreview> {
  const p = await prepareImport(db, csv);
  const dates = p.good.map((g) => g.date).sort();
  let overrides = 0;
  for (const g of p.good) {
    const hit = await db.factCost.findUnique({ where: { date_siteId_countryCode_sourceSlug: { date: d(g.date), siteId: g.siteId, countryCode: g.countryCode, sourceSlug: g.sourceSlug } } });
    if (hit?.origin === "RATE") overrides++;
  }
  return {
    rows: p.parsed.rows.length + p.parsed.errors.length, recognised: p.good.length,
    total: p.good.reduce((a, g) => a.add(g.cost), new Decimal(0)).toFixed(2), overrides,
    from: dates[0] ?? null, to: dates[dates.length - 1] ?? null,
    unknownDomains: [...p.unknownDomains], unknownCountries: p.unknownCountries, unknownSources: [...p.unknownSources], errors: p.parsed.errors,
  };
}

export async function applyCostImport(db: PrismaClient, csv: string, fileName: string): Promise<{ batchId: string; rows: number }> {
  const p = await prepareImport(db, csv);
  const total = p.good.reduce((a, g) => a.add(g.cost), new Decimal(0));
  const batch = await db.importBatch.create({ data: { kind: "costs", fileName, rows: p.good.length, total: total.toString() } });
  await db.$transaction(async (tx) => {
    for (const g of p.good) {
      const key = { date: d(g.date), siteId: g.siteId, countryCode: g.countryCode, sourceSlug: g.sourceSlug };
      const data = { uniquesBought: g.uniques, rateModel: "FLAT" as const, rate: g.cost.toString(), cost: g.cost.toString(), origin: "IMPORT" as const, importBatchId: batch.id };
      await tx.factCost.upsert({ where: { date_siteId_countryCode_sourceSlug: key }, create: { ...key, ...data }, update: data });
    }
  });
  return { batchId: batch.id, rows: p.good.length };
}

/** Removes an import and restores computed costs for its window. */
export async function revertCostImport(db: PrismaClient, batchId: string): Promise<void> {
  const rows = await db.factCost.findMany({ where: { importBatchId: batchId }, select: { date: true } });
  await db.factCost.deleteMany({ where: { importBatchId: batchId } });
  await db.importBatch.update({ where: { id: batchId }, data: { revertedAt: new Date() } });
  if (rows.length) {
    const ds = rows.map((r) => isoOf(r.date)).sort();
    await recalcCosts(db, ds[0], ds[ds.length - 1]);
  }
}
