import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AsgClient } from "@/server/ingest/adspyglass/client";
import { DEFAULT_PLAN } from "@/server/ingest/adspyglass/plan";
import { FILTER_IGNORED_KEY, ingestSiteGeo, ingestSiteTotals, ingestSiteZones, rawGeoKeys, reconcile, reprocessGeoFromRaw, scopedToSite } from "@/server/ingest/adspyglass/ingest";
import { LocalRawStore, rawKey } from "@/server/ingest/raw-store";
import { asgBudget, asgPause, asgRequestsToday, setAsgBudget, takeAsgBudget, withIngestRun } from "@/server/ingest/run";
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
      : u.searchParams.get("platforms_ids[]") === "101" && u.searchParams.get("group_by") === "country"
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

  it("an empty country response keeps the site total as ZZ instead of wiping the day", async () => {
    const { client } = fakeAsg((u) => u.searchParams.get("group_by") === "website"
      ? [{ name: "101. alpha.test", hits: 1000, broker_income: 5 }]
      : []);
    const deps = { db, client, raw, runId: "e1" };
    await ingestSiteTotals(deps, [DATE]);
    const r = await ingestSiteGeo(deps, [DATE], "a");
    expect(r.failed).toEqual([expect.stringContaining("разрез по странам пуст")]);
    expect((await geoRows()).map((x) => [x.countryCode, Number(x.revenueReported)])).toEqual([["ZZ", 5]]);
    // Without a prior total the ZZ row is written from the website cut.
    await db.factRevenueGeo.deleteMany();
    await ingestSiteGeo(deps, [DATE], "a");
    expect((await geoRows()).map((x) => [x.countryCode, Number(x.revenueReported)])).toEqual([["ZZ", 5]]);
  });

  it("restating a day overwrites instead of duplicating", async () => {
    let rev = 3;
    const { client } = fakeAsg((u) => u.searchParams.get("group_by") === "website"
      ? [{ name: "101. alpha.test", hits: 600, broker_income: rev }]
      : [{ name: "Japan", hits: 600, broker_income: rev }]);
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
      { name: "493. Tablink 2 (alpha.test)", hits: 1000, impressions: 100, broker_income: 0.1 },
    ]);
    await ingestSiteZones({ db, client, raw, runId: "r4" }, [DATE], "a");
    const zones = await db.zone.findMany({ orderBy: { adsgZoneId: "asc" } });
    expect(zones.map((z) => [z.format, z.position, z.placementSlug])).toEqual([["BANNER", "footer", "footer_a"], ["POPUNDER", null, "pop"], ["OTHER", null, "tablink_2"]]);
    expect(await db.placement.count()).toBe(21); // the catalog does not grow from zone names
    const facts = await db.factRevenueZone.findMany({ orderBy: { impsOwn: "desc" } });
    expect(facts.map((f) => f.views)).toEqual([600, 0, 0]);
  });

  it("zones of all sites come from one account-level spot request, split by domain, when the plan does not pull zones per site", async () => {
    const { client, calls } = fakeAsg(() => [
      { name: "491. Banners_Footer_A (alpha.test)", hits: 100, impressions: 500, broker_income: 0.5 },
      { name: "492. Popunder (www.beta.test)", hits: 200, impressions: 180, broker_income: 2 },
      { name: "493. Slider (stranger.test)", hits: 1, broker_income: 9 },
      { name: "garbage", hits: 1 },
    ]);
    const r = await ingestSiteZones({ db, client, raw, runId: "z1" }, [DATE], undefined, { ...DEFAULT_PLAN, cuts: { ...DEFAULT_PLAN.cuts, spot_site: false } });
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get("website_id")).toBeNull();
    expect(r.rows).toBe(2);
    const zones = await db.zone.findMany({ orderBy: { adsgZoneId: "asc" } });
    expect(zones.map((z) => [z.adsgZoneId, z.siteId])).toEqual([[491, "a"], [492, "b"]]);
    await ingestSiteZones({ db, client, raw, runId: "z2" }, [DATE]); // restate: no duplicates
    expect(await db.factRevenueZone.count()).toBe(2);
  });

  it("a per-site cut that is really the whole account is rejected and not retried for a week", async () => {
    const account = [{ name: "Japan", hits: 4000, broker_income: 30 }];
    const { client, calls } = fakeAsg((u) => u.searchParams.get("group_by") === "website"
      ? [{ name: "101. alpha.test", hits: 1000, broker_income: 5 }, { name: "102. beta.test", hits: 3000, broker_income: 25 }]
      : account); // website_id ignored, like ADOK
    await ingestSiteTotals({ db, client, raw, runId: "f0" }, [DATE]);
    const before = await geoRows();
    const r = await ingestSiteGeo({ db, client, raw, runId: "f1" }, [DATE]);
    expect(r.rows).toBe(0);
    expect(r.failed[0]).toContain("игнорирует website_id");
    expect(await geoRows()).toEqual(before); // site total (ZZ) kept, no account data written
    expect(calls.filter((c) => c.searchParams.get("group_by") === "country")).toHaveLength(1); // stopped at the first site
    expect(await db.appSetting.findUnique({ where: { key: FILTER_IGNORED_KEY } })).toBeTruthy();
    const n = calls.length;
    const again = await ingestSiteGeo({ db, client, raw, runId: "f2" }, [DATE]);
    expect(again.skipped).toContain("пропущено");
    expect(calls).toHaveLength(n); // no requests at all
  });

  it("network cut per site via platforms_ids[]; the view shows networks instead of the account-wide row", async () => {
    const { client, calls } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by"), site = u.searchParams.get("platforms_ids[]");
      if (g === "website") return [{ name: "101. alpha.test", hits: 1000, broker_income: 5 }];
      if (g === "country") return site === "101" ? [{ name: "Japan", iso: "JP", hits: 1000, broker_income: 5 }] : [];
      if (g === "adnetwork_squashed") return site === "101" ? [{ name: "AdPulsar.io", hits: 700, broker_income: 4 }, { name: "NewNet.com", hits: 300, broker_income: 1 }] : [];
      return [];
    });
    const r = await ingestSiteGeo({ db, client, raw, runId: "n1" }, [DATE], "a");
    expect(r.failed).toEqual([]);
    expect(calls.some((c) => c.searchParams.get("platforms_ids[]") === "101" && c.searchParams.get("group_by") === "adnetwork_squashed")).toBe(true);
    expect(calls.some((c) => c.searchParams.has("website_id"))).toBe(false);
    const nets = await db.factRevenueNetwork.findMany({ include: { network: true }, orderBy: { pageLoads: "desc" } });
    expect(nets.map((n) => [n.network.slug, n.pageLoads, Number(n.revenueReported)])).toEqual([["adpulsar", 700, 4], ["newnet", 300, 1]]);
    expect(await db.network.findUniqueOrThrow({ where: { slug: "newnet" } })).toMatchObject({ showInLegend: false, color: "#94A3B8" });
    const view = await db.$queryRaw<{ network_slug: string; country_code: string; revenue: number }[]>`
      SELECT network_slug, country_code, revenue::float8 revenue FROM v_network_geo WHERE site_id = 'a' ORDER BY revenue DESC`;
    expect(view).toEqual([{ network_slug: "adpulsar", country_code: "ZZ", revenue: 4 }, { network_slug: "newnet", country_code: "ZZ", revenue: 1 }]);
    const [geo] = await db.$queryRaw<{ r: number }[]>`SELECT SUM(revenue)::float8 r FROM v_site_geo_daily WHERE site_id = 'a'`;
    expect(geo.r).toBe(5); // site revenue from the country cut, not doubled by networks
  });

  it("device cut per site; devices table prefers it; country cut reconciled with the site total", async () => {
    const { client } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by");
      if (g === "website") return [{ name: "101. alpha.test", hits: 1000, broker_income: 10, predicted_income: 10 }];
      if (g === "country") return [{ name: "Japan", iso: "JP", hits: 1000, broker_income: 9, predicted_income: 9 }]; // own estimate 10% below the site's
      if (g === "device") return [{ name: "Desktop", hits: 600, impressions: 500, broker_income: 0.5, predicted_income: 6 }, { name: "Mobile", hits: 400, impressions: 300, broker_income: 0, predicted_income: 4 }];
      return [];
    });
    const r = await ingestSiteGeo({ db, client, raw, runId: "d1" }, [DATE], "a");
    expect(r.failed).toEqual([expect.stringContaining("сверка с итогом ADOK — выручка по странам расходится на -10.0%")]);
    const devs = await db.factRevenueDevice.findMany({ orderBy: { pageLoads: "desc" } });
    expect(devs.map((x) => [x.device, Number(x.revenueReported)])).toEqual([["DESKTOP", 6], ["MOBILE", 4]]); // site total split by own revenue
    const { devicesTable } = await import("@/server/queries/reports");
    const t = await devicesTable({ from: DATE, to: DATE }, "a");
    expect(t.map((x) => [x.device, x.revenue])).toEqual([["DESKTOP", 6], ["MOBILE", 4]]); // not the UNKNOWN geo row
  });

  it("network revenue of the country and device cuts comes from the site total, not from the cut (2026-10-01: 2.58x)", async () => {
    // Real ADOK behaviour: per-site cuts scope hits and predicted_income, but broker_income is
    // inflated in the country cut and mostly missing in the device cut.
    const website = [{ name: "101. alpha.test", hits: 1000, impressions: 900, broker_hits: 800, broker_income: 10, predicted_income: 11 }];
    const country = [{ name: "Japan", iso: "JP", hits: 700, impressions: 600, broker_hits: 9000, broker_income: 600, predicted_income: 8.25 },
      { name: "United States", iso: "US", hits: 300, impressions: 300, broker_hits: 4000, broker_income: 400, predicted_income: 2.75 }];
    const device = [{ name: "Desktop", hits: 500, impressions: 450, broker_hits: 30, broker_income: 0.4, predicted_income: 5.5 },
      { name: "Mobile", hits: 500, impressions: 450, broker_hits: 0, broker_income: 0, predicted_income: 5.5 }];
    const { client } = fakeAsg((u) => ({ website, country, device } as Record<string, unknown>)[u.searchParams.get("group_by")!] ?? []);
    const r = await ingestSiteGeo({ db, client, raw, runId: "b1" }, [DATE], "a");
    expect(r.failed).toEqual([]);
    const geo = await geoRows();
    expect(geo.map((x) => [x.countryCode, Number(x.revenueReported), x.impsNetwork])).toEqual([["JP", 7.5, 533], ["US", 2.5, 267]]);
    const [total] = await db.$queryRaw<{ r: number }[]>`SELECT SUM(revenue)::float8 r FROM v_site_geo_daily WHERE site_id = 'a'`;
    expect(total.r).toBe(10); // equals the ADOK site total
    const devs = await db.factRevenueDevice.findMany({ orderBy: { device: "asc" } });
    expect(devs.map((x) => [x.device, Number(x.revenueReported), x.impsNetwork])).toEqual([["DESKTOP", 5, 400], ["MOBILE", 5, 400]]);
  });

  it("reprocessing re-applies the split to days stored before it, from raw only", async () => {
    const own = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
    await own.put(rawKey("adspyglass", "website", DATE, "old"), [{ name: "101. alpha.test", hits: 1000, broker_income: 4, predicted_income: 4 }]);
    await own.put(rawKey("adspyglass", "country/101", DATE, "old"), [{ name: "Japan", iso: "JP", hits: 1000, broker_income: 40, predicted_income: 3 },
      { name: "Chile", iso: "CL", hits: 0, impressions: 0, broker_income: 9, predicted_income: 1 }]);
    await own.put(rawKey("adspyglass", "device/101", DATE, "old"), [{ name: "Mobile", hits: 1000, broker_income: 0, predicted_income: 4 }]);
    await db.factRevenueGeo.create({ data: { date: new Date(`${DATE}T00:00:00Z`), siteId: "a", networkId: (await db.network.findUniqueOrThrow({ where: { slug: "asg_all" } })).id,
      countryCode: "JP", device: "UNKNOWN", pageLoads: 1000, revenueReported: "40" } });
    await reprocessGeoFromRaw(db, own, await rawGeoKeys(db, own, DATE, DATE));
    expect((await geoRows()).map((x) => [x.countryCode, Number(x.revenueReported)])).toEqual([["CL", 1], ["JP", 3]]);
    expect((await db.factRevenueDevice.findMany()).map((x) => [x.device, Number(x.revenueReported)])).toEqual([["MOBILE", 4]]);
  });

  it("traffic sources per site: linked to seeded sources, new ones created paid, Direct free", async () => {
    const { client, calls } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by");
      if (g === "website") return [{ name: "101. alpha.test", hits: 1000, broker_income: 10 }];
      if (g === "traffic_source") return [{ name: "TubeCrown", hits: 700, broker_income: 7 }, { name: "Direct", hits: 250, broker_income: 2.5 }, { name: "Alex Z", hits: 50, broker_income: 0.5 }];
      return [];
    });
    const r = await ingestSiteGeo({ db, client, raw, runId: "t1" }, [DATE], "a");
    expect(r.failed.filter((f) => !f.includes("по странам пуст"))).toEqual([]); // the fake has no country rows
    expect(calls.find((c) => c.searchParams.get("group_by") === "traffic_source")?.searchParams.get("platforms_ids[]")).toBe("101");
    const facts = await db.factTrafficSource.findMany({ orderBy: { pageLoads: "desc" } });
    expect(facts.map((f) => [f.sourceSlug, f.pageLoads, Number(f.revenueReported)])).toEqual([["tubecrown", 700, 7], ["direct", 250, 2.5], ["alex_z", 50, 0.5]]);
    const src = await db.costSource.findMany({ where: { asgName: { not: null } }, orderBy: { slug: "asc" } });
    expect(src.map((s) => [s.slug, s.asgName, Number(s.revShare)])).toEqual([["alex_z", "Alex Z", 1], ["direct", "Direct", 0], ["tubecrown", "TubeCrown", 1]]);
    expect(await raw.get(rawKey("adspyglass", "traffic_source/101", DATE, "t1"))).toHaveLength(3);
  });

  it("a traffic source cut larger than the site is not written", async () => {
    const { client } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by");
      if (g === "website") return [{ name: "101. alpha.test", hits: 1000, broker_income: 10 }];
      if (g === "traffic_source") return [{ name: "TubeCrown", hits: 9000, broker_income: 70 }];
      return [];
    });
    const r = await ingestSiteGeo({ db, client, raw, runId: "t2" }, [DATE], "a");
    expect(r.failed.filter((f) => !f.includes("по странам пуст"))).toEqual([expect.stringContaining("источники трафика не по сайту")]);
    expect(await db.factTrafficSource.count()).toBe(0);
  });

  it("reconcile", () => {
    expect(reconcile(100, 101)).toBeNull();
    expect(reconcile(0.03, 0)).toBeNull();
    expect(reconcile(90, 100)).toBeCloseTo(-0.1);
    expect(reconcile(5, undefined)).toBeNull();
  });

  it("scope check", () => {
    expect(scopedToSite(1000, 1000)).toBe(true);
    expect(scopedToSite(1040, 1000)).toBe(true);
    expect(scopedToSite(4210, 1000)).toBe(false);
    expect(scopedToSite(5, undefined)).toBe(true);
  });

  it("reprocesses geo from raw after an alias is added, without API calls", async () => {
    const { client, calls } = fakeAsg(() => [{ name: "Atlantis", hits: 10, broker_income: 1 }]);
    await ingestSiteGeo({ db, client, raw, runId: "r5" }, [DATE], "a");
    expect((await geoRows()).map((x) => x.countryCode)).toEqual(["XX"]);
    await db.countryAlias.create({ data: { source: "adspyglass", raw: "Atlantis", countryCode: "GR" } });
    await reprocessGeoFromRaw(db, raw, [{ key: rawKey("adspyglass", "country/101", DATE, "r5"), date: DATE, siteId: "a", adsgSiteId: 101, cut: "country" }]);
    expect((await geoRows()).map((x) => x.countryCode)).toEqual(["GR"]);
    expect(calls).toHaveLength(8); // website totals + country + network + device + traffic source + ad_type + hour + platform during ingest; none during reprocess
  });

  it("finds the latest raw country response per site and day", async () => {
    const { client } = fakeAsg(() => [{ name: "Japan", hits: 10, broker_income: 1 }]);
    const own = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
    await ingestSiteGeo({ db, client, raw: own, runId: "c1" }, [DATE], "a");
    await ingestSiteGeo({ db, client, raw: own, runId: "c2" }, [DATE], "a");
    const keys = await rawGeoKeys(db, own, DATE, DATE);
    expect(keys).toEqual([
      { key: rawKey("adspyglass", "country/101", DATE, "c2"), date: DATE, siteId: "a", adsgSiteId: 101, cut: "country" },
      { key: rawKey("adspyglass", "device/101", DATE, "c2"), date: DATE, siteId: "a", adsgSiteId: 101, cut: "device" },
    ]);
    expect(await rawGeoKeys(db, own, "2026-01-01", "2026-01-02")).toEqual([]);
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

  it("daily budget: env by default, the UI value over it, 0 = no ceiling (requests still counted); changes audited", async () => {
    expect(await asgBudget(db, 800)).toEqual({ limit: 800, unlimited: false, fromUi: false });
    await setAsgBudget(db, 1500);
    expect(await asgBudget(db, 800)).toEqual({ limit: 1500, unlimited: false, fromUi: true });
    await setAsgBudget(db, 0);
    const b = await asgBudget(db, 800);
    expect(b).toMatchObject({ unlimited: true, fromUi: true });
    const results = await Promise.all(Array.from({ length: 20 }, () => takeAsgBudget(db, b.limit, DATE)));
    expect(results.every(Boolean)).toBe(true);
    expect(await asgRequestsToday(db, DATE)).toBe(20);
    await expect(setAsgBudget(db, -1)).rejects.toThrow("0 до 100 000");
    expect((await db.auditLog.findMany({ where: { entityId: "asg_budget" }, orderBy: { at: "asc" } })).map((a) => a.after)).toEqual(["1500", "0"]);
  });
});


describe("format cut and the request plan (ADR 0016)", () => {
  it("ad_type rows land in FactRevenueFormat with requests, ADOK fill and the site's network side spread over formats; a cut switched off is not requested", async () => {
    const seen: string[] = [];
    const { client } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by"); seen.push(g!);
      if (g === "website") return [{ name: "101. alpha.test", hits: 1000, impressions: 600, broker_hits: 580, broker_income: 10, predicted_income: 10 }];
      if (g === "country") return [{ name: "Japan", iso: "JP", hits: 1000, impressions: 600, broker_income: 10, predicted_income: 10 }];
      if (g === "ad_type") return [
        { name: "Popunder", hits: 600, impressions: 300, clicks: 30, requests: 550, broker_clicks: 28, fill_rate: 50, predicted_income: 7.5 },
        { name: "Banner", hits: 400, impressions: 300, clicks: 3, requests: 390, broker_clicks: 3, fill_rate: 0.75, predicted_income: 2.5 },
      ];
      return [];
    });
    const plan = { cuts: { country: true, network: false, device: false, traffic_source: false, ad_type: true, spot_site: false, hour: false, platform: false, browser: false }, restateDays: 3, hourlyToday: true };
    const r = await ingestSiteGeo({ db, client, raw, runId: "f1" }, [DATE], "a", plan);
    expect(r.failed).toEqual([]);
    expect(seen).toEqual(["website", "country", "ad_type"]); // network, device and traffic_source are off in this plan
    const rows = await db.factRevenueFormat.findMany({ where: { siteId: "a" }, orderBy: { format: "asc" } });
    expect(rows.map((x) => [x.format, x.pageLoads, x.impsOwn, x.requests, x.clicks, x.brokerClicks, Number(x.fillRateAsg), Number(x.revenueReported), x.impsNetwork])).toEqual([
      ["POPUNDER", 600, 300, 550, 30, 28, 0.5, 7.5, 290], // $10 and 580 network imps split 75/25 by predicted income and 50/50 by impressions
      ["BANNER", 400, 300, 390, 3, 3, 0.75, 2.5, 290],
    ]);
    // The format view prefers the cut over zone sums and carries the extra fields.
    const v = await db.$queryRaw<{ format: string; requests: unknown; page_loads: unknown; fill_rate_asg: unknown; from_format_cut: boolean }[]>`
      SELECT format, requests, page_loads, fill_rate_asg, from_format_cut FROM v_format_daily WHERE site_id = 'a' ORDER BY format`;
    expect(v.map((x) => [x.format, Number(x.requests), Number(x.page_loads), Number(x.fill_rate_asg), x.from_format_cut])).toEqual([["BANNER", 390, 400, 0.75, true], ["POPUNDER", 550, 600, 0.5, true]]);
  });
});

describe("zones per site, hours and platforms (ADR 0016)", () => {
  const PLAN = (over: Partial<Record<string, boolean>> = {}) => ({ cuts: { country: true, network: false, device: false, traffic_source: false, ad_type: false, spot_site: true, hour: true, platform: true, browser: false, ...over } as never, restateDays: 3, hourlyToday: true });
  it("spot per site: one request per site, zones belong to the filtered site; an account-shaped answer falls back to the one account request", async () => {
    const seen: string[] = [];
    const { client } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by"), site = u.searchParams.get("platforms_ids[]");
      seen.push(`${g}:${site ?? "all"}`);
      if (g !== "spot") return [];
      if (site === "101") return [{ name: "491. Footer (alpha.test)", hits: 10, impressions: 10, broker_income: 1 }];
      if (site === "102") return [{ name: "492. Header (beta.test)", hits: 20, impressions: 20, broker_income: 2 }];
      return [{ name: "491. Footer (alpha.test)", hits: 10, broker_income: 1 }, { name: "492. Header (beta.test)", hits: 20, broker_income: 2 }];
    });
    const r = await ingestSiteZones({ db, client, raw, runId: "z1" }, [DATE], undefined, PLAN());
    expect(r.failed).toEqual([]);
    expect(seen).toEqual(["spot:101", "spot:102"]);
    expect((await db.factRevenueZone.findMany({ orderBy: { siteId: "asc" } })).map((z) => [z.siteId, z.pageLoads])).toEqual([["a", 10], ["b", 20]]);
    // The filter ignored: the per-site answer names other domains → one account request for the day, zones by domain as before.
    seen.length = 0;
    const { client: c2 } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by"), site = u.searchParams.get("platforms_ids[]");
      seen.push(`${g}:${site ?? "all"}`);
      return g === "spot" ? [{ name: "491. Footer (alpha.test)", hits: 11, broker_income: 1 }, { name: "492. Header (beta.test)", hits: 22, broker_income: 2 }] : [];
    });
    const r2 = await ingestSiteZones({ db, client: c2, raw, runId: "z2" }, [DATE], undefined, PLAN());
    expect(r2.failed).toEqual([expect.stringContaining("зоны не по сайту — взят общий запрос")]);
    expect(seen).toEqual(["spot:101", "spot:all"]);
    expect((await db.factRevenueZone.findMany({ orderBy: { siteId: "asc" } })).map((z) => [z.siteId, z.pageLoads])).toEqual([["a", 11], ["b", 22]]);
    // Zones switched off per site: the account request alone.
    seen.length = 0;
    await ingestSiteZones({ db, client: c2, raw, runId: "z3" }, [DATE], undefined, PLAN({ spot_site: false }));
    expect(seen).toEqual(["spot:all"]);
  });

  it("hour and platform cuts land in their facts with the site's network side spread; browsers only when enabled", async () => {
    const seen: string[] = [];
    const { client } = fakeAsg((u) => {
      const g = u.searchParams.get("group_by"); seen.push(g!);
      if (g === "website") return [{ name: "101. alpha.test", hits: 1000, impressions: 800, broker_hits: 790, broker_income: 10, predicted_income: 10 }];
      if (g === "country") return [{ name: "Japan", iso: "JP", hits: 1000, impressions: 800, broker_income: 10, predicted_income: 10 }];
      if (g === "hour") return [{ name: "13:00", hits: 600, impressions: 500, predicted_income: 6 }, { name: "14:00", hits: 400, impressions: 300, predicted_income: 4 }, { name: "??", hits: 5 }];
      if (g === "platform") return [{ name: "Android", hits: 700, impressions: 560, predicted_income: 7 }, { name: "Windows", hits: 300, impressions: 240, predicted_income: 3 }];
      if (g === "browser") return [{ name: "Chrome", hits: 1000, impressions: 800, predicted_income: 10 }];
      return [];
    });
    const r = await ingestSiteGeo({ db, client, raw, runId: "h1" }, [DATE], "a", PLAN());
    expect(r.failed).toEqual([]);
    expect(seen).toEqual(["website", "country", "hour", "platform"]);
    expect((await db.factRevenueHour.findMany({ orderBy: { hour: "asc" } })).map((x) => [x.hour, x.pageLoads, Number(x.revenueReported), x.impsNetwork])).toEqual([[13, 600, 6, 494], [14, 400, 4, 296]]);
    expect((await db.factRevenueTech.findMany({ orderBy: { name: "asc" } })).map((x) => [x.kind, x.name, x.pageLoads, Number(x.revenueReported)])).toEqual([["PLATFORM", "Android", 700, 7], ["PLATFORM", "Windows", 300, 3]]);
    await ingestSiteGeo({ db, client, raw, runId: "h2" }, [DATE], "a", PLAN({ browser: true }));
    expect(await db.factRevenueTech.count({ where: { kind: "BROWSER", name: "Chrome" } })).toBe(1);
    // The page queries read them back.
    const { hoursTable, techTable } = await import("@/server/queries/reports");
    const hours = await hoursTable({ from: DATE, to: DATE }, "a");
    expect(hours.map((h) => [h.label, h.loadsPerDay, h.revenuePerDay])).toEqual([["13:00", 600, 6], ["14:00", 400, 4]]);
    expect(hours[0].share).toBeCloseTo(0.6);
    expect((await techTable({ from: DATE, to: DATE }, "a", "PLATFORM")).map((t) => [t.name, t.loadsShare])).toEqual([["Android", 0.7], ["Windows", 0.3]]);
  });
});
