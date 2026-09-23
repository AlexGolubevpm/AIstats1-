// Reference data every environment needs: countries with tiers, known country aliases,
// networks with fixed colours, traffic sources. Idempotent — safe to run on every deploy.
import countries from "../../../prisma/data/countries.json" with { type: "json" };
import type { PrismaClient } from "@/generated/prisma/client";
import { SEED_ALIASES } from "@/server/ingest/normalize";

export const NETWORKS = [
  { slug: "adpulsar", title: "AdPulsar", color: "#4F8DF7", kind: "MEDIATED", sortOrder: 10 },
  { slug: "trafficstars", title: "TrafficStars", color: "#A78BFA", kind: "MEDIATED", sortOrder: 20 },
  { slug: "clickadu", title: "Clickadu", color: "#F472B6", kind: "MEDIATED", sortOrder: 30 },
  { slug: "exoclick", title: "ExoClick", color: "#FBBF24", kind: "MEDIATED", sortOrder: 40 },
  { slug: "own_deals", title: "Own deals", color: "#22C55E", kind: "DIRECT", sortOrder: 50, isSystem: true },
  { slug: "marketplace", title: "Marketplace", color: "#2DD4BF", kind: "MARKETPLACE", sortOrder: 60 },
] as const;

export const OTHER_COLOR = "#94A3B8";

export const COST_SOURCES = [
  { slug: "tubecrown", title: "TubeCrown" },
  { slug: "tubetraffic", title: "TubeTraffic / ixxx" },
];

export async function seedReference(db: PrismaClient): Promise<void> {
  for (const c of countries as { code: string; nameEn: string; nameRu: string; tier: number }[]) {
    await db.country.upsert({ where: { code: c.code }, create: c, update: { nameEn: c.nameEn, nameRu: c.nameRu } });
  }
  for (const a of SEED_ALIASES) {
    await db.countryAlias.upsert({
      where: { source_raw: { source: "*", raw: a.raw } },
      create: { source: "*", raw: a.raw, countryCode: a.countryCode },
      update: {},
    });
  }
  for (const n of NETWORKS) {
    await db.network.upsert({ where: { slug: n.slug }, create: { ...n }, update: { isSystem: "isSystem" in n ? n.isSystem : false } });
  }
  for (const s of COST_SOURCES) await db.costSource.upsert({ where: { slug: s.slug }, create: s, update: {} });
}
