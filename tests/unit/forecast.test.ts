import { describe, expect, it } from "vitest";
import { parseLookback, projectMonth } from "@/lib/forecast";

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
