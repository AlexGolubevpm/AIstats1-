// Reference network used by view, alert and MCP tests (docs/engineering/10-testing.md):
// bundles jav + hentai; site s2 belongs to both, so bundle sums exceed the network total.
// Two days, two countries, a mediated network plus own_deals, one DIRECT and one VIA_ASG deal.
import type { PrismaClient } from "@/generated/prisma/client";
import { seedReference } from "@/server/seed/reference";

export const D1 = new Date("2026-09-20T00:00:00Z");
export const D2 = new Date("2026-09-21T00:00:00Z");

export async function buildNetwork(db: PrismaClient) {
  await seedReference(db);
  const net = await db.network.findUniqueOrThrow({ where: { slug: "adpulsar" } });
  const own = await db.network.findUniqueOrThrow({ where: { slug: "own_deals" } });
  const [jav, hentai] = await Promise.all([
    db.bundle.create({ data: { slug: "jav", title: "JAV", color: "#4F8DF7" } }),
    db.bundle.create({ data: { slug: "hentai", title: "Hentai", color: "#A78BFA" } }),
  ]);
  const s1 = await db.site.create({ data: { id: "s1", domain: "one.test", title: "One", adsgSiteId: 1 } });
  const s2 = await db.site.create({ data: { id: "s2", domain: "two.test", title: "Two", adsgSiteId: 2 } });
  const s3 = await db.site.create({ data: { id: "s3", domain: "three.test", title: "Three", adsgSiteId: 3 } });
  await db.bundleSite.createMany({
    data: [
      { bundleId: jav.id, siteId: s1.id }, { bundleId: jav.id, siteId: s2.id },
      { bundleId: hentai.id, siteId: s2.id }, { bundleId: hentai.id, siteId: s3.id },
    ],
  });

  // Mediated revenue: $10 per site per country per day; own_deals $2 on s1/JP (via ASG).
  const geo = [];
  for (const date of [D1, D2]) for (const site of [s1, s2, s3]) for (const cc of ["JP", "US"]) {
    geo.push({ date, siteId: site.id, networkId: net.id, countryCode: cc, device: "DESKTOP" as const,
      pageLoads: 10_000, impsOwn: 8_000, impsNetwork: 7_600, revenueReported: "10" });
  }
  geo.push({ date: D1, siteId: s1.id, networkId: own.id, countryCode: "JP", device: "DESKTOP" as const,
    pageLoads: 0, impsOwn: 1_000, impsNetwork: 1_000, revenueReported: "2" });
  await db.factRevenueGeo.createMany({ data: geo });

  // Traffic 1000 uniques per cell; cost $12 per cell on JP (loss-making: revenue 10 < 12), $5 on US.
  const traffic = [], costs = [];
  for (const date of [D1, D2]) for (const site of [s1, s2, s3]) for (const cc of ["JP", "US"]) {
    traffic.push({ date, siteId: site.id, countryCode: cc, device: "DESKTOP" as const, uniques: 1_000, pageviews: 3_000, sessions: 1_200 });
    costs.push({ date, siteId: site.id, countryCode: cc, sourceSlug: "tubecrown", uniquesBought: 1_000,
      rateModel: "CPU" as const, rate: cc === "JP" ? "0.012" : "0.005", cost: cc === "JP" ? "12" : "5" });
  }
  await db.factTraffic.createMany({ data: traffic });
  await db.factCost.createMany({ data: costs });

  const adv = await db.advertiser.create({ data: { name: "Acme Ads" } });
  const direct = await db.deal.create({ data: { title: "Sponsor banner", advertiserId: adv.id, format: "BANNER",
    price: "1", startsAt: D1, billedVia: "DIRECT", sites: { create: [{ siteId: s3.id }] } } });
  const viaAsg = await db.deal.create({ data: { title: "Own popunder", advertiserId: adv.id, format: "POPUNDER",
    price: "2", startsAt: D1, billedVia: "VIA_ASG", sites: { create: [{ siteId: s1.id }] } } });
  await db.factFixDeal.createMany({
    data: [
      { date: D1, dealId: direct.id, siteId: s3.id, countryCode: "US", pageLoads: 3_000, impsOwn: 3_000, impsReported: 3_600, revenue: "3", revenueState: "CONFIRMED" },
      { date: D2, dealId: direct.id, siteId: s3.id, countryCode: "US", pageLoads: 3_000, impsOwn: 3_000, revenue: "3", revenueState: "FORECAST" },
      // Already inside ASG revenue as own_deals — must not be added again.
      { date: D1, dealId: viaAsg.id, siteId: s1.id, countryCode: "JP", pageLoads: 1_000, impsOwn: 1_000, revenue: "2", revenueState: "CONFIRMED" },
    ],
  });

  const zone = await db.zone.create({ data: { adsgZoneId: 900, siteId: s1.id, name: "Banners_Footer_A", format: "BANNER", position: "footer" } });
  await db.factRevenueZone.create({ data: { date: D1, siteId: s1.id, zoneId: zone.id, format: "BANNER",
    pageLoads: 10_000, impsOwn: 60_000, views: 6_000, revenueReported: "1.2" } });

  return { jav, hentai, s1, s2, s3, net, own, direct, viaAsg, zone };
}
