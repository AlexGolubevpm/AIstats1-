import Decimal from "decimal.js";
import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { payoutDiff, recordAsgPayout } from "@/server/services/finance";
import { saveDeal, deleteDeal, setDealStatus } from "@/server/services/deals";
import { resetDb, testDb } from "./helpers";

const db = testDb();
beforeEach(async () => { await resetDb(); await buildNetwork(db); });

describe("AdSpyglass payouts", () => {
  it("spreads the received sum pro rata and sums exactly", async () => {
    // Factory: 12 cells × $10 + own_deals $2 = $122 reported in September.
    const r = await recordAsgPayout(db, { month: "2026-09", amountReceived: "100.01", receivedAt: "2026-10-05" });
    expect(r.reported).toBe("122");
    const rows = await db.factRevenueGeo.findMany();
    const sum = rows.reduce((a, x) => a.add(x.revenueConfirmed?.toString() ?? 0), new Decimal(0));
    expect(sum.toString()).toBe("100.01");
    expect(rows.every((x) => x.revenueConfirmed != null)).toBe(true);
    const [v] = await db.$queryRaw<{ c: number }[]>`SELECT SUM(revenue_confirmed)::float8 c FROM v_site_geo_daily`;
    expect(v.c).toBeCloseTo(100.01 + 3, 4); // + confirmed direct deal day
    expect((await db.asgPayout.findFirstOrThrow()).amountReported.toString()).toBe("122");
  });

  it("rejects empty months and bad amounts", async () => {
    await expect(recordAsgPayout(db, { month: "2025-01", amountReceived: "1", receivedAt: "2025-02-01" })).rejects.toMatchObject({ field: "month" });
    await expect(recordAsgPayout(db, { month: "2026-09", amountReceived: "abc", receivedAt: "2026-10-01" })).rejects.toMatchObject({ field: "amountReceived" });
  });

  it("diff", () => {
    expect(payoutDiff("100", "97")).toBeCloseTo(-0.03);
    expect(payoutDiff("0", "1")).toBeNull();
  });
});

describe("deal terms", () => {
  const base = { title: "Header banner", advertiser: "  NewAdv ", format: "BANNER", paymentBasis: "PER_1000_LOADS" as const, price: "0.8",
    siteIds: ["s1"], geoScope: [], geoExclude: false, startsAt: "2026-09-01", endsAt: null, billingPeriod: "MONTH" as const, paymentTermsDays: 30,
    counterSource: "ASG_ZONE" as const, billedVia: "DIRECT" as const };

  it("creates the advertiser, logs changes and protects entered periods", async () => {
    const id = await saveDeal(db, base);
    const deal = await db.deal.findUniqueOrThrow({ where: { id }, include: { advertiser: true, sites: true } });
    expect([deal.advertiser.name, deal.sites.length, deal.status]).toEqual(["NewAdv", 1, "ACTIVE"]);
    await saveDeal(db, { ...base, price: "0.9" }, id);
    expect(await db.auditLog.count({ where: { entity: "Deal", entityId: id, field: "price" } })).toBe(1);
    await db.dealPeriod.create({ data: { dealId: id, from: new Date("2026-09-01"), to: new Date("2026-09-30"), status: "INVOICED", amountInvoiced: "5" } });
    await expect(saveDeal(db, { ...base, price: "1" }, id)).rejects.toMatchObject({ field: "reason" });
    await saveDeal(db, { ...base, price: "1" }, id, "новый прайс с октября");
    await expect(deleteDeal(db, id)).rejects.toMatchObject({ code: "delete" });
    await setDealStatus(db, id, "ENDED", "2026-09-30");
    expect((await db.deal.findUniqueOrThrow({ where: { id } })).endsAt?.toISOString().slice(0, 10)).toBe("2026-09-30");
  });

  it("validates input", async () => {
    await expect(saveDeal(db, { ...base, price: "0" })).rejects.toMatchObject({ field: "price" });
    await expect(saveDeal(db, { ...base, siteIds: [] })).rejects.toMatchObject({ field: "siteIds" });
    await expect(saveDeal(db, { ...base, endsAt: "2026-08-01" })).rejects.toMatchObject({ field: "endsAt" });
    await expect(saveDeal(db, { ...base, geoScope: ["JPN"] })).rejects.toMatchObject({ field: "geoScope" });
    await expect(saveDeal(db, { ...base, siteIds: ["ghost"] })).rejects.toMatchObject({ field: "siteIds" });
  });
});

describe("month report", () => {
  it("lists site × source × status with costs negative", async () => {
    const { monthReport } = await import("@/server/queries/month-report");
    const csv = (await monthReport("2026-09")).split("\n");
    expect(csv[0]).toBe("month,site,source,status,amount_usd");
    expect(csv).toContain("2026-09,one.test,adspyglass,forecast,42.0000");
    expect(csv).toContain("2026-09,three.test,deal:Acme Ads / Sponsor banner,confirmed,3.0000");
    expect(csv.some((l) => l.startsWith("2026-09,one.test,cost:tubecrown,rate,-34"))).toBe(true);
    expect(csv.some((l) => l.includes("Own popunder"))).toBe(false); // via ASG: already in adspyglass
  });
});
