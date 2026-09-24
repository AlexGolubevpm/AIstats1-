import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { MetrikaClient } from "@/server/ingest/metrika/client";
import { ingestMetrika } from "@/server/ingest/metrika/ingest";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { seedReference } from "@/server/seed/reference";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
const row = (date: string, name: string, iso: string | null, dev: string, users: number, visits: number, pv: number, bounce: number, depth: number) =>
  ({ dimensions: [{ name: date }, { name, iso_name: iso ?? undefined }, { id: dev, name: dev }], metrics: [users, visits, pv, bounce, depth] });

beforeEach(async () => {
  await resetDb();
  await seedReference(db);
  await db.site.create({ data: { id: "a", domain: "alpha.test", title: "Alpha", metrikaId: "555" } });
  await db.site.create({ data: { id: "b", domain: "beta.test", title: "Beta", metrikaId: "666" } });
});

describe("Metrika ingest", () => {
  it("maps rows, weights bounce/depth by visits, isolates per-counter failures", async () => {
    const seen: URL[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const u = new URL(String(input));
      seen.push(u);
      expect((init?.headers as Record<string, string>).Authorization).toBe("OAuth tok");
      if (u.searchParams.get("ids") === "666") return new Response("forbidden", { status: 403 });
      return new Response(JSON.stringify({ data: [
        row("2026-09-22", "Japan", "JP", "desktop", 100, 120, 360, 20, 3),
        row("2026-09-22", "Japan", "JP", "desktop", 50, 80, 160, 40, 2), // same cell twice → summed
        row("2026-09-22", "Hashemite Kingdom of Jordan", null, "mobile", 10, 10, 20, 50, 2),
      ] }), { status: 200 });
    }) as typeof fetch;
    const client = new MetrikaClient({ token: "tok", baseUrl: "https://m.test", fetchImpl });
    const r = await ingestMetrika({ db, client, raw, runId: "m1" }, "2026-09-22", "2026-09-22");
    expect(seen[0].searchParams.get("accuracy")).toBe("full");
    expect(seen[0].searchParams.get("metrics")).toBe("ym:s:users,ym:s:visits,ym:s:pageviews,ym:s:bounceRate,ym:s:pageDepth");
    expect(r.failed).toEqual([expect.stringContaining("403")]);
    const rows = await db.factTraffic.findMany({ where: { siteId: "a" }, orderBy: { countryCode: "asc" } });
    expect(rows.map((x) => [x.countryCode, x.device, x.uniques, x.sessions])).toEqual([["JO", "MOBILE", 10, 10], ["JP", "DESKTOP", 150, 200]]);
    expect(Number(rows[1].bounceRate)).toBeCloseTo((20 * 120 + 40 * 80) / 200, 2);
    // restate overwrites
    await ingestMetrika({ db, client, raw, runId: "m2" }, "2026-09-22", "2026-09-22", "a");
    expect(await db.factTraffic.count({ where: { siteId: "a" } })).toBe(2);
  });
});
