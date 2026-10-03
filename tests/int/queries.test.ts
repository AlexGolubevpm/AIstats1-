// Page queries against the reference network (tests/factories/network.ts): the numbers the
// pages show, including the network-total-by-sites and no-double-counting invariants.
import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork, D1 } from "@tests/factories/network";
import { dailyTotals, freshness, kpis, siteList, totals } from "@/server/queries/common";
import { dealDetail, dealsList, paymentsRegister, todoQueue } from "@/server/queries/deals";
import { asgPayouts, financeKpis, pnlTable, receivables, revenueStructure } from "@/server/queries/finance";
import {
  bundlesTable, dataExists, devicesTable, formatsTable, geoMatrix, geoTable, networksTable, overlappingSites, revenueSplitDaily,
  siteGeoWithNetworks, sitesTable, sourcesTable, topMovers, zonesTable,
} from "@/server/queries/reports";
import { enterPeriod, recordPayment } from "@/server/services/deals";
import { resetDb, testDb } from "./helpers";

const db = testDb();
let net: Awaited<ReturnType<typeof buildNetwork>>;
const P = { from: "2026-09-20", to: "2026-09-21" };
beforeEach(async () => { await resetDb(); net = await buildNetwork(db); });

describe("traffic sources", () => {
  it("volume, revenue their traffic earned and its revshare cost per source", async () => {
    const date = new Date("2026-09-20T00:00:00Z");
    await db.factCost.deleteMany(); // the reference network's rate costs
    await db.costSource.create({ data: { slug: "direct", title: "Direct", asgName: "Direct", revShare: 0 } });
    await db.factTrafficSource.createMany({ data: [
      { date, siteId: "s1", sourceSlug: "tubecrown", pageLoads: 750, revenueReported: "6" },
      { date, siteId: "s1", sourceSlug: "direct", pageLoads: 250, revenueReported: "4" },
    ] });
    await db.factCost.create({ data: { date, siteId: "s1", countryCode: "ZZ", sourceSlug: "tubecrown", rateModel: "REVSHARE", rate: "1", cost: "6", origin: "ASG" } });
    const t = await sourcesTable(P, "s1");
    expect(t.map((r) => [r.source, r.loads, r.reported, r.cost])).toEqual([["TubeCrown", 750, 6, 6], ["Direct", 250, 4, 0]]);
    expect(t[0].loadsShare).toBeCloseTo(0.75);
    expect(t[0].costPer1k).toBeCloseTo(8);
    expect([t[0].share, t[1].share]).toEqual([1, 0]);
  });
});

describe("common", () => {
  it("totals by sites: mediated 122 + direct deals 6, cost 102", async () => {
    const t = await totals(P);
    expect([t.revenue, t.cost, t.margin, t.revenueDirect]).toEqual([128, 102, 26, 6]);
    expect(t.romi).toBeCloseTo((26 / 102) * 100);
    const days = await dailyTotals({ from: "2026-09-19", to: "2026-09-21" });
    expect(Number.isNaN(days[0].revenue)).toBe(true); // a gap, not zero
    expect(days[1].revenue).toBe(65); // 60 + own_deals 2 + direct 3
    const k = await kpis(P);
    expect(k.spark).toHaveLength(14);
    expect(k.prev.revenue).toBe(0);
    expect((await siteList()).map((s) => s.domain)).toEqual(["one.test", "three.test", "two.test"]);
    await db.ingestRun.create({ data: { source: "adspyglass", job: "asg:totals", dateFrom: net.s1.createdAt, dateTo: net.s1.createdAt, status: "failed" } });
    expect((await freshness()).find((f) => f.source === "adspyglass")).toMatchObject({ failed: true, lastOk: null });
  });
});

describe("reports", () => {
  it("bundles overlap: sum of bundles exceeds the network", async () => {
    const b = await bundlesTable(P);
    const sum = b.reduce((a, x) => a + x.revenue, 0);
    expect(sum).toBeGreaterThan((await totals(P)).revenue);
    expect(await overlappingSites()).toBe(1);
    expect(await dataExists()).toBe(true);
  });

  it("sites, movers, formats, geo, networks, zones, devices", async () => {
    const sites = await sitesTable(P);
    expect(sites.find((s) => s.domain === "three.test")?.revenue).toBe(46); // 40 + direct 6
    const movers = await topMovers(P);
    expect(movers.up.length + movers.down.length).toBe(3);
    expect((await formatsTable(P))[0]).toMatchObject({ format: "BANNER", revenue: 1.2 });
    const geo = await geoTable(P, {}, 1);
    expect(geo).toHaveLength(2); // top 1 + "Прочие"
    expect(geo[1].name).toContain("Прочие");
    const nets = await networksTable(P);
    expect(nets.map((n) => n.slug).sort()).toEqual(["adpulsar", "own_deals"]);
    expect(nets[0].rank).toBe(1);
    expect((await networksTable(P, {}, "US")).map((n) => n.slug)).toEqual(["adpulsar"]);
    expect((await zonesTable(P, "s1"))[0]).toMatchObject({ zone: "Banners_Footer_A", invisible: true });
    expect((await devicesTable(P, "s1"))[0]).toMatchObject({ device: "DESKTOP" });
    const g = await siteGeoWithNetworks(P, "s1");
    expect(g.find((x) => x.country === "JP")?.children.map((c) => c.network).sort()).toEqual(["AdPulsar", "Own deals"]);
  });

  it("revenue split and geo matrix", async () => {
    for (const by of ["formats", "sites", "networks"] as const) expect((await revenueSplitDaily(P, {}, by)).length).toBeGreaterThan(0);
    const split = await revenueSplitDaily(P, { siteIds: ["s3"] }, "networks");
    expect(split.filter((x) => x.key === "Фикс-дилы").reduce((a, x) => a + x.value, 0)).toBe(6);
    expect(await revenueSplitDaily(P, { siteIds: [] }, "sites")).toEqual([]);
    const m = await geoMatrix(P);
    expect(m.countries).toEqual(["JP", "US"]);
    expect(m.value("one.test", "US")).toBeCloseTo(100); // (20 - 10) / 10
  });
});

describe("finance", () => {
  it("kpis, structure, P&L by tube with completeness", async () => {
    const k = await financeKpis(P, "2026-09-22");
    expect([k.revenue, k.confirmed, k.cost]).toEqual([128, 3, 102]); // only the confirmed direct day
    expect(k.overdue).toBe(0);
    const st = await revenueStructure(P, false);
    expect(st.map((x) => x.date)).toEqual(["2026-09-20", "2026-09-21"]);
    expect(st[0]).toMatchObject({ asg: 62, dealsConfirmed: 3, cost: 51 });
    expect((await revenueStructure(P, true))[0].date).toBe("2026-09");
    const pnl = await pnlTable(P);
    const three = pnl.find((r) => r.domain === "three.test")!;
    expect([three.asg, three.deals, three.dealsConfirmed, three.revenue]).toEqual([40, 6, 3, 46]);
    expect(three.months).toHaveLength(1);
    expect(pnl.every((r) => r.costGapDays === 0 && !r.noTraffic)).toBe(true);
  });

  it("payouts and receivables", async () => {
    const p = await asgPayouts(3, "2026-10-05");
    expect(p[0]).toMatchObject({ month: "2026-09-01", reported: 122, status: "AWAITING" });
    const id = await enterPeriod(db, net.direct.id, { from: "2026-09-20", to: "2026-09-21", amountInvoiced: "6", impsReported: 6000, dueAt: "2026-09-25", overrideReason: "flat agreed" });
    const r = await receivables("2026-10-01");
    expect(r[0]).toMatchObject({ outstanding: 6, overdueDays: 6, advertiser: "Acme Ads" });
    expect((await financeKpis(P, "2026-10-01")).overdue).toBe(6);
    await recordPayment(db, id, { amountPaid: "6", paidAt: "2026-10-01" });
    expect(await receivables("2026-10-01")).toEqual([]);
  });
});

describe("deals", () => {
  it("list, queue, payments register, detail", async () => {
    const list = await dealsList(P);
    expect(list.map((d) => d.title).sort()).toEqual(["Own popunder", "Sponsor banner"]);
    expect(list.find((d) => d.title === "Sponsor banner")).toMatchObject({ forecast: 3, confirmed: 3 });
    expect((await dealsList(P, "archive"))).toEqual([]);
    const todo = await todoQueue("2026-11-10");
    expect(todo.some((t) => t.kind === "enter" && t.title === "Sponsor banner" && t.from === "2026-09-20")).toBe(true);
    expect(todo.some((t) => t.title === "Own popunder")).toBe(false); // VIA_ASG deals are billed by AdSpyglass
    const id = await enterPeriod(db, net.direct.id, { from: "2026-09-20", to: "2026-09-30", amountInvoiced: "6", impsReported: 6600, dueAt: "2026-10-05", overrideReason: "flat agreed" });
    const reg = await paymentsRegister("2026-11-10");
    expect(reg.rows[0]).toMatchObject({ outstanding: 6, bucket: "31–60" });
    expect(reg.advertisers[0]).toMatchObject({ advertiser: "Acme Ads", b60: 6 });
    const q = await todoQueue("2026-11-10");
    expect(q.find((t) => t.kind === "overdue")).toMatchObject({ periodId: id, outstanding: 6 });
    const d = await dealDetail(net.direct.id);
    expect(d?.periods[0]).toMatchObject({ own: 40000, impsReported: 6600 }); // 2 days × 2 countries × 10k loads
    expect(d?.periods[0].discrepancy).toBeCloseTo((40000 - 6600) / 40000);
    expect(d?.outstanding).toBe(6);
    expect(d?.history.length).toBeGreaterThan(0);
    expect(await dealDetail("nope")).toBeNull();
  });
});

describe("geo: no-country money is spread over the countries by page loads", () => {
  it("ZZ source cost lands on JP and US pro rata to loads, the ZZ row disappears, totals stay equal", async () => {
    await db.factCost.create({ data: { date: D1, siteId: "s1", countryCode: "ZZ", sourceSlug: "tubecrown", uniquesBought: 0, rateModel: "REVSHARE", rate: "1", cost: "8", origin: "ASG" } });
    const rows = await geoTable(P, { siteIds: ["s1"] }, 0);
    expect(rows.map((r) => r.country).sort()).toEqual(["JP", "US"]);
    const jp = rows.find((r) => r.country === "JP")!, us = rows.find((r) => r.country === "US")!;
    expect(jp.cost + us.cost).toBeCloseTo(24 + 10 + 8, 6); // factory cost + the spread $8
    expect(jp.cost).toBeCloseTo(24 + 4, 6); // equal loads → half each
    expect([jp.estimated, us.estimated]).toEqual([true, true]);
    const t = await totals(P, { siteIds: ["s1"] });
    expect(rows.reduce((a, r) => a + r.cost, 0)).toBeCloseTo(t.cost, 6);
    expect(rows.reduce((a, r) => a + r.revenue, 0)).toBeCloseTo(t.revenue, 6);
  });

  it("a site with only ZZ rows keeps one «Без страны» row without ROMI", async () => {
    await db.factRevenueGeo.deleteMany({ where: { siteId: "s2" } });
    await db.factTraffic.deleteMany({ where: { siteId: "s2" } });
    await db.factCost.deleteMany({ where: { siteId: "s2" } });
    await db.factRevenueGeo.create({ data: { date: D1, siteId: "s2", networkId: net.net.id, countryCode: "ZZ", device: "UNKNOWN", pageLoads: 100, revenueReported: "5" } });
    const rows = await geoTable(P, { siteIds: ["s2"] }, 0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ country: "ZZ", name: "Без страны", revenue: 5, romi: null, revPer1k: null });
  });

  it("the geo matrix spreads no-country cost per site too", async () => {
    await db.factCost.create({ data: { date: D1, siteId: "s1", countryCode: "ZZ", sourceSlug: "tubecrown", uniquesBought: 0, rateModel: "REVSHARE", rate: "1", cost: "8", origin: "ASG" } });
    const mx = await geoMatrix(P);
    expect(mx.countries).not.toContain("ZZ");
    expect(mx.value("one.test", "JP")).toBeCloseTo(((22 - 28) / 28) * 100, 3); // $20 + $2 own deal vs $24 + half of the $8
  });
});
