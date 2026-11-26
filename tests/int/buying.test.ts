import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AsgClient } from "@/server/ingest/adspyglass/client";
import { FILTERS_KEY, readBuyingFilters, saveBuyingFilters } from "@/server/ingest/adspyglass/filters";
import { ingestSiteGeo } from "@/server/ingest/adspyglass/ingest";
import { DEFAULT_PLAN, readPlan } from "@/server/ingest/adspyglass/plan";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { setAsgBudget } from "@/server/ingest/run";
import { config } from "@/server/config";
import { runJob } from "@/server/jobs/handlers";
import { buyingTable } from "@/server/queries/buying";
import { CHUNK, cachedSlice, checkBuyingFilters, computeSiteSlice, estimateSlice, saveBid, weeksOf } from "@/server/services/buying";
import { asgPause } from "@/server/ingest/run";
import { seedReference } from "@/server/seed/reference";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const DATE = "2026-11-20";
const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
const cfg = config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t", ASG_BASE_URL: "https://asg.test/api", ASG_MIN_INTERVAL_MS: "0" });

/**
 * A fake ADOK for hentaismile (id 101): 10 000 loads, US 5 000 (T1), DE 2 000 (T1), IN 3 000 (T4);
 * two traffic sources: Doni (bought, 7 000 loads) and Direct (3 000).
 * The popunder zones are 501/502; ADOK understands `spots_ids[]` and `countries[]` (ISO) only — other
 * filter names are ignored and the unfiltered answer comes back, as ADOK does.
 */
function adok(opts: { spots?: string; countries?: string; fail?: (u: URL) => number | null } = { spots: "spots_ids[]", countries: "countries[]" }) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: URL | string) => {
    const u = new URL(String(input)); calls.push(u);
    const status = opts.fail?.(u);
    if (status) return new Response("oops", { status });
    // the data is of one day: a range that does not hold it is empty
    if (!(u.searchParams.get("from")! <= DATE && DATE <= u.searchParams.get("to")!)) return new Response("[]", { status: 200 });
    const g = u.searchParams.get("group_by");
    const zoneFiltered = opts.spots && u.searchParams.getAll(opts.spots).join(",") === "501,502";
    const bannerFiltered = opts.spots && u.searchParams.getAll(opts.spots).join(",") === "503";
    const t12 = opts.countries ? u.searchParams.getAll(opts.countries) : [];
    let body: unknown = [];
    if (g === "website") body = [{ name: "101. hentaismile.com", hits: 10_000, impressions: 30_000, broker_hits: 28_000, broker_income: 30, predicted_income: 30 }];
    else if (g === "country" && zoneFiltered) body = [
      { name: "United States", iso: "US", hits: 5_000, impressions: 4_000, predicted_income: 8 },
      { name: "Germany", iso: "DE", hits: 2_000, impressions: 1_500, predicted_income: 2 },
      { name: "India", iso: "IN", hits: 3_000, impressions: 2_500, predicted_income: 1 }];
    else if (g === "country" && bannerFiltered) body = [
      { name: "United States", iso: "US", hits: 5_000, impressions: 12_000, predicted_income: 10 },
      { name: "Germany", iso: "DE", hits: 2_000, impressions: 4_500, predicted_income: 4 },
      { name: "India", iso: "IN", hits: 3_000, impressions: 5_500, predicted_income: 5 }];
    else if (g === "country") body = [
      { name: "United States", iso: "US", hits: 5_000, impressions: 16_000, broker_income: 900, predicted_income: 18 },
      { name: "Germany", iso: "DE", hits: 2_000, impressions: 6_000, broker_income: 900, predicted_income: 6 },
      { name: "India", iso: "IN", hits: 3_000, impressions: 8_000, broker_income: 900, predicted_income: 6 }];
    else if (g === "ad_type") body = [{ name: "Popunder", hits: 6_000, impressions: 8_000, predicted_income: 11 }, { name: "Banner", hits: 4_000, impressions: 22_000, predicted_income: 19 }];
    else if (g === "traffic_source") {
      const tier = t12.includes("US") && !t12.includes("IN") ? 1 : t12.includes("IN") && !t12.includes("US") ? 4 : t12.length ? 5 : 0;
      // ADOK filters the site's own fields only: broker_income stays the source's whole revenue (ADR 0005)
      body = tier === 1 && zoneFiltered ? [{ name: "Doni", hits: 5_000, impressions: 4_000, broker_income: 20, predicted_income: 7 }, { name: "Direct", hits: 2_000, impressions: 1_500, broker_income: 10, predicted_income: 2 }]
        : tier === 1 ? [{ name: "Doni", hits: 5_000, impressions: 15_000, broker_income: 20, predicted_income: 14 }, { name: "Direct", hits: 2_000, impressions: 6_000, broker_income: 10, predicted_income: 5 }]
        : tier === 4 && zoneFiltered ? [{ name: "Doni", hits: 2_000, impressions: 1_500, broker_income: 20, predicted_income: 1 }, { name: "Direct", hits: 1_000, impressions: 1_000, broker_income: 10, predicted_income: 1 }]
        : tier === 4 ? [{ name: "Doni", hits: 2_000, impressions: 6_000, broker_income: 20, predicted_income: 6 }, { name: "Direct", hits: 1_000, impressions: 3_000, broker_income: 10, predicted_income: 5 }]
        : tier === 5 ? [{ name: "Doni", hits: 10 * t12.length, impressions: 30 * t12.length, broker_income: 0.01 * t12.length, predicted_income: 0.01 * t12.length }] // any other countries: 10 loads each
        : [{ name: "Doni", hits: 7_000, impressions: 21_000, broker_income: 20, predicted_income: 20 }, { name: "Direct", hits: 3_000, impressions: 9_000, broker_income: 10, predicted_income: 10 }];
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls, client: new AsgClient({ baseUrl: "https://asg.test/api", email: "e", token: "t", fetchImpl, minIntervalMs: 0, sleep: async () => {} }) };
}

beforeEach(async () => {
  await resetDb();
  await seedReference(db);
  await db.site.create({ data: { id: "hs", domain: "hentaismile.com", title: "HS", adsgSiteId: 101 } });
  await db.zone.createMany({ data: [
    { adsgZoneId: 501, siteId: "hs", name: "hentaismile.com popunder", format: "POPUNDER" },
    { adsgZoneId: 502, siteId: "hs", name: "hentaismile.com popunder 2", format: "POPUNDER" },
    { adsgZoneId: 503, siteId: "hs", name: "hentaismile.com banner", format: "BANNER" },
  ] });
  await setAsgBudget(db, 0);
});

const PLAN = { ...DEFAULT_PLAN, cuts: { ...DEFAULT_PLAN.cuts, network: false, device: false, hour: false, platform: false, spot_site: false, popunder_geo: true, source_t12: true } };

describe("«Окупаемость закупки» (ADR 0023)", () => {
  it("the check finds the filters ADOK understands, tries them together, skips the ignored ones and stores them", async () => {
    const a = adok();
    const r = await checkBuyingFilters(db, cfg, "hs", DATE, a.fetchImpl);
    expect(r.spots?.param).toBe("spots_ids[]");
    expect(r.countries).toEqual({ param: "countries[]", kind: "iso" });
    // countries_ids[] by ADOK id is tried first: the fake rows carry no ids, so it is skipped without a request
    expect(r.tried.filter((t) => t.what === "t12").map((t) => [t.param, t.ok])).toEqual([["countries_ids[]", false], ["countries[]", true]]);
    expect((await readBuyingFilters(db)).site).toBe("hentaismile.com");
    expect(r.tried.at(-1)).toMatchObject({ what: "both", ok: true }); // both filters in one request narrow the answer further
    expect((await readPlan(db)).cuts).toMatchObject({ popunder_geo: false, source_t12: false }); // the nightly history cuts stay the owner's choice
    expect(await db.auditLog.count({ where: { entityId: FILTERS_KEY } })).toBe(1);

    const none = adok({});
    const r2 = await checkBuyingFilters(db, cfg, "hs", DATE, none.fetchImpl);
    expect([r2.spots, r2.countries]).toEqual([null, null]);
    expect(r2.tried.every((t) => !t.ok)).toBe(true);
  });

  it("the nightly ingest writes popunder by country (revenue spread from the popunder total) and T1/T2 by source (unfiltered revenue spread by its estimate)", async () => {
    await saveBuyingFilters(db, { spots: { param: "spots_ids[]", kind: "zone_ids" }, countries: { param: "countries[]", kind: "iso" } });
    const a = adok();
    const r = await ingestSiteGeo({ db, client: a.client, raw, runId: "b1" }, [DATE], "hs", PLAN);
    expect(r.failed).toEqual([]);
    const pop = await db.factRevenueFormatGeo.findMany({ where: { siteId: "hs" }, orderBy: { countryCode: "asc" } });
    // popunder total $11 (11/30 of the site's $30) spread by predicted 8:2:1
    expect(pop.map((p) => [p.countryCode, p.format, p.pageLoads, Number(p.revenueReported)])).toEqual([["DE", "POPUNDER", 2000, 2], ["IN", "POPUNDER", 3000, 1], ["US", "POPUNDER", 5000, 8]]);
    const t12 = await db.factTrafficSourceTier.findMany({ where: { siteId: "hs" }, orderBy: { sourceSlug: "asc" } });
    // broker_income came back unfiltered ($20 = all Doni): 20 × 14 / 20 = $14; Direct 10 × 5 / 10 = $5
    expect(t12.map((t) => [t.sourceSlug, t.tierGroup, t.pageLoads, Number(t.revenueReported)])).toEqual([["direct", "T12", 2000, 5], ["doni", "T12", 5000, 14]]);
    const filtered = a.calls.filter((u) => u.searchParams.getAll("spots_ids[]").length || u.searchParams.getAll("countries[]").length);
    expect(filtered.map((u) => u.searchParams.get("group_by"))).toEqual(["country", "traffic_source"]);
    expect(a.calls.find((u) => u.searchParams.get("group_by") === "traffic_source" && u.searchParams.getAll("countries[]").length)!.searchParams.getAll("countries[]")).toEqual(["US", "DE"]);
  });

  it("a filter ADOK ignores is caught: nothing is written, the night reports it; without found filters no request is spent", async () => {
    await saveBuyingFilters(db, { spots: { param: "spot_ids[]", kind: "zone_ids" }, countries: { param: "country_codes[]", kind: "iso" } });
    const a = adok();
    const r = await ingestSiteGeo({ db, client: a.client, raw, runId: "b2" }, [DATE], "hs", PLAN);
    expect(r.failed.join("\n")).toMatch(/попсы по странам — .*фильтр не сработал, пропущено/);
    expect(r.failed.join("\n")).toMatch(/источники T1\/T2 — .*пропущено/);
    expect(await db.factRevenueFormatGeo.count()).toBe(0);
    expect(await db.factTrafficSourceTier.count()).toBe(0);

    await db.appSetting.deleteMany({ where: { key: FILTERS_KEY } });
    const b = adok();
    await ingestSiteGeo({ db, client: b.client, raw, runId: "b3" }, [DATE], "hs", PLAN);
    expect(b.calls.map((u) => u.searchParams.get("group_by"))).toEqual(["website", "country", "traffic_source", "ad_type"]);
  });

  describe("the site slice: tiers × formats (revenue) and tiers × sources (cost)", () => {
    const key = { siteId: "hs", from: DATE, to: DATE };
    const P = { from: DATE, to: DATE };
    const ALL = { siteIds: null, tiers: [1, 2, 3, 4, 5], formats: null };
    beforeEach(async () => {
      // the stored cuts of the day (site, countries, formats, sources) — the slice is checked against them
      await ingestSiteGeo({ db, client: adok().client, raw, runId: "s0" }, [DATE], "hs", { ...PLAN, cuts: { ...PLAN.cuts, popunder_geo: false, source_t12: false } });
      await saveBuyingFilters(db, { spots: { param: "spots_ids[]", kind: "zone_ids" }, countries: { param: "countries[]", kind: "iso" } });
    });

    it("exact: one country request per format, one source request per tier with traffic; the tree adds up; cost sits on the tier", async () => {
      const a = adok();
      const d = await computeSiteSlice(db, cfg, key, a.fetchImpl);
      expect(d).toMatchObject({ requests: 4, notes: [] }); // popunder, banner, T1, T4 — T2, T3, T5 have no traffic
      expect(a.calls.filter((u) => u.searchParams.get("group_by") === "country").map((u) => u.searchParams.getAll("spots_ids[]").join(",")).sort()).toEqual(["501,502", "503"]);
      expect(a.calls.filter((u) => u.searchParams.get("group_by") === "traffic_source").every((u) => u.searchParams.getAll("countries[]").length > 0 && u.searchParams.get("from") === DATE)).toBe(true);
      const t1 = d.tiers.find((t) => t.tier === 1)!;
      // popunder $11 spread 8 : 2 : 1 over US, DE, IN; banner $19 spread 10 : 4 : 5 → T1 = US + DE
      expect(t1.formats).toEqual([{ format: "BANNER", revenue: 14, imps: 16500, exact: true }, { format: "POPUNDER", revenue: 10, imps: 5500, exact: true }]);
      expect(t1.sources).toEqual([{ slug: "doni", title: "Doni", loads: 5000, revenue: 14 }, { slug: "direct", title: "Direct", loads: 2000, revenue: 5 }]);
      expect(t1.sourcesExact).toBe(true);

      const v = await buyingTable(P, ALL);
      expect(v.rows).toHaveLength(1);
      const site = v.rows[0];
      expect(site).toMatchObject({ domain: "hentaismile.com", revenue: 30, exact: true });
      expect(site.tiers.map((t) => [t.tier, t.revenue, t.formats.map((f) => [f.format, f.revenue])])).toEqual([
        [1, 24, [["BANNER", 14], ["POPUNDER", 10]]], [4, 6, [["BANNER", 5], ["POPUNDER", 1]]]]);
      // Doni is new in ADOK: revshare 100% until a share or a bid is set — it costs what its traffic earned; Direct is free
      expect(site.tiers.map((t) => t.cost)).toEqual([14, 6]);
      expect(site.cost).toBe(20);
      expect(site.tiers[0].cpm).toBeCloseTo((24 / 22000) * 1000, 4);
      expect(site.tiers[0].formats[1].cpm).toBeCloseTo((10 / 5500) * 1000, 4);
      expect(v.total).toMatchObject({ revenue: 30, cost: 20 });
      expect(v.computed).toEqual({ done: 1, of: 1 });

      // filters: a tier, a format — the format's revenue with the whole tier's cost
      const pop = await buyingTable(P, { siteIds: ["hs"], tiers: [1], formats: ["POPUNDER"] });
      expect(pop.rows[0]).toMatchObject({ revenue: 10, cost: 14, imps: 5500 });
      expect(pop.rows[0].tiers).toHaveLength(1);
      expect((await buyingTable(P, { siteIds: [], tiers: [1], formats: null })).rows).toEqual([]);

      // opening the page again spends nothing
      const before = a.calls.length;
      expect(await cachedSlice(db, key)).toMatchObject({ requests: 4 });
      await buyingTable(P, ALL);
      expect(a.calls.length).toBe(before);
    });

    it("a CPM bid of the source for the tier replaces its revshare: loads × bid / loads per visit; the site's bid wins, a later one is not used", async () => {
      await computeSiteSlice(db, cfg, key, adok().fetchImpl);
      await saveBid(db, { sourceSlug: "doni", siteId: null, tier: 1, cpm: "2", loadsPerVisit: "2", validFrom: "2026-11-01" });
      const v = await buyingTable(P, ALL);
      expect(v.rows[0].tiers.map((t) => [t.tier, t.cost])).toEqual([[1, 5], [4, 6]]); // T1: 5 000 loads × $1 per 1000; T4 still revshare
      expect(await db.auditLog.count({ where: { entity: "BidRate" } })).toBe(1);
      await saveBid(db, { sourceSlug: "doni", siteId: "hs", tier: 1, cpm: "4", loadsPerVisit: "2", validFrom: "2026-11-10" });
      await saveBid(db, { sourceSlug: "doni", siteId: "hs", tier: 1, cpm: "9", loadsPerVisit: "1", validFrom: "2026-12-01" });
      const dearer = await buyingTable(P, ALL);
      expect(dearer.rows[0].tiers[0].cost).toBe(10);
      expect(dearer.bids.map((b) => [b.cpm, b.site])).toEqual([[4, "hentaismile.com"], [2, null]]);
      await expect(saveBid(db, { sourceSlug: "nobody", siteId: null, tier: 1, cpm: "1", loadsPerVisit: "1", validFrom: DATE })).rejects.toThrow(/источник/);
      await expect(saveBid(db, { sourceSlug: "doni", siteId: null, tier: 1, cpm: "abc", loadsPerVisit: "1", validFrom: DATE })).rejects.toThrow(/Ставка/);
    });

    it("without the ADOK run the tree is an estimate and says so: the tier's revenue is exact, formats by their share, sources by the tier's share", async () => {
      const e = await estimateSlice(db, key);
      const t1 = e.tiers.find((t) => t.tier === 1)!;
      expect(t1.revenue).toBe(24);
      expect(t1.formats.find((f) => f.format === "POPUNDER")).toMatchObject({ exact: false });
      expect(t1.formats.find((f) => f.format === "POPUNDER")!.revenue).toBeCloseTo(24 * (11 / 30), 4);
      expect(t1.formats.reduce((a, f) => a + f.revenue, 0)).toBeCloseTo(24, 4); // the formats still add up to the tier
      expect(t1.sources.find((x) => x.slug === "doni")!.loads).toBeCloseTo(4900);
      const v = await buyingTable(P, ALL);
      expect(v.rows[0]).toMatchObject({ exact: false, computedAt: null, revenue: 30 });
      expect(v.computed.done).toBe(0);
    });

    it("a filter ADOK ignores is caught: the part keeps the estimate with a note; nothing exact — nothing cached", async () => {
      // the zone filter is ignored, the country one works: sources exact, formats by share
      await saveBuyingFilters(db, { spots: { param: "spot_ids[]", kind: "zone_ids" }, countries: { param: "countries[]", kind: "iso" } });
      const d = await computeSiteSlice(db, cfg, key, adok().fetchImpl);
      expect(d.notes.join(" ")).toMatch(/POPUNDER: .*фильтр не сработал — по доле формата/);
      expect(d.tiers[0]).toMatchObject({ sourcesExact: true });
      expect(d.tiers[0].formats.every((f) => !f.exact)).toBe(true);
      expect((await buyingTable(P, ALL)).rows[0].exact).toBe(false);

      await db.buyingSlice.deleteMany();
      await saveBuyingFilters(db, { countries: { param: "country_codes[]", kind: "iso" } });
      await expect(computeSiteSlice(db, cfg, key, adok().fetchImpl)).rejects.toThrow(/оценка/i);
      await db.appSetting.deleteMany({ where: { key: FILTERS_KEY } });
      await expect(computeSiteSlice(db, cfg, key, adok().fetchImpl)).rejects.toThrow(/Проверить фильтры/);
      expect(await db.buyingSlice.count()).toBe(0);
    });

    describe("ADOK answers 500", () => {
      const both = { spots: "spots_ids[]", countries: "countries[]" };
      const isTier = (u: URL, cc: string) => u.searchParams.get("group_by") === "traffic_source" && u.searchParams.getAll("countries[]").includes(cc);

      it("one failed request does not lose the run: retried once, the part stays an estimate with a note that names the request, the rest is saved", async () => {
        const a = adok({ ...both, fail: (u) => (isTier(u, "IN") ? 500 : null) });
        const d = await computeSiteSlice(db, cfg, key, a.fetchImpl);
        expect(a.calls.filter((u) => isTier(u, "IN"))).toHaveLength(2); // the request and one retry
        expect(d.notes).toEqual(["T4: ADOK 500 (traffic_source, countries[] × 1, 20.11–20.11) — источники оценкой"]);
        expect(d.tiers.map((t) => [t.tier, t.sourcesExact]).filter(([, e]) => e)).toEqual([[1, true]]);
        expect(d.tiers.find((t) => t.tier === 4)!.formats.every((f) => f.exact)).toBe(true); // the formats came from their own requests
        expect(await cachedSlice(db, key)).not.toBeNull();
        // only the countries the site had traffic from go into the filter, not the tier's whole directory
        expect(a.calls.find((u) => isTier(u, "US"))!.searchParams.getAll("countries[]").sort()).toEqual(["DE", "US"]);
      });

      it("the whole period fails but its weeks pass: asked week by week, the answers add up", async () => {
        const wide = { siteId: "hs", from: "2026-11-07", to: DATE }; // two weeks, the data is in the last day
        expect(weeksOf(wide.from, wide.to)).toEqual([{ from: "2026-11-07", to: "2026-11-13" }, { from: "2026-11-14", to: DATE }]);
        expect(weeksOf(DATE, DATE)).toEqual([{ from: DATE, to: DATE }]);
        const a = adok({ ...both, fail: (u) => (u.searchParams.get("from") === wide.from && u.searchParams.get("to") === wide.to ? 500 : null) });
        const d = await computeSiteSlice(db, cfg, wide, a.fetchImpl);
        expect(d.notes).toEqual([]);
        expect(d.requests).toBe(4 * (2 + 2)); // each of the 4 requests: the period twice, then two weeks
        const t1 = d.tiers.find((t) => t.tier === 1)!;
        expect(t1.sources.find((x) => x.slug === "doni")).toMatchObject({ loads: 5000, revenue: 14 });
        expect(t1.formats.find((f) => f.format === "POPUNDER")).toMatchObject({ revenue: 10, exact: true });
      });

      it("a long list of countries goes in parts of 40 and the answers add up", async () => {
        const net = (await db.factRevenueGeo.findFirstOrThrow({ where: { siteId: "hs" } })).networkId;
        const t5 = (await db.country.findMany({ where: { tier: 5 }, take: CHUNK + 5, orderBy: { code: "asc" } })).map((c) => c.code);
        expect(t5.length).toBe(CHUNK + 5);
        await db.factRevenueGeo.createMany({ data: t5.map((countryCode) => ({ date: new Date(`${DATE}T00:00:00Z`), siteId: "hs", networkId: net, countryCode, device: "UNKNOWN" as const, pageLoads: 10 })) });
        const a = adok(both);
        const d = await computeSiteSlice(db, cfg, key, a.fetchImpl);
        const parts = a.calls.filter((u) => isTier(u, t5[0]) || isTier(u, t5[CHUNK])).map((u) => u.searchParams.getAll("countries[]").length);
        expect(parts).toEqual([CHUNK, 5]);
        expect(d.tiers.find((t) => t.tier === 5)).toMatchObject({ sourcesExact: true, sources: [expect.objectContaining({ slug: "doni", loads: 10 * (CHUNK + 5) })] });
      });

      it("everything fails: the error lists the failed requests and nothing is cached; a 429 stops the run and pauses ADOK", async () => {
        const err = await computeSiteSlice(db, cfg, key, adok({ ...both, fail: () => 500 }).fetchImpl).catch((e: Error) => e.message);
        expect(err).toMatch(/ADOK не дал точных данных: /);
        expect(err).toMatch(/POPUNDER: ADOK 500 \(country, spots_ids\[\] × 2, 20\.11–20\.11\)/);
        expect(err).toMatch(/T1: ADOK 500 \(traffic_source, countries\[\] × 2, 20\.11–20\.11\)/);
        expect(await db.buyingSlice.count()).toBe(0);
        expect(await asgPause(db)).toBeNull(); // a 500 is not a reason to pause the queue

        const limited = adok({ ...both, fail: (u) => (u.searchParams.get("group_by") === "traffic_source" ? 429 : null) });
        await expect(computeSiteSlice(db, cfg, key, limited.fetchImpl)).rejects.toThrow(/429/);
        expect(limited.calls.filter((u) => u.searchParams.get("group_by") === "traffic_source")).toHaveLength(1); // no retry, no further tiers
        expect(await asgPause(db)).not.toBeNull();
      });
    });

    it("the job computes every site in turn, reports a site it could not do, and stops when the ADOK budget ends", async () => {
      await db.site.create({ data: { id: "nd", domain: "nodata.test", title: "No data", adsgSiteId: 202 } });
      const r = await runJob("asg:buying", { db, cfg, raw, today: "2026-11-25", fetchImpl: adok().fetchImpl }, { from: DATE, to: DATE });
      expect(r.status).toBe("partial");
      const run = () => db.ingestRun.findFirstOrThrow({ where: { job: "asg:buying" }, orderBy: { startedAt: "desc" } });
      expect((await run()).error).toMatch(/nodata\.test: ADOK не дал точных данных/);
      expect((await run()).rowsUpsert).toBe(1);
      expect((await db.buyingSlice.findMany()).map((x) => x.siteId)).toEqual(["hs"]);

      await db.buyingSlice.deleteMany();
      await setAsgBudget(db, 1);
      const stopped = await runJob("asg:buying", { db, cfg, raw, today: "2026-11-25", fetchImpl: adok().fetchImpl }, { from: DATE, to: DATE });
      expect(stopped.status).toBe("partial");
      expect((await run()).error).toMatch(/остановлено на hentaismile\.com/);
      expect(await db.buyingSlice.count()).toBe(0);
    });
  });
});
