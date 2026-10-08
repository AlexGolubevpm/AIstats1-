import { beforeEach, describe, expect, it } from "vitest";
import { D1, D2 } from "@tests/factories/network";
import { buildNetwork } from "@tests/factories/network";
import { monthForecast } from "@/server/queries/forecast";
import { saveOpex } from "@/server/services/opex";
import { resetDb, testDb } from "./helpers";

const db = testDb();
let net: Awaited<ReturnType<typeof buildNetwork>>;
const SRC = (date: Date, siteId: string) => ({ date, siteId, sourceSlug: "tubecrown", pageLoads: 100, impsOwn: 0, clicks: 0, revenueReported: "1" });
beforeEach(async () => {
  await resetDb(); net = await buildNetwork(db);
  // The factory's two days carry the traffic-source cut (the cost base): that is what makes a day complete for the pace.
  await db.factTrafficSource.createMany({ data: [D1, D2].flatMap((d) => ["s1", "s2", "s3"].map((s) => SRC(d, s))) });
});

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

  it("a day with revenue but no traffic-source cut is not complete: its $0 cost does not enter the pace", async () => {
    await db.factRevenueGeo.create({ data: { date: new Date("2026-09-19T00:00:00Z"), siteId: "s1", networkId: net.net.id, countryCode: "ZZ", device: "UNKNOWN", pageLoads: 100, revenueReported: "300" } });
    const p = (await monthForecast("2026-09-22", 7, "2026-09")).projection;
    expect(p.rate).toEqual({ revenue: 64, cost: 51, daysUsed: 2 }); // 09-19 ignored for the pace
    expect(p.actual.revenue).toBe(428); // but it is real revenue in the month so far
    await db.factTrafficSource.create({ data: SRC(new Date("2026-09-19T00:00:00Z"), "s1") });
    expect((await monthForecast("2026-09-22", 7, "2026-09")).projection.rate.daysUsed).toBe(3);
  });

  it("flat deals ahead are known: $310 a month on one site → $10 a day for the remaining days", async () => {
    await db.deal.create({ data: { title: "Flat", advertiserId: net.direct.advertiserId, format: "BANNER", price: "310", paymentBasis: "FLAT_PERIOD", billingPeriod: "MONTH",
      startsAt: new Date("2026-09-01T00:00:00Z"), billedVia: "DIRECT", sites: { create: [{ siteId: "s1" }] } } });
    const f = await monthForecast("2026-09-22", 3, "2026-09");
    expect(f.knownDeals).toBeCloseTo((310 / 30) * 9, 6);
  });
});
