import { describe, expect, it } from "vitest";
import { dealMonthAmount, parseHorizon, parseLookback, planItemMonths, projectMonth, projectMonths, shiftMonth, type PlanDeal } from "@/lib/forecast";

const day = (date: string, revenue: number | null, cost = 0) => ({ date, revenue, cost });

describe("projectMonth", () => {
  it("3 complete days at $10 → the month closes at 30 × $10; today and later days are projected at the pace", () => {
    const p = projectMonth({ month: "2026-09", today: "2026-09-04", lookback: 7, days: [day("2026-09-01", 10, 4), day("2026-09-02", 10, 4), day("2026-09-03", 10, 4)] });
    expect(p.rate).toEqual({ revenue: 10, cost: 4, daysUsed: 3 });
    expect(p.actual).toEqual({ revenue: 30, cost: 12, opex: 0, margin: 18, days: 3 });
    expect(p.daysLeft).toBe(27);
    expect(p.projected).toEqual({ revenue: 300, cost: 120, opex: 0, margin: 180, romi: 150 });
    expect(p.days).toHaveLength(30);
    expect(p.days.map((d) => d.kind).slice(2, 6)).toEqual(["actual", "today", "forecast", "forecast"]);
    expect(p.days[29]).toMatchObject({ date: "2026-09-30", revenue: 10, cost: 4, cumRevenue: 300, cumMargin: 180 });
  });

  it("the pace uses only the last N complete days and may reach into the previous month; a gap day is skipped", () => {
    const days = [day("2026-08-30", 100), day("2026-08-31", 100), day("2026-09-01", 10), day("2026-09-02", null), day("2026-09-03", 10)];
    const p3 = projectMonth({ month: "2026-09", today: "2026-09-04", lookback: 3, days });
    expect(p3.rate).toMatchObject({ revenue: 40, daysUsed: 3 }); // 100 + 10 + 10, the empty day is not a day
    expect(p3.actual.days).toBe(2);
    expect(p3.days[1]).toMatchObject({ kind: "actual", revenue: null, margin: null });
    const p7 = projectMonth({ month: "2026-09", today: "2026-09-04", lookback: 7, days });
    expect(p7.rate.daysUsed).toBe(4);
  });

  it("operating expenses are known for every day and lower the margin, not the pace", () => {
    const opexByDay = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, "0")}`, 1]));
    const p = projectMonth({ month: "2026-09", today: "2026-09-03", lookback: 7, days: [day("2026-09-01", 10), day("2026-09-02", 10)], opexByDay });
    expect(p.rate.revenue).toBe(10);
    expect(p.projected).toMatchObject({ revenue: 300, opex: 30, margin: 270 });
    expect(p.days[0]).toMatchObject({ opex: 1, margin: 9 });
  });

  it("a finished month has no forecast part; no complete days → no projection", () => {
    const done = projectMonth({ month: "2026-08", today: "2026-09-10", lookback: 7, days: [day("2026-08-01", 5), day("2026-08-31", 7)] });
    expect(done.daysLeft).toBe(0);
    expect(done.days.every((d) => d.kind === "actual")).toBe(true);
    expect(done.projected).toMatchObject({ revenue: 12, margin: 12 });
    const empty = projectMonth({ month: "2026-09", today: "2026-09-01", lookback: 7, days: [] });
    expect(empty.projected).toBeNull();
    expect(empty.days[0]).toMatchObject({ kind: "today", revenue: null });
  });

  it("lookback parsing", () => {
    expect([parseLookback("3"), parseLookback("14"), parseLookback("9"), parseLookback(undefined)]).toEqual([3, 14, 7, 7]);
  });
});

describe("months ahead (ADR 0020)", () => {
  const deal = (over: Partial<PlanDeal>): PlanDeal => ({ id: "d", title: "D", sites: "a.test", status: "ACTIVE", basis: "FLAT_PERIOD", price: "300", billingPeriod: "MONTH", startsAt: "2026-01-01", endsAt: null, ...over });
  const base = { current: "2026-10", rate: { rotation: 100, cost: 40 }, scenario: { revenueGrowth: 0, costGrowth: 0, includeDrafts: false }, deals: [] as PlanDeal[], opexByMonth: {}, items: [] };

  it("shiftMonth crosses years; horizons are 3/6/12", () => {
    expect(shiftMonth("2026-11", 2)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect([parseHorizon("12"), parseHorizon("5"), parseHorizon(undefined, 3)]).toEqual([12, 6, 3]);
  });

  it("dealMonthAmount: a flat month deal pays day by day inside its dates; per-load deals at their per-day revenue", () => {
    expect(dealMonthAmount(deal({}), "2026-11")).toBeCloseTo(300, 6);
    expect(dealMonthAmount(deal({ startsAt: "2026-11-21" }), "2026-11")).toBeCloseTo(100, 6); // 10 of 30 days
    expect(dealMonthAmount(deal({ endsAt: "2026-10-31" }), "2026-11")).toBe(0);
    expect(dealMonthAmount(deal({ basis: "PER_1000_LOADS", price: "1", perDay: 7 }), "2026-02")).toBeCloseTo(7 * 28, 6);
    expect(dealMonthAmount(deal({ basis: "FLAT_DAILY", price: "5" }), "2026-12")).toBeCloseTo(5 * 31, 6);
  });

  it("projects each month: rotation and cost × days with compounding growth, deals, drafts apart, planned lines, opex carried, margin accumulated", () => {
    const rows = projectMonths({ ...base, months: ["2026-11", "2026-12"], cumStart: 1000,
      scenario: { revenueGrowth: 0.1, costGrowth: 0, includeDrafts: false },
      deals: [deal({ id: "a", title: "Flat" }), deal({ id: "b", title: "Talks", status: "DRAFT", price: "600" }), deal({ id: "c", title: "CPM", basis: "CPM_OWN", price: "2", perDay: 3, estimate: true })],
      opexByMonth: { "2026-10": 500 }, items: [{ month: "2026-12", kind: "REVENUE", amount: 1000 }, { month: "2026-12", kind: "COST", amount: 250 }] });
    const [nov, dec] = rows;
    expect(nov.rotation).toBeCloseTo(100 * 30 * 1.1, 6); expect(dec.rotation).toBeCloseTo(100 * 31 * 1.21, 6);
    expect(nov.trafficCost).toBeCloseTo(40 * 30, 6);
    expect(nov.deals).toBeCloseTo(300 + 3 * 30, 6); expect(nov.draftDeals).toBeCloseTo(600, 6);
    expect(nov.dealLines.map((d) => [d.title, d.draft, d.estimate])).toEqual([["Talks", true, false], ["Flat", false, false], ["CPM", false, true]]);
    expect(nov.revenue).toBeCloseTo(nov.rotation + nov.deals, 6); // the draft stays out
    expect([nov.opex, nov.opexCarried]).toEqual([500, true]);
    expect(dec.revenue).toBeCloseTo(dec.rotation + dec.deals + 1000, 6); expect(dec.cost).toBeCloseTo(40 * 31 + 250, 6);
    expect(nov.margin).toBeCloseTo(nov.revenue - nov.cost - 500, 6);
    expect(dec.cumMargin).toBeCloseTo(1000 + nov.margin + dec.margin, 6);
    expect(nov.romi).toBeCloseTo(((nov.revenue - nov.cost) / nov.cost) * 100, 6);
    const withDrafts = projectMonths({ ...base, months: ["2026-11"], deals: [deal({ status: "DRAFT", price: "600" })], scenario: { revenueGrowth: 0, costGrowth: 0, includeDrafts: true } });
    expect(withDrafts[0].revenue).toBeCloseTo(100 * 30 + 600, 6);
    expect(projectMonths({ ...base, months: ["2026-11"] })[0]).toMatchObject({ opex: 0, opexCarried: false, romi: 150 });
  });
});

describe("planned lines over months and the base (ADR 0020 addendum)", () => {
  const months = ["2026-11", "2026-12", "2027-01", "2027-02"];
  it("planItemMonths: one month, every month from a start, every month up to «по»", () => {
    expect(planItemMonths({ month: "2026-12", recurring: false, until: null }, months)).toEqual(["2026-12"]);
    expect(planItemMonths({ month: "2026-12", recurring: true, until: null }, months)).toEqual(["2026-12", "2027-01", "2027-02"]);
    expect(planItemMonths({ month: "2026-10", recurring: true, until: "2026-12" }, months)).toEqual(["2026-11", "2026-12"]); // started before the view
    expect(planItemMonths({ month: "2027-05", recurring: true, until: null }, months)).toEqual([]);
  });

  it("a saving lowers the cost (never below zero); the base margin is AdSpyglass alone: no deals, no lines", () => {
    const [nov] = projectMonths({ current: "2026-10", months: ["2026-11"], rate: { rotation: 100, cost: 40 }, scenario: { revenueGrowth: 0, costGrowth: 0, includeDrafts: false },
      deals: [{ id: "a", title: "Flat", sites: "", status: "ACTIVE", basis: "FLAT_PERIOD", price: "300", billingPeriod: "MONTH", startsAt: "2026-01-01", endsAt: null }],
      opexByMonth: { "2026-11": 100 }, items: [{ month: "2026-11", kind: "SAVING", amount: 200 }, { month: "2026-11", kind: "REVENUE", amount: 50 }], cumBaseStart: 10 });
    expect(nov.itemsSaving).toBe(200);
    expect(nov.cost).toBeCloseTo(40 * 30 - 200, 6);
    expect(nov.margin).toBeCloseTo(100 * 30 + 300 + 50 - (40 * 30 - 200) - 100, 6);
    expect(nov.baseMargin).toBeCloseTo(100 * 30 - 40 * 30 - 100, 6);
    expect(nov.cumBaseMargin).toBeCloseTo(10 + nov.baseMargin, 6);
    const [big] = projectMonths({ current: "2026-10", months: ["2026-11"], rate: { rotation: 1, cost: 1 }, scenario: { revenueGrowth: 0, costGrowth: 0, includeDrafts: false },
      deals: [], opexByMonth: {}, items: [{ month: "2026-11", kind: "SAVING", amount: 1000 }] });
    expect(big.cost).toBe(0);
  });
});

