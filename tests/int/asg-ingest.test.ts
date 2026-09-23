import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AsgClient } from "@/server/ingest/adspyglass/client";
import { ingestSiteGeo, ingestSiteTotals, ingestSiteZones, reprocessGeoFromRaw } from "@/server/ingest/adspyglass/ingest";
import { LocalRawStore, rawKey } from "@/server/ingest/raw-store";
import { asgPause, asgRequestsToday, takeAsgBudget, withIngestRun } from "@/server/ingest/run";
import { seedReference } from "@/server/seed/reference";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const DATE = "2026-09-22";

type Handler = (u: URL) => unknown;
function fakeAsg(handler: Handler) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: URL | string) => {
    const u = new URL(String(input));
    calls.push(u);
    const body = handler(u);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const client = new AsgClient({ baseUrl: "https://asg.test/api", email: "e", token: "t", fetchImpl, minIntervalMs: 0, sleep: async () => {} });
  return { client, calls };
}

const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));

beforeEach(async () => {
  await resetDb();
  await seedReference(db);
  await db.site.create({ data: { id: "a", domain: "alpha.test", title: "Alpha", adsgSiteId: 101 } });
  await db.site.create({ data: { id: "b", domain: "beta.test", title: "Beta", adsgSiteId: 102 } });
});

const geoRows = () => db.factRevenueGeo.findMany({ where: { siteId: "a" }, orderBy: { countryCode: "asc" } });

describe("AdSpyglass ingest", () => {
  it("site totals land as country ZZ; unknown sites are recorded", async () => {
    const { client, calls } = fakeAsg(() => [
      { name: "101. alpha.test", hits: 1000, impressions: 800, broker_hits: 760, broker_income: 4.5 },
      { name: "999. stranger.test", hits: 5, broker_income: 1 },
    ]);
    const r = await ingestSiteTotals({ db, client, raw, runId: "r1" }, [DATE]);
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("group_by")).toBe("website");
    expect(r.unknown).toEqual(["999|stranger.test"]);
    const rows = await geoRows();
    expect(rows.map((x) => [x.countryCode, x.pageLoads, Number(x.revenueReported)])).toEqual([["ZZ", 1000, 4.5]]);
    expect(await raw.get(rawKey("adspyglass", "website", DATE, "r1"))).toHaveLength(2);
  });

  it("country cut replaces the site total; a later total does not overwrite it", async () => {
    const { client } = fakeAsg((u) => u.searchParams.get("group_by") === "website"
      ? [{ name: "101. alpha.test", hits: 1000, broker_income: 5 }]
      : u.searchParams.get("website_id") === "101"
        ? [{ name: "Japan", hits: 600, broker_income: 3 }, { name: "United States", hits: 400, broker_income: 2 }, { name: "Atlantis", hits: 1, broker_income: 0.01 }]
        : []);
    const deps = { db, client, raw, runId: "r2" };
    await ingestSiteTotals(deps, [DATE]);
    await ingestSiteGeo(deps, [DATE]);
    expect((await geoRows()).map((x) => x.countryCode)).toEqual(["JP", "US", "XX"]);
    await ingestSiteTotals(deps, [DATE]);
    expect((await geoRows()).map((x) => x.countryCode)).toEqual(["JP", "US", "XX"]);
    expect(await db.unresolvedAlias.findMany()).toMatchObject([{ raw: "Atlantis", source: "adspyglass", rows: 1 }]);
  });

  it("restating a day overwrites instead of duplicating", async () => {
    let rev = 3;
    const { client } = fakeAsg(() => [{ name: "Japan", hits: 600, broker_income: rev }]);
    const deps = { db, client, raw, runId: "r3" };
    await ingestSiteGeo(deps, [DATE], "a");
    rev = 3.5;
    await ingestSiteGeo(deps, [DATE], "a");
    const rows = await geoRows();
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].revenueReported)).toBe(3.5);
  });

  it("zones are created with format and views for banners", async () => {
    const { client } = fakeAsg(() => [
      { name: "491. Banners_Footer_A (alpha.test)", hits: 1000, impressions: 5000, banner_view_rate: 12, broker_income: 0.5 },
      { name: "492. Popunder (alpha.test)", hits: 1000, impressions: 900, broker_income: 2 },
    ]);
    await ingestSiteZones({ db, client, raw, runId: "r4" }, [DATE], "a");
    const zones = await db.zone.findMany({ orderBy: { adsgZoneId: "asc" } });
    expect(zones.map((z) => [z.format, z.position])).toEqual([["BANNER", "footer"], ["POPUNDER", null]]);
    const facts = await db.factRevenueZone.findMany({ orderBy: { impsOwn: "desc" } });
    expect(facts.map((f) => f.views)).toEqual([600, 0]);
  });

  it("reprocesses geo from raw after an alias is added, without API calls", async () => {
    const { client, calls } = fakeAsg(() => [{ name: "Atlantis", hits: 10, broker_income: 1 }]);
    await ingestSiteGeo({ db, client, raw, runId: "r5" }, [DATE], "a");
    expect((await geoRows()).map((x) => x.countryCode)).toEqual(["XX"]);
    await db.countryAlias.create({ data: { source: "adspyglass", raw: "Atlantis", countryCode: "GR" } });
    await reprocessGeoFromRaw(db, raw, [{ key: rawKey("adspyglass", "country/101", DATE, "r5"), date: DATE, siteId: "a" }]);
    expect((await geoRows()).map((x) => x.countryCode)).toEqual(["GR"]);
    expect(calls).toHaveLength(1);
  });

  it("auth failure stops the run immediately and pauses the queue", async () => {
    const { client, calls } = fakeAsg(() => new Response(null, { status: 302, headers: { location: "https://asg.test/users/sign_in" } }));
    const res = await withIngestRun(db, { source: "adspyglass", job: "geo", from: DATE, to: DATE },
      async (runId) => { const r = await ingestSiteGeo({ db, client, raw, runId }, [DATE]); return { rows: r.rows, partial: r.failed }; });
    expect(res.status).toBe("failed");
    expect(calls).toHaveLength(1); // did not continue with site b
    expect(await asgPause(db)).toMatchObject({ reason: expect.stringContaining("авторизацию") });
    expect((await db.ingestRun.findUniqueOrThrow({ where: { id: res.id } })).error).toContain("sign_in");
  });

  it("daily budget is atomic and capped", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => takeAsgBudget(db, 5, DATE)));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(await asgRequestsToday(db, DATE)).toBe(5);
  });
});
