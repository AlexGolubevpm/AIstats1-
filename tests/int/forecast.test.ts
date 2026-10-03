import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { monthForecast } from "@/server/queries/forecast";
import { recommendations } from "@/server/queries/recommendations";
import { saveOpex } from "@/server/services/opex";
import { resetDb, testDb } from "./helpers";

const db = testDb();
let net: Awaited<ReturnType<typeof buildNetwork>>;
beforeEach(async () => { await resetDb(); net = await buildNetwork(db); });

describe("month forecast", () => {
  it("two complete days at $64 → September at $64/day; opex known for the month; sites ranked by projection; previous month shown", async () => {
    await saveOpex(db, { month: "2026-09", title: "Servers", category: "HOSTING", amount: "300" });
    await db.factRevenueGeo.create({ data: { date: new Date("2026-08-05T00:00:00Z"), siteId: "s1", networkId: net.net.id, countryCode: "US", device: "DESKTOP", pageLoads: 100, revenueReported: "50" } });
    const f = await monthForecast("2026-09-22", 7, "2026-09");
    const p = f.projection;
    expect(p.rate).toEqual({ revenue: 64, cost: 51, daysUsed: 2 }); // factory: $128 and $102 over the two days
    expect(p.actual).toMatchObject({ revenue: 128, cost: 102, days: 2 });
    expect(p.daysLeft).toBe(9); // 22…30
    expect(p.projected).toMatchObject({ revenue: 128 + 64 * 9, cost: 102 + 51 * 9, opex: 300 });
    expect(p.days.filter((d) => d.kind === "actual")).toHaveLength(21);
    expect(f.sites.map((s) => s.domain)).toEqual(["three.test", "one.test", "two.test"]); // s3 has the direct deal on top
    expect(f.sites[1]).toMatchObject({ actual: 42, rate: 21, prevMonth: 50 }); // s1: $40 + $2 own deal; August $50
    expect(f.sites[1].delta).toBeCloseTo((42 + 21 * 9 - 50) / 50, 6);
    expect(f.prev).toMatchObject({ month: "2026-08", revenue: 50, cost: 0, opex: 0, margin: 50 });
    expect(f.knownDeals).toBe(0); // the factory's deals are not flat
  });

  it("flat deals ahead are known: $310 a month on one site → $10 a day for the remaining days", async () => {
    await db.deal.create({ data: { title: "Flat", advertiserId: net.direct.advertiserId, format: "BANNER", price: "310", paymentBasis: "FLAT_PERIOD", billingPeriod: "MONTH",
      startsAt: new Date("2026-09-01T00:00:00Z"), billedVia: "DIRECT", sites: { create: [{ siteId: "s1" }] } } });
    const f = await monthForecast("2026-09-22", 3, "2026-09");
    expect(f.knownDeals).toBeCloseTo((310 / 30) * 9, 6);
  });
});

describe("recommendations query", () => {
  it("collects alerts and rules over the factory network", async () => {
    await db.alert.create({ data: { rule: "loss_geo", entityKey: "site:s1|country:JP", level: "CRITICAL", title: "Убыточное гео JP на one.test",
      message: "За 7 дней выручка $20.00 при расходе $24.00 (ROMI -16.7%). Снизить закупку гео или поднять флор.", link: "/sites/one.test?by=geo", siteId: "s1", moneyAtRisk: "4", payload: {} } });
    const list = await recommendations("2026-09-22");
    const ids = list.map((r) => r.id);
    expect(ids).toContain("alert:" + (await db.alert.findFirstOrThrow()).id);
    expect(ids).toContain("zone-invisible:s1:Banners_Footer_A"); // 6 000 views of 60 000 impressions
    expect(ids.some((i) => i.startsWith("free:"))).toBe(true); // every factory site has 10 free places
    expect(list[0].level).toBe("CRITICAL");
    expect(list.every((r) => r.action && r.title && r.link)).toBe(true);
  });
});
