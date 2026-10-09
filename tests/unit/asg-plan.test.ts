import { describe, expect, it } from "vitest";
import { CUTS, DEFAULT_PLAN, PLAN_MARGIN, UNLIMITED, enabledCuts, normalizePlan, perDayRequests, planCost } from "@/server/ingest/adspyglass/plan";

describe("ADOK request plan (ADR 0016)", () => {
  it("the default plan on 27 sites: 3 nights × (1 + 8 × 27) + 24 hourly = 675 of 800, the rest minus a margin goes to the backfill", () => {
    const c = planCost(DEFAULT_PLAN, 27, 800);
    expect(c).toEqual({ perSite: 8, account: 1, perDay: 217, nightly: 651, hourly: 24, total: 675, reserve: 675 + PLAN_MARGIN, backfill: 800 - 675 - PLAN_MARGIN, over: 0 });
    expect(perDayRequests(DEFAULT_PLAN, 1)).toBe(9);
    // Zones from the account request when they are not pulled per site: one more account request, one less per site.
    expect(perDayRequests({ ...DEFAULT_PLAN, cuts: { ...DEFAULT_PLAN.cuts, spot_site: false } }, 27)).toBe(2 + 7 * 27);
    // Browsers on top of everything: 3 × (1 + 9 × 27) + 24 = 756 — fits, with 14 left for the backfill after the margin.
    expect(planCost({ ...DEFAULT_PLAN, cuts: { ...DEFAULT_PLAN.cuts, browser: true } }, 27, 800)).toMatchObject({ total: 756, over: 0, backfill: 14 });
  });
  it("turning cuts off and re-reading yesterday hourly change the cost; a plan over the budget says by how much", () => {
    const lean = normalizePlan({ cuts: { network: false, device: false, traffic_source: false, ad_type: false, spot_site: false, hour: false, platform: false }, restateDays: 1, hourlyToday: false });
    expect(enabledCuts(lean).map((c) => c.key)).toEqual(["country"]);
    expect(planCost(lean, 27, 800)).toMatchObject({ perDay: 29, nightly: 29, hourly: 48, total: 77 });
    expect(planCost(DEFAULT_PLAN, 100, 800)).toMatchObject({ total: 3 * 801 + 24, over: 3 * 801 + 24 - 800, backfill: 0 });
  });
  it("normalizePlan: country stays on, unknown values fall back to the defaults, garbage is the default plan", () => {
    expect(normalizePlan({ cuts: { country: false, ad_type: "yes" }, restateDays: 9, hourlyToday: "no" })).toEqual(DEFAULT_PLAN);
    expect(normalizePlan({ cuts: { ad_type: false }, restateDays: 2, hourlyToday: false })).toEqual({ cuts: { ...DEFAULT_PLAN.cuts, ad_type: false }, restateDays: 2, hourlyToday: false });
    expect(normalizePlan(null)).toEqual(DEFAULT_PLAN);
    expect(CUTS.find((c) => c.key === "country")?.required).toBe(true);
  });
});

describe("planCost without a daily ceiling", () => {
  it("never reports the plan over budget and leaves the backfill effectively unbounded", () => {
    const c = planCost({ ...DEFAULT_PLAN, restateDays: 7, cuts: { ...DEFAULT_PLAN.cuts, browser: true } }, 27, UNLIMITED);
    expect(c.over).toBe(0);
    expect(c.backfill).toBeGreaterThan(100_000);
  });
});
