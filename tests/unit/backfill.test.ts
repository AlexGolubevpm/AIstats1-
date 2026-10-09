import { describe, expect, it } from "vitest";
import { daysBetween, daysThatFit, defaultWindow, requestsPerDay } from "@/server/jobs/backfill";
import { DEFAULT_PLAN } from "@/server/ingest/adspyglass/plan";

describe("backfill arithmetic", () => {
  it("requests per day follow the plan; days that fit; default window", () => {
    expect(requestsPerDay(27)).toBe(2 + 5 * 27); // the default plan: five per-site cuts
    expect(requestsPerDay(27, "full", { ...DEFAULT_PLAN, cuts: { ...DEFAULT_PLAN.cuts, ad_type: false, device: false } })).toBe(2 + 3 * 27);
    expect(requestsPerDay(27, "totals")).toBe(1);
    expect(daysThatFit(270, 800, 300, 110)).toBe(2); // (800 − 300 − 270) / 110
    expect(daysThatFit(600, 800, 300, 110)).toBe(0);
    expect(defaultWindow("2026-10-04")).toEqual({ from: "2026-10-01", to: "2026-10-01" }); // full cuts: the current month
    expect(defaultWindow("2026-10-04", "totals")).toEqual({ from: "2026-09-01", to: "2026-10-01" }); // totals: from the previous month
    expect(defaultWindow("2026-01-02", "totals")).toEqual({ from: "2025-12-01", to: "2025-12-30" });
    expect(daysBetween("2026-09-29", "2026-10-01")).toEqual(["2026-09-29", "2026-09-30", "2026-10-01"]);
  });
});
