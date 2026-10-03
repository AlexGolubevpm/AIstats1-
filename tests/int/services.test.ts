import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork, D1, D2 } from "@tests/factories/network";
import { applyCostImport, previewCostImport, recalcCosts, revertCostImport, revshareCosts } from "@/server/services/costs";
import { setSourceShare } from "@/server/services/settings";
import { RuleError } from "@/server/domain/errors";
import { correctPeriod, enterPeriod, forecastDeals, markDisputed, recordPayment } from "@/server/services/deals";
import { resetDb, testDb } from "./helpers";

const db = testDb();
let net: Awaited<ReturnType<typeof buildNetwork>>;

beforeEach(async () => {
  await resetDb();
  net = await buildNetwork(db);
});

const sumRevenue = async (dealId: string) =>
  new Decimal((await db.factFixDeal.aggregate({ _sum: { revenue: true }, where: { dealId } }))._sum.revenue?.toString() ?? 0).toString();

describe("ADOK traffic sources as cost (revshare)", () => {
  const traffic = async () => {
    await db.factCost.deleteMany();
    await db.costSource.update({ where: { slug: "tubecrown" }, data: { asgName: "TubeCrown" } });
    await db.costSource.create({ data: { slug: "direct", title: "Direct", asgName: "Direct", revShare: 0 } });
    await db.factTrafficSource.createMany({ data: [
      { date: D1, siteId: "s1", sourceSlug: "tubecrown", pageLoads: 800, revenueReported: "6" },
      { date: D1, siteId: "s1", sourceSlug: "direct", pageLoads: 200, revenueReported: "4" },
    ] });
  };

  it("costs each paid source at the revenue its traffic earned × revShare; Direct is free", async () => {
    await traffic();
    expect(await revshareCosts(db, "2026-09-20", "2026-09-21")).toBe(1);
    const c = await db.factCost.findFirstOrThrow({ where: { siteId: "s1", date: D1, sourceSlug: "tubecrown" } });
    expect([c.countryCode, c.origin, c.rateModel, Number(c.cost), c.uniquesBought]).toEqual(["ZZ", "ASG", "REVSHARE", 6, 800]);
    await setSourceShare(db, "tubecrown", "50");
    await revshareCosts(db, "2026-09-20", "2026-09-21");
    expect(Number((await db.factCost.findFirstOrThrow({ where: { sourceSlug: "tubecrown", date: D1 } })).cost)).toBe(3);
    const [site] = await db.$queryRaw<{ cost: number }[]>`SELECT SUM(cost)::float8 cost FROM v_site_geo_daily WHERE site_id = 's1' AND date = ${D1}`;
    expect(site.cost).toBe(3); // the view's margin now includes it
  });

  it("an imported cost wins; rates of ADOK sources are not applied on top", async () => {
    await traffic();
    await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPM", rate: "2", validFrom: D1 } });
    expect(await recalcCosts(db, "2026-09-20", "2026-09-21")).toBe(0);
    await db.factCost.create({ data: { date: D1, siteId: "s1", countryCode: "ZZ", sourceSlug: "tubecrown", rateModel: "FLAT", rate: "1", cost: "5", origin: "IMPORT" } });
    expect(await revshareCosts(db, "2026-09-20", "2026-09-21")).toBe(0);
    expect((await db.factCost.findMany()).map((c) => [c.origin, Number(c.cost)])).toEqual([["IMPORT", 5]]);
  });

  it("validates the share", async () => {
    await expect(setSourceShare(db, "tubecrown", "120")).rejects.toBeInstanceOf(RuleError);
    await expect(setSourceShare(db, "tubecrown", "abc")).rejects.toBeInstanceOf(RuleError);
    await setSourceShare(db, "tubecrown", "12,5");
    expect(Number((await db.costSource.findUniqueOrThrow({ where: { slug: "tubecrown" } })).revShare)).toBe(0.125);
  });
});

describe("costs service", () => {
  it("recalculates from rates, keeping imported rows", async () => {
    await db.factCost.deleteMany();
    await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPM", rate: "2", validFrom: D1 } });
    expect(await recalcCosts(db, "2026-09-20", "2026-09-21")).toBe(12);
    const one = await db.factCost.findFirstOrThrow({ where: { siteId: "s1", countryCode: "JP", date: D1 } });
    expect(Number(one.cost)).toBe(2); // 1000 uniques / 1000 × $2

    const csv = "date,domain,country,source,uniques,cost\n2026-09-20,one.test,Japan,tubecrown,900,7.5\n2026-09-20,nope.test,JP,tubecrown,1,1\n";
    const preview = await previewCostImport(db, csv);
    expect(preview).toMatchObject({ recognised: 1, total: "7.50", overrides: 1, unknownDomains: ["nope.test"] });
    const { batchId } = await applyCostImport(db, csv, "sept.csv");
    await recalcCosts(db, "2026-09-20", "2026-09-21");
    const after = await db.factCost.findFirstOrThrow({ where: { siteId: "s1", countryCode: "JP", date: D1 } });
    expect([after.origin, Number(after.cost)]).toEqual(["IMPORT", 7.5]);

    await revertCostImport(db, batchId);
    const back = await db.factCost.findFirstOrThrow({ where: { siteId: "s1", countryCode: "JP", date: D1 } });
    expect([back.origin, Number(back.cost)]).toEqual(["RATE", 2]);
  });
});

describe("deals service", () => {
  it("forecast from ASG counters for DIRECT deals, per-1000-loads by default", async () => {
    await db.factFixDeal.deleteMany();
    await forecastDeals(db, "2026-09-20", "2026-09-21");
    // s3 geo: 10 000 loads × 2 countries × 2 days at $1 per 1000 loads
    expect(await sumRevenue(net.direct.id)).toBe("40");
    const states = await db.factFixDeal.findMany({ where: { dealId: net.direct.id }, select: { revenueState: true } });
    expect(new Set(states.map((s) => s.revenueState))).toEqual(new Set(["FORECAST"]));
  });

  it("enter → pay → correct: amounts distributed exactly, states follow, history kept", async () => {
    await db.factFixDeal.deleteMany();
    await forecastDeals(db, "2026-09-20", "2026-09-21");
    await expect(enterPeriod(db, net.direct.id, { from: "2026-09-20", to: "2026-09-21", amountInvoiced: "50", impsReported: 4000 }))
      .rejects.toThrow(/причину/);
    const id = await enterPeriod(db, net.direct.id, { from: "2026-09-20", to: "2026-09-21", amountInvoiced: "40.01", impsReported: 4001, invoiceNo: "INV-9" });
    expect(await sumRevenue(net.direct.id)).toBe("40.01");
    const facts = await db.factFixDeal.findMany({ where: { dealId: net.direct.id } });
    expect(facts.reduce((a, f) => a + f.impsReported, 0)).toBe(4001);
    expect(new Set(facts.map((f) => f.revenueState))).toEqual(new Set(["INVOICED"]));
    await expect(enterPeriod(db, net.direct.id, { from: "2026-09-21", to: "2026-09-25", amountInvoiced: "1", overrideReason: "x" })).rejects.toThrow(/пересекается/);

    // Forecast afterwards must not overwrite the invoiced days.
    await forecastDeals(db, "2026-09-20", "2026-09-21");
    expect(await sumRevenue(net.direct.id)).toBe("40.01");

    await expect(recordPayment(db, id, { amountPaid: "30", paidAt: "2026-10-05" })).rejects.toThrow(/остатком/);
    expect(await recordPayment(db, id, { amountPaid: "30", paidAt: "2026-10-05", remainder: "open" })).toBe("PARTIAL");
    expect(await sumRevenue(net.direct.id)).toBe("30");
    expect(new Set((await db.factFixDeal.findMany({ where: { dealId: net.direct.id } })).map((f) => f.revenueState))).toEqual(new Set(["CONFIRMED"]));

    const v2 = await correctPeriod(db, id, { from: "2026-09-20", to: "2026-09-21", amountInvoiced: "35", overrideReason: "скидка", impsReported: 4001 }, "пересчёт по акту");
    const old = await db.dealPeriod.findUniqueOrThrow({ where: { id } });
    expect(old.supersededById).toBe(v2);
    expect((await db.dealPeriod.findUniqueOrThrow({ where: { id: v2 } })).version).toBe(2);
    expect(await db.auditLog.count({ where: { entity: "DealPeriod" } })).toBe(3);
  });

  it("disputed period counts as invoiced amount, needs a reason", async () => {
    const id = await enterPeriod(db, net.direct.id, { from: "2026-09-20", to: "2026-09-21", amountInvoiced: "40" });
    await expect(markDisputed(db, id, " ")).rejects.toThrow(/причину/);
    await markDisputed(db, id, "не согласны с показами");
    expect((await db.dealPeriod.findUniqueOrThrow({ where: { id } })).status).toBe("DISPUTED");
    expect(await sumRevenue(net.direct.id)).toBe("40");
  });

  it("an entered flat period is spread evenly over its days, even without counters", async () => {
    const manual = await db.deal.create({ data: { title: "Flat", advertiserId: net.direct.advertiserId, format: "BANNER", price: "100",
      paymentBasis: "FLAT_PERIOD", billingPeriod: "TERM", counterSource: "MANUAL", startsAt: D1, endsAt: D2, sites: { create: [{ siteId: "s1" }] } } });
    await enterPeriod(db, manual.id, { from: "2026-09-20", to: "2026-09-21", amountInvoiced: "100" });
    const rows = await db.factFixDeal.findMany({ where: { dealId: manual.id }, orderBy: { date: "asc" } });
    expect(rows.map((r) => [r.date.toISOString().slice(0, 10), r.siteId, r.countryCode, Number(r.revenue)])).toEqual([
      ["2026-09-20", "s1", "ZZ", 50], ["2026-09-21", "s1", "ZZ", 50]]);
  });
});

describe("flat deals: evenly per site and day", () => {
  const D = (s: string) => new Date(`${s}T00:00:00Z`);
  async function sites(n: number) {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) { const s = await db.site.create({ data: { domain: `flat${i}.test`, title: `F${i}` } }); ids.push(s.id); }
    return ids;
  }

  it("$1000 a month on 10 sites = 1000 / 10 / 30 per site per day, whatever the traffic", async () => {
    const ids = await sites(10);
    const deal = await db.deal.create({ data: { title: "Sponsor", advertiserId: net.direct.advertiserId, format: "BANNER", price: "1000",
      paymentBasis: "FLAT_PERIOD", billingPeriod: "MONTH", startsAt: D("2026-09-01"), endsAt: D("2027-08-31"), sites: { create: ids.map((siteId) => ({ siteId })) } } });
    await forecastDeals(db, "2026-09-01", "2026-09-30");
    const rows = await db.factFixDeal.findMany({ where: { dealId: deal.id } });
    expect(rows).toHaveLength(300); // 10 sites × 30 days, none of them has traffic
    expect(new Set(rows.map((r) => Number(r.revenue)))).toEqual(new Set([3.3333]));
    expect(new Set(rows.map((r) => r.countryCode))).toEqual(new Set(["ZZ"]));
    const total = rows.reduce((a, r) => a.add(r.revenue.toString()), new Decimal(0));
    expect(total.toNumber()).toBeCloseTo(1000, 1);
  });

  it("a monthly flat deal follows the calendar month: October of $1000 on 10 sites is 1000 / 10 / 31 a day and $1000 in total", async () => {
    const ids = await sites(10);
    const deal = await db.deal.create({ data: { title: "Sponsor", advertiserId: net.direct.advertiserId, format: "BANNER", price: "1000",
      paymentBasis: "FLAT_PERIOD", billingPeriod: "MONTH", startsAt: D("2026-09-01"), sites: { create: ids.map((siteId) => ({ siteId })) } } });
    await forecastDeals(db, "2026-10-01", "2026-10-31");
    const rows = await db.factFixDeal.findMany({ where: { dealId: deal.id } });
    expect(rows).toHaveLength(310);
    expect(new Set(rows.map((r) => Number(r.revenue)))).toEqual(new Set([3.2258]));
    const total = rows.reduce((a, r) => a.add(r.revenue.toString()), new Decimal(0));
    expect(total.toNumber()).toBeCloseTo(1000, 0);
    const [m] = await db.$queryRaw<{ s: number }[]>`SELECT SUM(revenue_direct)::float8 s FROM v_site_geo_daily WHERE date >= '2026-10-01' AND date <= '2026-10-31'`;
    expect(m.s).toBeCloseTo(1000, 0);
  });

  it("flat per day is split between sites; a weekly price covers 7 days", async () => {
    const ids = await sites(4);
    const daily = await db.deal.create({ data: { title: "Daily", advertiserId: net.direct.advertiserId, format: "OTHER", price: "20",
      paymentBasis: "FLAT_DAILY", startsAt: D("2026-09-20"), endsAt: D("2026-09-21"), sites: { create: ids.map((siteId) => ({ siteId })) } } });
    const weekly = await db.deal.create({ data: { title: "Weekly", advertiserId: net.direct.advertiserId, format: "OTHER", price: "70",
      paymentBasis: "FLAT_PERIOD", billingPeriod: "WEEK", startsAt: D("2026-09-20"), sites: { create: [{ siteId: ids[0] }, { siteId: ids[1] }] } } });
    await forecastDeals(db, "2026-09-20", "2026-09-21");
    const by = async (dealId: string) => (await db.factFixDeal.findMany({ where: { dealId } })).map((r) => Number(r.revenue));
    expect(await by(daily.id)).toEqual(Array(8).fill(5)); // $20 a day / 4 sites, 2 days
    expect(await by(weekly.id)).toEqual(Array(4).fill(5)); // $70 / 7 days / 2 sites
  });

  it("an entered flat period of several sites is spread evenly per site and day", async () => {
    const ids = await sites(2);
    const deal = await db.deal.create({ data: { title: "Two", advertiserId: net.direct.advertiserId, format: "OTHER", price: "100",
      paymentBasis: "FLAT_PERIOD", billingPeriod: "MONTH", startsAt: D("2026-09-01"), sites: { create: ids.map((siteId) => ({ siteId })) } } });
    await enterPeriod(db, deal.id, { from: "2026-09-01", to: "2026-09-30", amountInvoiced: "100" });
    const rows = await db.factFixDeal.findMany({ where: { dealId: deal.id } });
    expect(rows).toHaveLength(60);
    const total = rows.reduce((a, r) => a.add(r.revenue.toString()), new Decimal(0));
    expect(total.toString()).toBe("100"); // exact: the rounding remainder lands on the last day
    expect(Math.max(...rows.map((r) => Number(r.revenue))) - Math.min(...rows.map((r) => Number(r.revenue)))).toBeLessThan(0.01);
  });
});
