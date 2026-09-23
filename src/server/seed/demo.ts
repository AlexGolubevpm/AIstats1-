// Demo data so the UI can be explored before real ingest works. Deterministic (seeded PRNG),
// flagged with AppSetting demo_data=1 so every page shows a "демо-данные" banner, and removable.
import type { PrismaClient } from "@/generated/prisma/client";
import { addDays } from "@/lib/period";
import { seedReference } from "./reference";

function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

const BUNDLES = [
  { slug: "jav", title: "JAV", color: "#4F8DF7", sites: ["japan-tube.demo", "tokyo-clips.demo", "asian-hub.demo", "jav-stream.demo"] },
  { slug: "hentai", title: "Hentai", color: "#A78BFA", sites: ["hentai-land.demo", "anime-x.demo", "toon-tube.demo"] },
  { slug: "gay", title: "Gay", color: "#F472B6", sites: ["gay-tube.demo", "men-clips.demo", "boys-hub.demo"] },
  { slug: "trans", title: "Trans", color: "#2DD4BF", sites: ["trans-tube.demo", "ts-stream.demo"] },
];
// japan-tube.demo also sits in a cross-bundle "top" to exercise bundle overlaps.
const TOP = { slug: "top", title: "Топ-сайты", color: "#FBBF24", sites: ["japan-tube.demo", "hentai-land.demo", "gay-tube.demo"] };

const GEOS: [string, number, number][] = [ // code, traffic weight, $ per 1000 loads
  ["US", 18, 2.1], ["JP", 16, 2.6], ["DE", 9, 1.9], ["GB", 8, 2.0], ["FR", 7, 1.6], ["CA", 5, 1.8], ["AU", 4, 1.9],
  ["BR", 6, 0.5], ["IN", 7, 0.25], ["MX", 4, 0.6], ["IT", 4, 1.2], ["ES", 4, 1.1], ["PL", 3, 0.8], ["TR", 3, 0.5], ["KR", 2, 1.5],
];
const NETS: [string, number][] = [["adpulsar", 0.4], ["trafficstars", 0.25], ["clickadu", 0.15], ["exoclick", 0.12], ["marketplace", 0.08]];
const ZONES: [string, "POPUNDER" | "BANNER" | "NATIVE" | "SLIDER" | "INVIDEO", number, number][] = [ // name, format, revenue share, view rate
  ["Popunder", "POPUNDER", 0.42, 0], ["Banners_Footer_A", "BANNER", 0.04, 0.09], ["Banners_Footer_B", "BANNER", 0.006, 0.07],
  ["Banners_Sidebar", "BANNER", 0.08, 0.38], ["Native_Grid", "NATIVE", 0.14, 0.55], ["Slider", "SLIDER", 0.18, 0], ["Preroll_VAST", "INVIDEO", 0.12, 0],
];

export async function isDemo(db: PrismaClient): Promise<boolean> {
  return Boolean(await db.appSetting.findUnique({ where: { key: "demo_data" } }));
}

/** Removes every non-reference row. Used before loading demo data and by "Удалить демо-данные". */
export async function clearData(db: PrismaClient): Promise<void> {
  const tables = ["FactRevenueGeo", "FactRevenueZone", "FactTraffic", "FactCost", "FactFixDeal", "DealPeriod", "DealSite", "Deal", "Advertiser",
    "Zone", "BundleSite", "Bundle", "Site", "CostRate", "Alert", "IngestRun", "ImportBatch", "AuditLog", "AsgPayout", "UnresolvedAlias"];
  await db.$executeRawUnsafe(`TRUNCATE ${tables.map((t) => `"${t}"`).join(", ")} CASCADE`);
  await db.appSetting.deleteMany({ where: { key: { in: ["demo_data", "asg_unknown_sites"] } } });
}

export async function seedDemo(db: PrismaClient, opts: { days?: number; today?: string; seed?: number } = {}): Promise<{ sites: number; days: number }> {
  const days = opts.days ?? 60;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const rnd = prng(opts.seed ?? 42);
  await seedReference(db);
  await clearData(db);

  const nets = new Map((await db.network.findMany()).map((n) => [n.slug, n.id]));
  const siteIds = new Map<string, string>();
  let adsg = 137600;
  for (const b of [...BUNDLES, TOP]) {
    const bundle = await db.bundle.create({ data: { slug: b.slug, title: b.title, color: b.color } });
    for (const domain of b.sites) {
      if (!siteIds.has(domain)) {
        const s = await db.site.create({ data: { domain, title: domain.split(".")[0].replace(/-/g, " "), adsgSiteId: ++adsg, metrikaId: String(90_000_000 + adsg),
          launchedAt: new Date(`${addDays(today, -400 + Math.floor(rnd() * 300))}T00:00:00Z`) } });
        siteIds.set(domain, s.id);
      }
      await db.bundleSite.create({ data: { bundleId: bundle.id, siteId: siteIds.get(domain)! } });
    }
  }

  // Per-site character: size, monetisation quality, how much we overpay for traffic.
  const sites = [...siteIds].map(([domain, id], i) => ({ domain, id, size: 0.4 + rnd() * 1.6, quality: 0.6 + rnd() * 0.8, overpay: i % 5 === 3 ? 1.35 : 0.55 + rnd() * 0.35 }));
  const zoneIds = new Map<string, { id: string; format: string; share: number; vr: number }[]>();
  let zid = 491000;
  for (const s of sites) {
    const list = [];
    for (const [name, format, share, vr] of ZONES) {
      const z = await db.zone.create({ data: { adsgZoneId: ++zid, siteId: s.id, name, format, position: name.includes("Footer") ? "footer" : name.includes("Sidebar") ? "sidebar" : null } });
      list.push({ id: z.id, format, share, vr });
    }
    zoneIds.set(s.id, list);
  }

  const geo: object[] = [], zone: object[] = [], traffic: object[] = [];
  for (let k = days; k >= 1; k--) {
    const date = new Date(`${addDays(today, -k)}T00:00:00Z`);
    const season = 1 + 0.15 * Math.sin(k / 5) + (k < 10 ? 0.05 : 0);
    for (const s of sites) {
      let siteRevenue = 0, siteLoads = 0;
      for (const [cc, w, price] of GEOS) {
        const uniques = Math.round(900 * s.size * w * season * (0.85 + rnd() * 0.3));
        const pageviews = Math.round(uniques * (2.4 + rnd() * 1.4));
        const loads = pageviews;
        traffic.push({ date, siteId: s.id, countryCode: cc, device: rnd() > 0.35 ? "MOBILE" : "DESKTOP", uniques, pageviews, sessions: Math.round(uniques * 1.2),
          bounceRate: (35 + rnd() * 25).toFixed(2), avgDepth: (pageviews / uniques).toFixed(2) });
        for (const [slug, share] of NETS) {
          const fill = 0.55 + rnd() * 0.35;
          const l = Math.round(loads * share);
          // Network 4 in DE on a few sites takes volume at a low price: waterfall inversion.
          const inverted = slug === "exoclick" && cc === "DE" && s.domain.startsWith("t");
          const revenue = (l / 1000) * price * s.quality * (inverted ? 0.35 : 0.75 + share * 0.9) * (0.9 + rnd() * 0.2);
          const imps = Math.round(l * fill);
          geo.push({ date, siteId: s.id, networkId: nets.get(slug)!, countryCode: cc, device: "UNKNOWN",
            pageLoads: inverted ? Math.round(l * 4) : l, impsOwn: imps, impsNetwork: Math.round(imps * (slug === "clickadu" && cc === "US" && s.domain.startsWith("a") ? 2.3 : 0.93 + rnd() * 0.05)),
            clicks: Math.round(imps * 0.004), revenueReported: revenue.toFixed(4) });
          siteRevenue += revenue; siteLoads += l;
        }
      }
      for (const z of zoneIds.get(s.id)!) {
        const imps = Math.round(siteLoads * (z.format === "POPUNDER" ? 0.35 : z.format === "BANNER" ? 1.6 : 0.7));
        zone.push({ date, siteId: s.id, zoneId: z.id, format: z.format, pageLoads: siteLoads, impsOwn: imps, impsNetwork: Math.round(imps * 0.95),
          views: z.vr ? Math.round(imps * z.vr * (0.9 + rnd() * 0.2)) : 0, clicks: Math.round(imps * 0.003),
          revenueReported: (siteRevenue * z.share * (0.9 + rnd() * 0.2)).toFixed(4) });
      }
    }
  }
  for (let i = 0; i < geo.length; i += 5000) await db.factRevenueGeo.createMany({ data: geo.slice(i, i + 5000) as never });
  for (let i = 0; i < zone.length; i += 5000) await db.factRevenueZone.createMany({ data: zone.slice(i, i + 5000) as never });
  for (let i = 0; i < traffic.length; i += 5000) await db.factTraffic.createMany({ data: traffic.slice(i, i + 5000) as never });

  // Cost rates: global CPU plus per-site overrides for over-paying sites; IN/BR bought too expensive.
  const from = new Date(`${addDays(today, -days - 1)}T00:00:00Z`);
  await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPU", rate: "0.00095", validFrom: from } });
  await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPU", rate: "0.0009", countryCode: "IN", validFrom: from } });
  await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPU", rate: "0.0011", countryCode: "BR", validFrom: from } });
  for (const s of sites) {
    await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPU", rate: (0.0048 * s.overpay * s.quality).toFixed(5), siteId: s.id, validFrom: from } });
    // Traffic is bought cheaper where it earns less; a few geos still lose money on overpaying sites.
    for (const [cc, , value] of GEOS.filter(([, , v]) => v < 1.5)) {
      await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPU", rate: (0.0048 * s.overpay * s.quality * (value / 1.45)).toFixed(5), siteId: s.id, countryCode: cc, validFrom: from } });
    }
  }

  const acme = await db.advertiser.create({ data: { name: "Sakura Media" } });
  const vid = await db.advertiser.create({ data: { name: "VidPromo" } });
  const jp = siteIds.get("japan-tube.demo")!, hl = siteIds.get("hentai-land.demo")!;
  const start = new Date(`${addDays(today, -days)}T00:00:00Z`);
  await db.deal.create({ data: { title: "JP спонсорский баннер", advertiserId: acme.id, format: "BANNER", paymentBasis: "PER_1000_LOADS", price: "0.8",
    geoScope: ["JP"], startsAt: start, sites: { create: [{ siteId: jp }] } } });
  await db.deal.create({ data: { title: "Tier-1 прероллы", advertiserId: vid.id, format: "INVIDEO", paymentBasis: "CPM_ADVERTISER", price: "1.2",
    geoScope: ["US", "GB", "DE", "CA", "AU", "JP"], startsAt: start, sites: { create: [{ siteId: hl }, { siteId: jp }] } } });

  await db.appSetting.upsert({ where: { key: "demo_data" }, create: { key: "demo_data", value: "1" }, update: { value: "1" } });
  return { sites: sites.length, days };
}
