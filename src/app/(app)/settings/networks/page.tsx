import { db } from "@/server/db";
import { MAX_LEGEND_COLORS } from "@/server/services/settings";
import { NetworksTable } from "./client";

export default async function NetworksSettings() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [nets, rev] = await Promise.all([
    db.network.findMany({ where: { slug: { not: "asg_all" } }, orderBy: [{ sortOrder: "asc" }, { title: "asc" }] }),
    db.factRevenueGeo.groupBy({ by: ["networkId"], _sum: { revenueReported: true }, where: { date: { gte: since } } }),
  ]);
  const by = new Map(rev.map((r) => [r.networkId, Number(r._sum.revenueReported ?? 0)]));
  return <NetworksTable max={MAX_LEGEND_COLORS} nets={nets.map((n) => ({ id: n.id, slug: n.slug, title: n.title, color: n.color, kind: n.kind,
    showInLegend: n.showInLegend, isSystem: n.isSystem, revenue30: by.get(n.id) ?? 0 }))} />;
}
