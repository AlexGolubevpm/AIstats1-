import { db } from "@/server/db";
import { SitesManager } from "./client";

export default async function SitesSettings() {
  const [sites, bundles, last] = await Promise.all([
    db.site.findMany({ include: { bundles: { include: { bundle: true } } }, orderBy: [{ status: "asc" }, { domain: "asc" }] }),
    db.bundle.findMany({ orderBy: { title: "asc" } }),
    db.$queryRaw<{ site_id: string; asg: Date | null; met: Date | null }[]>`
      SELECT s.id site_id, (SELECT max(date) FROM "FactRevenueGeo" g WHERE g."siteId" = s.id) asg, (SELECT max(date) FROM "FactTraffic" t WHERE t."siteId" = s.id) met FROM "Site" s`,
  ]);
  const byId = new Map(last.map((l) => [l.site_id, l]));
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return (
    <SitesManager bundles={bundles.map((b) => ({ id: b.id, title: b.title }))}
      sites={sites.map((s) => ({ id: s.id, domain: s.domain, title: s.title, adsgSiteId: s.adsgSiteId, metrikaId: s.metrikaId, status: s.status,
        launchedAt: s.launchedAt ? s.launchedAt.toISOString().slice(0, 10) : null, bundles: s.bundles.map((b) => ({ id: b.bundle.id, title: b.bundle.title, color: b.bundle.color })),
        lastAsg: iso(byId.get(s.id)?.asg), lastMetrika: iso(byId.get(s.id)?.met) }))} />
  );
}
