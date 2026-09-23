import { db } from "@/server/db";
import type { DealFormSite } from "@/components/pages/deal-form";

/** Options for the deal form: live sites with their zones, known advertisers. */
export async function dealFormOptions(): Promise<{ sites: DealFormSite[]; advertisers: string[] }> {
  const [sites, adv] = await Promise.all([
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, include: { zones: { orderBy: { name: "asc" } } }, orderBy: { domain: "asc" } }),
    db.advertiser.findMany({ orderBy: { name: "asc" } }),
  ]);
  return { sites: sites.map((s) => ({ id: s.id, domain: s.domain, zones: s.zones.map((z) => ({ id: z.id, name: z.name })) })), advertisers: adv.map((a) => a.name) };
}
