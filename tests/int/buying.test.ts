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
import { buyingReport } from "@/server/queries/buying";
import { checkBuyingFilters } from "@/server/services/buying";
import { seedReference } from "@/server/seed/reference";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const DATE = "2026-11-20";
const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
const cfg = config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t", ASG_BASE_URL: "https://asg.test/api", ASG_MIN_INTERVAL_MS: "0" });

/**
 * A fake ADOK for hentaismile (id 101): 10 000 loads, US 5 000 (T1), DE 2 000 (T1), IN 3 000 (T4).
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
    else if (g === "traffic_source" && t12.length && t12.every((c) => c === "US" || c === "DE")) body = [
      // ADOK filters the site's own fields only: broker_income stays the source's whole revenue (ADR 0005)
      { name: "TubeCrown", hits: 5_000, broker_income: 20, predicted_income: 14 }, { name: "Direct", hits: 2_000, broker_income: 10, predicted_income: 5 }];
    else if (g === "traffic_source") body = [{ name: "TubeCrown", hits: 7_000, broker_income: 20, predicted_income: 20 }, { name: "Direct", hits: 3_000, broker_income: 10, predicted_income: 10 }];
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

describe("«Закупка T1/T2» (ADR 0023)", () => {
  it("the check finds the filters ADOK understands, skips the ignored ones, stores them and turns the cuts on", async () => {
    const a = adok();
    const r = await checkBuyingFilters(db, cfg, "hs", DATE, a.fetchImpl);
    expect(r.spots?.param).toBe("spots_ids[]");
    expect(r.countries).toEqual({ param: "countries[]", kind: "iso" });
    // countries_ids[] by ADOK id is tried first: the fake rows carry no ids, so it is skipped without a request
    expect(r.tried.filter((t) => t.what === "t12").map((t) => [t.param, t.ok])).toEqual([["countries_ids[]", false], ["countries[]", true]]);
    expect((await readBuyingFilters(db)).site).toBe("hentaismile.com");
    expect((await readPlan(db)).cuts).toMatchObject({ popunder_geo: true, source_t12: true });
    expect(await db.auditLog.count({ where: { entityId: FILTERS_KEY } })).toBe(1);

    const none = adok({});
    const r2 = await checkBuyingFilters(db, cfg, "hs", DATE, none.fetchImpl);
    expect([r2.spots, r2.countries]).toEqual([null, null]);
    expect(r2.tried.every((t) => !t.ok)).toBe(true);
    expect((await readPlan(db)).cuts).toMatchObject({ popunder_geo: false, source_t12: false });
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
    // broker_income came back unfiltered ($20 = all TubeCrown): 20 × 14 / 20 = $14; Direct 10 × 5 / 10 = $5
    expect(t12.map((t) => [t.sourceSlug, t.tierGroup, t.pageLoads, Number(t.revenueReported)])).toEqual([["direct", "T12", 2000, 5], ["tubecrown", "T12", 5000, 14]]);
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

  it("the report: exact popunder and T1/T2 cost after the cuts, the format-share estimate before them; T4 traffic stays out", async () => {
    await saveBuyingFilters(db, { spots: { param: "spots_ids[]", kind: "zone_ids" }, countries: { param: "countries[]", kind: "iso" } });
    const a = adok();
    await ingestSiteGeo({ db, client: a.client, raw, runId: "b4" }, [DATE], "hs", PLAN);
    await db.costSource.update({ where: { slug: "tubecrown" }, data: { revShare: 0.5 } });
    const r = await buyingReport("hs", { from: DATE, to: DATE }, 0.2);
    expect(r.days).toHaveLength(1);
    const d = r.days[0];
    expect(d.loads).toBe(7000); // US + DE, India (T4) out
    expect(d.popExact && d.costExact).toBe(true);
    expect(d.popRevenue).toBeCloseTo(10); // US $8 + DE $2
    expect(d.cost).toBeCloseTo(7); // TubeCrown $14 × 50%; Direct is free
    expect(d.paidLoads).toBe(5000);
    expect(r.advice.costPer1k).toBeCloseTo(1.4);
    expect(r.advice.popPer1k).toBeCloseTo(10 / 7);
    expect(r.advice.verdict).toBe("hold"); // limit 1.43 × 0.8 = $1.14 < $1.40
    expect(r.countries.map((c) => [c.country, c.tier, c.exact])).toEqual([["US", 1, true], ["DE", 1, true]]);
    expect(r.sources.map((s) => [s.slug, s.loads, s.costPer1k])).toEqual([["tubecrown", 5000, 1.4], ["direct", 2000, null]]);

    // without the filtered cuts: popunder = T1/T2 ADOK revenue × the popunder share of formats, cost = the geo spread
    await db.factRevenueFormatGeo.deleteMany();
    await db.factTrafficSourceTier.deleteMany();
    const e = await buyingReport("hs", { from: DATE, to: DATE }, 0.2);
    expect(e.days[0].popExact || e.days[0].costExact).toBe(false);
    const geo = await db.factRevenueGeo.aggregate({ where: { siteId: "hs", countryCode: { in: ["US", "DE"] } }, _sum: { revenueReported: true } });
    expect(e.days[0].popRevenue).toBeCloseTo(Number(geo._sum.revenueReported) * (11 / 30), 3);
    expect(e.countries.every((c) => !c.exact)).toBe(true);
    expect(e.sources).toEqual([]);
  });
});
