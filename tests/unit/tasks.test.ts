import { describe, expect, it } from "vitest";
import { impactOfMetric, initials, periodRange, positionBetween, taskInPeriod } from "@/server/domain/tasks";

describe("task board (ADR 0021)", () => {
  it("periods: this week Monday–Sunday, this month, next month across a year, a picked month; «Все» has no bounds", () => {
    expect(periodRange("week", "2026-11-05")).toEqual({ from: "2026-11-02", to: "2026-11-08" }); // Thursday
    expect(periodRange("week", "2026-11-08")).toEqual({ from: "2026-11-02", to: "2026-11-08" }); // Sunday
    expect(periodRange("month", "2026-02-10")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange("next_month", "2026-12-20")).toEqual({ from: "2027-01-01", to: "2027-01-31" });
    expect(periodRange("2027-03", "2026-11-05")).toEqual({ from: "2027-03-01", to: "2027-03-31" });
    expect(periodRange("all", "2026-11-05")).toBeNull();
  });

  it("a task is in a period when its dates overlap it; one date alone is a day; no dates — only in «Все»", () => {
    const nov = periodRange("2026-11", "2026-11-05");
    expect(taskInPeriod({ startDate: "2026-10-25", dueDate: "2026-11-02" }, nov)).toBe(true); // across the border
    expect(taskInPeriod({ startDate: null, dueDate: "2026-11-30" }, nov)).toBe(true);
    expect(taskInPeriod({ startDate: "2026-12-01", dueDate: null }, nov)).toBe(false);
    expect(taskInPeriod({ startDate: null, dueDate: null }, nov)).toBe(false);
    expect(taskInPeriod({ startDate: null, dueDate: null }, null)).toBe(true);
  });

  it("a dropped card takes the midpoint of its neighbours; top and bottom step by 1000", () => {
    expect(positionBetween(null, null)).toBe(1000);
    expect(positionBetween(null, 1000)).toBe(0);
    expect(positionBetween(2000, null)).toBe(3000);
    expect(positionBetween(1000, 2000)).toBe(1500);
  });

  it("what a hypothesis moves from its metric; initials of a name", () => {
    expect([impactOfMetric("cost_per_1k"), impactOfMetric("margin"), impactOfMetric("view_rate"), impactOfMetric("rev_per_1k"), impactOfMetric(null)]).toEqual(["COST", "MARGIN", "QUALITY", "REVENUE", "REVENUE"]);
    expect([initials("Даниил"), initials("Алексей  Голубев"), initials(" ")]).toEqual(["Д", "АГ", "?"]);
  });
});
