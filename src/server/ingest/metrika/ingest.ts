// Metrika → FactTraffic. A window is replaced per (date, site): restates overwrite.
import type { PrismaClient } from "@/generated/prisma/client";
import { CountryResolver, normalizeDevice } from "@/server/ingest/normalize";
import { rawKey, type RawStore } from "@/server/ingest/raw-store";
import { loadResolver, saveUnresolved } from "@/server/ingest/adspyglass/ingest";
import type { MetrikaClient, MetrikaRow } from "./client";

interface Cell { date: string; countryCode: string; device: string; uniques: number; pageviews: number; sessions: number; bounceW: number; depthW: number }

/** Aggregates rows to (date, country, device); bounce rate and depth are visit-weighted. */
export function aggregateMetrika(rows: MetrikaRow[], resolver: CountryResolver): Cell[] {
  const acc = new Map<string, Cell>();
  for (const r of rows) {
    const cc = r.countryIso && /^[A-Z]{2}$/.test(r.countryIso) ? r.countryIso : resolver.resolve(r.countryName, "metrika");
    const device = normalizeDevice(r.device);
    const k = `${r.date}|${cc}|${device}`;
    const c = acc.get(k) ?? { date: r.date, countryCode: cc, device, uniques: 0, pageviews: 0, sessions: 0, bounceW: 0, depthW: 0 };
    c.uniques += Math.round(r.users); c.pageviews += Math.round(r.pageviews); c.sessions += Math.round(r.visits);
    c.bounceW += r.bounceRate * r.visits; c.depthW += r.pageDepth * r.visits;
    acc.set(k, c);
  }
  return [...acc.values()];
}

async function pool<T>(items: T[], size: number, fn: (x: T) => Promise<void>) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(size, q.length) }, async () => { while (q.length) await fn(q.shift()!); }));
}

export async function ingestMetrika(
  deps: { db: PrismaClient; client: MetrikaClient; raw: RawStore; runId: string },
  from: string, to: string, siteFilter?: string,
): Promise<{ rows: number; failed: string[] }> {
  const { db, client, raw, runId } = deps;
  const sites = await db.site.findMany({ where: { status: "ACTIVE", metrikaId: { not: null }, ...(siteFilter ? { id: siteFilter } : {}) } });
  const resolver = await loadResolver(db);
  const known = new Set((await db.country.findMany({ select: { code: true } })).map((c) => c.code));
  let rows = 0;
  const failed: string[] = [];
  await pool(sites, 5, async (s) => {
    try {
      const res = await client.fetchCounter(s.metrikaId!, from, to);
      await raw.put(rawKey("metrika", s.metrikaId!, `${from}_${to}`, runId), res.raw);
      const cells = aggregateMetrika(res.rows, resolver).map((c) => (known.has(c.countryCode) ? c : { ...c, countryCode: "XX" }));
      await db.$transaction(async (tx) => {
        await tx.factTraffic.deleteMany({ where: { siteId: s.id, date: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } } });
        if (cells.length) await tx.factTraffic.createMany({ data: cells.map((c) => ({
          date: new Date(`${c.date}T00:00:00Z`), siteId: s.id, countryCode: c.countryCode, device: c.device as never,
          uniques: c.uniques, pageviews: c.pageviews, sessions: c.sessions,
          bounceRate: c.sessions ? (c.bounceW / c.sessions).toFixed(2) : null,
          avgDepth: c.sessions ? (c.depthW / c.sessions).toFixed(2) : null,
        })) });
      });
      rows += cells.length;
    } catch (e) {
      failed.push(`${s.domain}: ${(e as Error).message}`);
    }
  });
  await saveUnresolved(db, resolver);
  return { rows, failed };
}
