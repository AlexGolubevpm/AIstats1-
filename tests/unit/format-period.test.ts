import { describe, expect, it } from "vitest";
import * as f from "@/lib/format";
import { eachDay, periodFromParams, presetPeriod, previousPeriod } from "@/lib/period";

describe("format", () => {
  it("renders zero and missing as a dash", () => {
    for (const s of [f.fmtInt(0), f.fmtMoney(null), f.fmtCpm(undefined), f.fmtPercent(0), f.fmtCompact(0), f.fmtDelta(null)]) {
      expect(s).toBe(f.DASH);
    }
  });
  it("formats money with 2 decimals and cpm with 4", () => {
    expect(f.fmtMoney(1234.5)).toBe("$1 234.50");
    expect(f.fmtMoney(-12)).toBe("−$12.00");
    expect(f.fmtCpm(0.81234)).toBe("$0.8123");
  });
  it("formats percents and deltas", () => {
    expect(f.fmtPercent(0.1234)).toBe("12.3%");
    expect(f.fmtPercent(42.7, true)).toBe("42.7%");
    expect(f.fmtDelta(8.34, "pp")).toBe("+8.3 пп");
    expect(f.fmtDelta(-3.21)).toBe("−3.2%");
  });
  it("formats compact numbers", () => {
    expect(f.fmtCompact(2_400_000)).toBe("2.4M");
    expect(f.fmtCompact(612_400)).toBe("612.4K");
    expect(f.fmtCompact(950)).toBe("950");
  });
  it("formats age", () => {
    const now = new Date("2026-09-23T12:00:00Z");
    expect(f.fmtAgo("2026-09-23T11:46:00Z", now)).toBe("14 мин назад");
    expect(f.fmtAgo("2026-09-23T09:00:00Z", now)).toBe("3 ч назад");
    expect(f.fmtAgo(null, now)).toBe("никогда");
  });
});

describe("period", () => {
  const today = "2026-09-23";
  it("builds presets ending yesterday", () => {
    expect(presetPeriod("yesterday", today)).toMatchObject({ from: "2026-09-22", to: "2026-09-22" });
    expect(presetPeriod("7d", today)).toMatchObject({ from: "2026-09-16", to: "2026-09-22" });
    expect(presetPeriod("30d", today)).toMatchObject({ from: "2026-08-24", to: "2026-09-22" });
    expect(presetPeriod("mtd", today)).toMatchObject({ from: "2026-09-01", to: "2026-09-22" });
    expect(presetPeriod("prev_month", today)).toMatchObject({ from: "2026-08-01", to: "2026-08-31" });
    expect(presetPeriod("prev_month", "2026-01-10")).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });
  it("previous period has equal length and ends the day before", () => {
    expect(previousPeriod({ from: "2026-09-16", to: "2026-09-22" })).toEqual({ from: "2026-09-09", to: "2026-09-15" });
  });
  it("reads params, rejects invalid input", () => {
    expect(periodFromParams({ from: "2026-09-01", to: "2026-09-05" }, "7d", today)).toEqual({ from: "2026-09-01", to: "2026-09-05" });
    expect(periodFromParams({ from: "2026-09-05", to: "2026-09-01" }, "7d", today).preset).toBe("7d");
    expect(periodFromParams({ from: "bad", to: "x" }, "30d", today).preset).toBe("30d");
    expect(periodFromParams({ preset: "yesterday" }, "7d", today).from).toBe("2026-09-22");
    expect(periodFromParams({ preset: "nope" }, "7d", today).preset).toBe("7d");
  });
  it("enumerates days", () => {
    expect(eachDay({ from: "2026-02-27", to: "2026-03-02" })).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
  });
});
