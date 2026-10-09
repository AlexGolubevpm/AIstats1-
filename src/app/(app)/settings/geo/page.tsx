import { db } from "@/server/db";
import { TiersTable } from "./client";

/** Countries and their tiers 1–5 (ADR 0017): the deals' «T1…T5» and the geo pages' tier filter read them from here. */
export default async function GeoSettings() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [countries, traffic, edits] = await Promise.all([
    db.country.findMany({ where: { tier: { gt: 0 } }, orderBy: [{ tier: "asc" }, { nameRu: "asc" }] }),
    db.factRevenueGeo.groupBy({ by: ["countryCode"], _sum: { pageLoads: true, revenueReported: true }, where: { date: { gte: since } } }),
    db.auditLog.findMany({ where: { entity: "Country", field: "tier" }, orderBy: { at: "desc" }, take: 20 }),
  ]);
  const by = new Map(traffic.map((t) => [t.countryCode, { loads: t._sum.pageLoads ?? 0, revenue: Number(t._sum.revenueReported ?? 0) }]));
  return <TiersTable countries={countries.map((c) => ({ code: c.code, name: c.nameRu, tier: c.tier, loads30: by.get(c.code)?.loads ?? 0, revenue30: by.get(c.code)?.revenue ?? 0 }))}
    edits={edits.map((e) => ({ id: e.id, code: e.entityId, before: e.before, after: e.after, reason: e.reason, at: e.at.toISOString() }))} />;
}
