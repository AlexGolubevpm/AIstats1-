import { db } from "@/server/db";
import { PALETTE } from "@/server/services/settings";
import { BundlesManager } from "./client";

export default async function BundlesSettings() {
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [bundles, sites, rev] = await Promise.all([
    db.bundle.findMany({ include: { sites: true }, orderBy: { title: "asc" } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, include: { bundles: { include: { bundle: true } } }, orderBy: { domain: "asc" } }),
    db.$queryRaw<{ bundle_id: string; r: number }[]>`SELECT bundle_id, SUM(revenue)::float8 r FROM v_bundle_daily WHERE date >= ${since} GROUP BY 1`,
  ]);
  const revBy = new Map(rev.map((r) => [r.bundle_id, r.r]));
  return (
    <BundlesManager palette={PALETTE}
      bundles={bundles.map((b) => ({ id: b.id, slug: b.slug, title: b.title, color: b.color, siteIds: b.sites.map((s) => s.siteId), revenue30: revBy.get(b.id) ?? 0 }))}
      sites={sites.map((s) => ({ id: s.id, domain: s.domain, bundles: s.bundles.map((x) => x.bundle.title) }))} />
  );
}
