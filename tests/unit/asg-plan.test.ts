import { describe, expect, it } from "vitest";
import { CUTS, DEFAULT_PLAN, PLAN_MARGIN, enabledCuts, normalizePlan, perDayRequests, planCost } from "@/server/ingest/adspyglass/plan";

describe("ADOK request plan (ADR 0016)", () => {
  it("the default plan on 27 sites: 3 nights × (2 + 5 × 27) + 24 hourly = 435 of 800, the rest minus a margin goes to the backfill", () => {
    const c = planCost(DEFAULT_PLAN, 27, 800);
    expect(c).toEqual({ perSite: 5, perDay: 137, nightly: 411, hourly: 24, total: 435, reserve: 435 + PLAN_MARGIN, backfill: 800 - 435 - PLAN_MARGIN, over: 0 });
    expect(perDayRequests(DEFAULT_PLAN, 1)).toBe(7);
  });
  it("turning cuts off and re-reading yesterday hourly change the cost; a plan over the budget says by how much", () => {
    const lean = normalizePlan({ cuts: { network: false, device: false, traffic_source: false, ad_type: false }, restateDays: 1, hourlyToday: false });
    expect(enabledCuts(lean).map((c) => c.key)).toEqual(["country"]);
    expect(planCost(lean, 27, 800)).toMatchObject({ perDay: 29, nightly: 29, hourly: 48, total: 77 });
    expect(planCost(DEFAULT_PLAN, 100, 800)).toMatchObject({ total: 3 * 502 + 24, over: 3 * 502 + 24 - 800, backfill: 0 });
  });
  it("normalizePlan: country stays on, unknown values fall back to the defaults, garbage is the default plan", () => {
    expect(normalizePlan({ cuts: { country: false, ad_type: "yes" }, restateDays: 9, hourlyToday: "no" })).toEqual(DEFAULT_PLAN);
    expect(normalizePlan({ cuts: { ad_type: false }, restateDays: 2, hourlyToday: false })).toEqual({ cuts: { ...DEFAULT_PLAN.cuts, ad_type: false }, restateDays: 2, hourlyToday: false });
    expect(normalizePlan(null)).toEqual(DEFAULT_PLAN);
    expect(CUTS.find((c) => c.key === "country")?.required).toBe(true);
  });
});
