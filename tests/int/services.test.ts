import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork, D1, D2 } from "@tests/factories/network";
import { applyCostImport, previewCostImport, recalcCosts, revertCostImport } from "@/server/services/costs";
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

  it("per-site periods, and deals without counters land on the last day", async () => {
    const manual = await db.deal.create({ data: { title: "Flat", advertiserId: net.direct.advertiserId, format: "BANNER", price: "100",
      paymentBasis: "FLAT_PERIOD", counterSource: "MANUAL", startsAt: D1, endsAt: D2, sites: { create: [{ siteId: "s1" }] } } });
    await enterPeriod(db, manual.id, { from: "2026-09-20", to: "2026-09-21", amountInvoiced: "100" });
    const rows = await db.factFixDeal.findMany({ where: { dealId: manual.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ countryCode: "ZZ", siteId: "s1" });
    expect(rows[0].date.toISOString().slice(0, 10)).toBe("2026-09-21");
  });
});
