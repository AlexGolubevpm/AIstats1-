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
import { buyingView } from "@/server/queries/buying";
import { cachedSlice, checkBuyingFilters, computeSlice, estimateSlice, saveBid } from "@/server/services/buying";
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
function adok(opts: { spots?: string; countries?: string } = { spots: "spots_ids[]", countries: "countries[]" }) {
  const calls: URL[] = [];
  const fetchImpl = (async (input: URL | string) => {
    const u = new URL(String(input)); calls.push(u);
    const g = u.searchParams.get("group_by");
    const zoneFiltered = opts.spots && u.searchParams.getAll(opts.spots).join(",") === "501,502";
    const t12 = opts.countries ? u.searchParams.getAll(opts.countries) : [];
    let body: unknown = [];
    if (g === "website") body = [{ name: "101. hentaismile.com", hits: 10_000, impressions: 30_000, broker_hits: 28_000, broker_income: 30, predicted_income: 30 }];
    else if (g === "country" && zoneFiltered) body = [
      { name: "United States", iso: "US", hits: 5_000, impressions: 4_000, predicted_income: 8 },
      { name: "Germany", iso: "DE", hits: 2_000, impressions: 1_500, predicted_income: 2 },
      { name: "India", iso: "IN", hits: 3_000, impressions: 2_500, predicted_income: 1 }];
    else if (g === "country") body = [
      { name: "United States", iso: "US", hits: 5_000, impressions: 16_000, broker_income: 900, predicted_income: 18 },
      { name: "Germany", iso: "DE", hits: 2_000, impressions: 6_000, broker_income: 900, predicted_income: 6 },
      { name: "India", iso: "IN", hits: 3_000, impressions: 8_000, broker_income: 900, predicted_income: 6 }];
    else if (g === "ad_type") body = [{ name: "Popunder", hits: 6_000, impressions: 8_000, predicted_income: 11 }, { name: "Banner", hits: 4_000, impressions: 22_000, predicted_income: 19 }];
    else if (g === "traffic_source") {
      const tier = t12.includes("US") && !t12.includes("IN") ? 1 : t12.includes("IN") && !t12.includes("US") ? 4 : 0;
      // ADOK filters the site's own fields only: broker_income stays the source's whole revenue (ADR 0005)
      body = tier === 1 && zoneFiltered ? [{ name: "Doni", hits: 5_000, impressions: 4_000, broker_income: 20, predicted_income: 7 }, { name: "Direct", hits: 2_000, impressions: 1_500, broker_income: 10, predicted_income: 2 }]
        : tier === 1 ? [{ name: "Doni", hits: 5_000, impressions: 15_000, broker_income: 20, predicted_income: 14 }, { name: "Direct", hits: 2_000, impressions: 6_000, broker_income: 10, predicted_income: 5 }]
        : tier === 4 && zoneFiltered ? [{ name: "Doni", hits: 2_000, impressions: 1_500, broker_income: 20, predicted_income: 1 }, { name: "Direct", hits: 1_000, impressions: 1_000, broker_income: 10, predicted_income: 1 }]
        : tier === 4 ? [{ name: "Doni", hits: 2_000, impressions: 6_000, broker_income: 20, predicted_income: 6 }, { name: "Direct", hits: 1_000, impressions: 3_000, broker_income: 10, predicted_income: 5 }]
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

  describe("the slice «formats × tiers» of the bought traffic", () => {
    const sel = { siteId: "hs", from: DATE, to: DATE };
    const P = { from: DATE, to: DATE };
    beforeEach(async () => {
      // the stored cuts of the day (site, countries, formats, sources) — the slice is checked against them
      await ingestSiteGeo({ db, client: adok().client, raw, runId: "s0" }, [DATE], "hs", { ...PLAN, cuts: { ...PLAN.cuts, popunder_geo: false, source_t12: false } });
      await saveBuyingFilters(db, { spots: { param: "spots_ids[]", kind: "zone_ids" }, countries: { param: "countries[]", kind: "iso" } });
    });

    it("Doni × popunder × T1: both filters in one request, the source's own row; the bid per tier decides", async () => {
      const a = adok();
      const d = await computeSlice(db, cfg, { ...sel, formats: ["POPUNDER"], tiers: [1] }, a.fetchImpl);
      expect(d).toMatchObject({ exact: true, fmtExact: true, requests: 3, notes: [] });
      const both = a.calls.find((u) => u.searchParams.get("group_by") === "traffic_source" && u.searchParams.getAll("spots_ids[]").length)!;
      expect(both.searchParams.getAll("spots_ids[]")).toEqual(["501", "502"]);
      expect(both.searchParams.getAll("countries[]")).toEqual(expect.arrayContaining(["US", "DE"]));
      expect(both.searchParams.getAll("countries[]")).not.toContain("IN");
      expect(both.searchParams.get("from")).toBe(DATE);
      // Doni's T1 traffic: 5 000 loads; all formats $14 (its $20 × 14 / 20 of its own estimate), popunder $7 (half of the slice's estimate)
      expect(d.tiers[0].sources.find((x) => x.slug === "doni")).toEqual({ slug: "doni", title: "Doni", loads: 5000, revenueAll: 14, revenueFmt: 7 });
      expect(d.countries.map((c) => [c.cc, c.revenueFmt])).toEqual(expect.arrayContaining([["US", 8], ["DE", 2]])); // the popunder $11 spread 8 : 2 : 1

      // a bid of $2 per 1000 visits, 2 loads a visit → $1 per 1000 loads; popunder brings $1.40
      await saveBid(db, { sourceSlug: "doni", siteId: null, tier: 1, cpm: "2", loadsPerVisit: "2", validFrom: "2026-11-01" });
      const v = await buyingView("hs", P, { formats: ["POPUNDER"], tiers: [1], source: "doni", margin: 0.2 });
      expect(v.slice).toMatchObject({ cached: true, exact: true });
      expect(v.tiers[0]).toMatchObject({ tier: 1, loads: 5000, revenue: 7, cost: 5, costKind: "bid", bid: 2, verdict: "raise" });
      expect(v.tiers[0].revPer1k).toBeCloseTo(1.4);
      expect(v.tiers[0].costPer1k).toBeCloseTo(1);
      expect(v.tiers[0].maxBid).toBeCloseTo(1.12);
      expect(v.tiers[0].maxCpm).toBeCloseTo(2.24); // the limit in the bid's own unit
      expect(v.advice.verdict).toBe("raise");
      expect(await db.auditLog.count({ where: { entity: "BidRate" } })).toBe(1);

      // the site's own bid wins over the general one; a bid that starts after the period is not used
      await saveBid(db, { sourceSlug: "doni", siteId: "hs", tier: 1, cpm: "4", loadsPerVisit: "2", validFrom: "2026-11-10" });
      await saveBid(db, { sourceSlug: "doni", siteId: "hs", tier: 1, cpm: "9", loadsPerVisit: "1", validFrom: "2026-12-01" });
      const dearer = await buyingView("hs", P, { formats: ["POPUNDER"], tiers: [1], source: "doni", margin: 0.2 });
      expect(dearer.tiers[0]).toMatchObject({ bid: 4, verdict: "hold" });
      expect(dearer.tiers[0].costPer1k).toBeCloseTo(2);
      await expect(saveBid(db, { sourceSlug: "nobody", siteId: null, tier: 1, cpm: "1", loadsPerVisit: "1", validFrom: DATE })).rejects.toThrow(/источник/);
      await expect(saveBid(db, { sourceSlug: "doni", siteId: null, tier: 1, cpm: "abc", loadsPerVisit: "1", validFrom: DATE })).rejects.toThrow(/Ставка/);
    });

    it("all formats at once need no zone filter; two tiers are two requests; the cache spends nothing; without a bid a source costs its revshare", async () => {
      const a = adok();
      const d = await computeSlice(db, cfg, { ...sel, formats: null, tiers: [4, 1] }, a.fetchImpl);
      expect(d.requests).toBe(2);
      expect(a.calls.every((u) => u.searchParams.getAll("spots_ids[]").length === 0)).toBe(true);
      expect(d.tiers.map((t) => [t.tier, t.sources.find((x) => x.slug === "doni")!.loads, t.sources.find((x) => x.slug === "doni")!.revenueFmt])).toEqual([[1, 5000, 14], [4, 2000, 6]]);
      expect(await cachedSlice(db, { ...sel, formats: null, tiers: [1, 4] })).toMatchObject({ requests: 2 }); // the same slice whatever the order
      expect(await cachedSlice(db, { ...sel, formats: ["POPUNDER"], tiers: [1, 4] })).toBeNull();

      const v = await buyingView("hs", P, { formats: null, tiers: [1, 4], source: "paid", margin: 0.2 });
      // Doni is new in ADOK: revshare 100% until the owner sets a share or a bid — its cost equals what it earned; Direct is free and left out
      expect(v.tiers.map((t) => [t.tier, t.loads, t.costKind, t.verdict])).toEqual([[1, 5000, "revshare", "hold"], [4, 2000, "revshare", "hold"]]);
      expect(v.total.loads).toBe(7000);
      expect(v.sourceOptions.map((x) => [x.slug, x.paid])).toEqual([["doni", true], ["direct", false]]);
      await saveBid(db, { sourceSlug: "doni", siteId: null, tier: 4, cpm: "1", loadsPerVisit: "1", validFrom: DATE });
      const mixed = await buyingView("hs", P, { formats: null, tiers: [1, 4], source: "doni", margin: 0.2 });
      expect(mixed.tiers[1]).toMatchObject({ tier: 4, costKind: "bid", cost: 2, verdict: "raise" }); // $3.00 per 1000 against $1.00
    });

    it("a filter ADOK ignores is caught: nothing is cached and the page shows the marked estimate", async () => {
      await saveBuyingFilters(db, { countries: { param: "country_codes[]", kind: "iso" } });
      await expect(computeSlice(db, cfg, { ...sel, formats: null, tiers: [1] }, adok().fetchImpl)).rejects.toThrow(/оценка/i);
      await db.appSetting.deleteMany({ where: { key: FILTERS_KEY } });
      await expect(computeSlice(db, cfg, { ...sel, formats: null, tiers: [1] }, adok().fetchImpl)).rejects.toThrow(/Проверить фильтры/);
      expect(await db.buyingSlice.count()).toBe(0);

      // the estimate: every source is given the site's geo and format mix — T1 is 70% of the loads, popunder 11/30 of the revenue
      const e = await estimateSlice(db, { ...sel, formats: ["POPUNDER"], tiers: [1] });
      expect(e).toMatchObject({ exact: false, fmtExact: false, requests: 0 });
      const doni = e.tiers[0].sources.find((x) => x.slug === "doni")!;
      expect(doni.loads).toBeCloseTo(4900);
      expect(doni.revenueFmt).toBeCloseTo(doni.revenueAll * (11 / 30), 3);
      const v = await buyingView("hs", P, { formats: ["POPUNDER"], tiers: [1], source: "doni", margin: 0.2 });
      expect(v.slice).toMatchObject({ cached: false, exact: false });
      expect(v.tiers[0].exact).toBe(false);
    });

    it("the zone filter ignored only in the combined request: the tier stays exact, the formats fall back to their share with a note", async () => {
      await saveBuyingFilters(db, { spots: { param: "spot_ids[]", kind: "zone_ids" }, countries: { param: "countries[]", kind: "iso" } });
      const d = await computeSlice(db, cfg, { ...sel, formats: ["POPUNDER"], tiers: [1] }, adok().fetchImpl);
      expect(d).toMatchObject({ exact: true, fmtExact: false });
      expect(d.notes.join(" ")).toMatch(/фильтр по зонам не сработал/);
      const doni = d.tiers[0].sources.find((x) => x.slug === "doni")!;
      expect(doni.revenueFmt).toBeCloseTo(14 * (11 / 30), 3);
    });
  });
});
