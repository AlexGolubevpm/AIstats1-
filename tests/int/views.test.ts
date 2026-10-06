import { beforeAll, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const num = (v: unknown) => Number(v);

beforeAll(async () => {
  await resetDb();
  await buildNetwork(db);
});

describe("v_site_geo_daily", () => {
  it("adds DIRECT deal revenue but not VIA_ASG (own deals already in ASG)", async () => {
    const [s1] = await db.$queryRaw<{ revenue: unknown; revenue_direct: unknown }[]>`
      SELECT SUM(revenue) revenue, SUM(revenue_direct) revenue_direct FROM v_site_geo_daily WHERE site_id = 's1'`;
    // 2 days × 2 countries × $10 + own_deals $2; the VIA_ASG FactFixDeal $2 is not added again.
    expect(num(s1.revenue)).toBe(42);
    expect(num(s1.revenue_direct)).toBe(0);
    const [s3] = await db.$queryRaw<{ revenue: unknown; revenue_direct: unknown; revenue_confirmed: unknown }[]>`
      SELECT SUM(revenue) revenue, SUM(revenue_direct) revenue_direct, SUM(revenue_confirmed) revenue_confirmed
      FROM v_site_geo_daily WHERE site_id = 's3'`;
    expect(num(s3.revenue)).toBe(46);
    expect(num(s3.revenue_direct)).toBe(6);
    expect(num(s3.revenue_confirmed)).toBe(3); // only the CONFIRMED deal day; mediated not yet paid out
    // Deal page loads are the site's own traffic counted again: they stay out of page_loads.
    const [loads] = await db.$queryRaw<{ page_loads: unknown; deal_loads: unknown }[]>`SELECT SUM(page_loads) page_loads, SUM(deal_loads) deal_loads FROM v_site_geo_daily WHERE site_id = 's3'`;
    expect([num(loads.page_loads), num(loads.deal_loads)]).toEqual([40_000, 6_000]);
  });

  it("joins traffic and cost on the same grain and computes margin", async () => {
    const [r] = await db.$queryRaw<{ uniques: unknown; cost: unknown; margin: unknown }[]>`
      SELECT uniques, cost, margin FROM v_site_geo_daily WHERE site_id = 's2' AND country_code = 'JP' AND date = '2026-09-20'`;
    expect(num(r.uniques)).toBe(1000);
    expect(num(r.cost)).toBe(12);
    expect(num(r.margin)).toBe(-2);
  });

  it("keeps a row for a key that only one source has (cost without revenue)", async () => {
    await db.factCost.create({ data: { date: new Date("2026-09-19T00:00:00Z"), siteId: "s1", countryCode: "US", sourceSlug: "tubecrown",
      uniquesBought: 3, rateModel: "CPU", rate: "1", cost: "7" } });
    const [r] = await db.$queryRaw<{ revenue: unknown; cost: unknown; margin: unknown; uniques: unknown }[]>`
      SELECT revenue, cost, margin, uniques FROM v_site_geo_daily WHERE site_id = 's1' AND country_code = 'US' AND date = '2026-09-19'`;
    expect([num(r.revenue), num(r.cost), num(r.margin), num(r.uniques)]).toEqual([0, 7, -7, 0]);
    await db.factCost.deleteMany({ where: { date: new Date("2026-09-19T00:00:00Z") } });
  });

  it("pushes a site filter down to the fact tables (site page must render < 1 s)", async () => {
    const plan = await db.$queryRawUnsafe<{ "QUERY PLAN": string }[]>(
      `EXPLAIN SELECT SUM(revenue) FROM v_site_geo_daily WHERE site_id = 's1' AND date BETWEEN '2026-09-01' AND '2026-09-30'`);
    const text = plan.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).not.toMatch(/CTE Scan/); // materialised CTEs scan every site, then nested-loop join
    expect(text).toMatch(/"FactRevenueGeo"[\s\S]*s1|s1[\s\S]*"FactRevenueGeo"/);
  });
});

describe("v_bundle_daily", () => {
  it("v_bundle_daily leaves archived sites out, like the page totals", async () => {
    const [before] = await db.$queryRaw<{ revenue: unknown }[]>`SELECT SUM(revenue) revenue FROM v_bundle_daily WHERE bundle_slug = 'jav'`;
    await db.site.update({ where: { id: "s1" }, data: { status: "ARCHIVED" } });
    const [after] = await db.$queryRaw<{ revenue: unknown }[]>`SELECT SUM(revenue) revenue FROM v_bundle_daily WHERE bundle_slug = 'jav'`;
    expect(num(after.revenue)).toBeLessThan(num(before.revenue));
    await db.site.update({ where: { id: "s1" }, data: { status: "ACTIVE" } });
  });

  it("bundle total equals the sum of its sites", async () => {
    const [b] = await db.$queryRaw<{ revenue: unknown }[]>`SELECT SUM(revenue) revenue FROM v_bundle_daily WHERE bundle_slug = 'jav'`;
    const [s] = await db.$queryRaw<{ revenue: unknown }[]>`SELECT SUM(revenue) revenue FROM v_site_geo_daily WHERE site_id IN ('s1','s2')`;
    expect(num(b.revenue)).toBe(num(s.revenue));
  });

  it("network total ≠ sum of bundles when a site is in two bundles", async () => {
    const [bundles] = await db.$queryRaw<{ revenue: unknown }[]>`SELECT SUM(revenue) revenue FROM v_bundle_daily`;
    const [network] = await db.$queryRaw<{ revenue: unknown }[]>`SELECT SUM(revenue) revenue FROM v_site_geo_daily`;
    expect(num(network.revenue)).toBe(42 + 40 + 46);
    expect(num(bundles.revenue)).toBe(num(network.revenue) + 40); // s2 counted twice
  });

  it("computes ROMI as ratio of sums", async () => {
    const [b] = await db.$queryRaw<{ romi: unknown }[]>`
      SELECT SUM(margin) / SUM(cost) * 100 romi FROM v_bundle_daily WHERE bundle_slug = 'hentai'`;
    // hentai = s2 (40 rev) + s3 (46 rev); cost 2 sites × 2 days × (12 + 5) = 68
    expect(num(b.romi)).toBeCloseTo(((86 - 68) / 68) * 100, 6);
  });
});

describe("zone, network, format, deal views", () => {
  it("v_zone_daily computes view rate and viewable CPM", async () => {
    const [z] = await db.$queryRaw<{ view_rate: unknown; viewable_cpm: unknown; cpm: unknown }[]>`SELECT view_rate, viewable_cpm, cpm FROM v_zone_daily`;
    expect(num(z.view_rate)).toBeCloseTo(0.1);
    expect(num(z.viewable_cpm)).toBeCloseTo(0.2);
    expect(num(z.cpm)).toBeCloseTo(0.02);
  });
  it("v_network_geo computes fill rate, discrepancy, rev per 1k loads", async () => {
    const [n] = await db.$queryRaw<{ fill_rate: unknown; discrepancy: unknown; rev_per_1k_loads: unknown }[]>`
      SELECT fill_rate, discrepancy, rev_per_1k_loads FROM v_network_geo
      WHERE site_id = 's1' AND country_code = 'US' AND date = '2026-09-20' AND network_slug = 'adpulsar'`;
    expect(num(n.fill_rate)).toBeCloseTo(0.8);
    expect(num(n.discrepancy)).toBeCloseTo(0.05);
    expect(num(n.rev_per_1k_loads)).toBeCloseTo(1);
  });
  it("v_format_daily and v_deal_daily expose rows", async () => {
    const f = await db.$queryRaw<{ format: string }[]>`SELECT format FROM v_format_daily`;
    expect(f.map((r) => r.format)).toEqual(["BANNER"]);
    const d = await db.$queryRaw<{ billed_via: string }[]>`SELECT DISTINCT billed_via FROM v_deal_daily ORDER BY 1`;
    expect(d.map((r) => r.billed_via)).toEqual(["DIRECT", "VIA_ASG"]);
  });
});

describe("mcp_reader role", () => {
  it("can read views but not tables", async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE mcp_reader");
      return tx.$queryRawUnsafe("SELECT count(*) FROM v_site_geo_daily");
    })).resolves.toBeTruthy();
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE mcp_reader");
      return tx.$queryRawUnsafe(`SELECT * FROM "Site"`);
    })).rejects.toThrow(/permission denied/);
  });
});
