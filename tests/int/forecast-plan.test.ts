import { beforeEach, describe, expect, it } from "vitest";
import { D1, D2, buildNetwork } from "@tests/factories/network";
import { RuleError } from "@/server/domain/errors";
import { monthsForecast } from "@/server/queries/forecast";
import { copyOpexToMonth, deletePlanItem, readForecastPlan, resetPlanMonth, saveForecastPlan, savePlanItem, savePlanMonth } from "@/server/services/forecast-plan";
import { saveOpex } from "@/server/services/opex";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const TODAY = "2026-09-22";
let net: Awaited<ReturnType<typeof buildNetwork>>;
const SRC = (date: Date, siteId: string) => ({ date, siteId, sourceSlug: "tubecrown", pageLoads: 100, impsOwn: 0, clicks: 0, revenueReported: "1" });
const flat = (title: string, price: string, startsAt: string, endsAt: string | null = null, status: "ACTIVE" | "DRAFT" = "ACTIVE") => db.deal.create({ data: {
  title, advertiserId: net.direct.advertiserId, format: "BANNER", price, paymentBasis: "FLAT_PERIOD", billingPeriod: "MONTH", status, billedVia: "DIRECT",
  startsAt: new Date(`${startsAt}T00:00:00Z`), endsAt: endsAt ? new Date(`${endsAt}T00:00:00Z`) : null, sites: { create: [{ siteId: "s1" }] } } });

beforeEach(async () => {
  await resetDb(); net = await buildNetwork(db);
  await db.factTrafficSource.createMany({ data: [D1, D2].flatMap((d) => ["s1", "s2", "s3"].map((s) => SRC(d, s))) });
});

describe("months ahead (ADR 0020)", () => {
  it("rotation runs at the AdSpyglass pace without the direct deal, which comes back by its own dates; via-ADOK deals stay inside the pace", async () => {
    // Factory: $64 a day of which $3 is the direct per-1000-loads deal on s3 → rotation $61/day, traffic cost $51/day.
    const f = await monthsForecast(TODAY, 7, 3);
    expect(f.pace).toEqual({ rotation: 61, cost: 51, daysUsed: 2 });
    expect(f.months.map((m) => m.month)).toEqual(["2026-10", "2026-11", "2026-12"]);
    const oct = f.months[0];
    expect(oct.rotation).toBeCloseTo(61 * 31, 6); expect(oct.trafficCost).toBeCloseTo(51 * 31, 6);
    expect(oct.deals).toBeCloseTo(3 * 31, 6); // its accruals over the last days: $3/day
    expect(oct.dealLines.map((d) => [d.title, d.estimate])).toEqual([["Sponsor banner", false]]);
    expect(f.months[1].rotation).toBeCloseTo(61 * 30, 6);
    expect(f.current!.month).toBe("2026-09");
    expect(oct.cumMargin).toBeCloseTo(f.current!.margin + oct.margin, 6);
  });

  it("a future flat deal lands in its months only, an ending one stops, a per-load deal without accruals is an estimate from its sites' loads", async () => {
    await flat("Future flat", "300", "2026-11-15");
    await flat("Ends in Oct", "310", "2026-09-01", "2026-10-10");
    await db.deal.create({ data: { title: "New CPM", advertiserId: net.direct.advertiserId, format: "BANNER", price: "2", paymentBasis: "PER_1000_LOADS", billedVia: "DIRECT",
      startsAt: new Date("2026-10-01T00:00:00Z"), sites: { create: [{ siteId: "s2" }] } } });
    const [oct, nov, dec] = (await monthsForecast(TODAY, 7, 3)).months;
    const line = (m: typeof oct, t: string) => m.dealLines.find((d) => d.title === t);
    expect(line(oct, "Future flat")).toBeUndefined();
    expect(line(nov, "Future flat")!.amount).toBeCloseTo((300 * 16) / 30, 6); // 15–30 Nov of a $300 month
    expect(line(dec, "Future flat")!.amount).toBeCloseTo(300, 6);
    expect(line(oct, "Ends in Oct")!.amount).toBeCloseTo((310 * 10) / 31, 6);
    expect(line(nov, "Ends in Oct")).toBeUndefined();
    const cpm = line(oct, "New CPM")!;
    expect(cpm.estimate).toBe(true);
    const loads = await db.$queryRaw<{ v: number }[]>`SELECT SUM(page_loads)::float8 / 2 v FROM v_site_geo_daily WHERE site_id = 's2' AND date BETWEEN ${D1} AND ${D2}`;
    expect(cpm.amount).toBeCloseTo((2 * loads[0].v * 31) / 1000, 6);
  });

  it("drafts are shown apart and join the revenue only when the scenario says so; growth compounds per month ahead", async () => {
    await flat("Talks", "620", "2026-10-01", null, "DRAFT");
    let [oct] = (await monthsForecast(TODAY, 7, 3)).months;
    expect(oct.draftDeals).toBeCloseTo(620, 6);
    const base = oct.revenue;
    expect(base).toBeCloseTo(oct.rotation + oct.deals, 6);
    await saveForecastPlan(db, { horizon: 3, revenueGrowth: 0.1, costGrowth: 0.05, includeDrafts: true });
    expect(await readForecastPlan(db)).toEqual({ horizon: 3, revenueGrowth: 0.1, costGrowth: 0.05, includeDrafts: true });
    const months = (await monthsForecast(TODAY, 7)).months;
    [oct] = months;
    expect(oct.rotation).toBeCloseTo(61 * 31 * 1.1, 6);
    expect(months[1].rotation).toBeCloseTo(61 * 30 * 1.21, 6);
    expect(months[1].trafficCost).toBeCloseTo(51 * 30 * 1.05 ** 2, 6);
    expect(oct.revenue).toBeCloseTo(oct.rotation + oct.deals + 620, 6);
    // out-of-range growth is clamped, a broken setting falls back to the default
    expect((await saveForecastPlan(db, { horizon: 12, revenueGrowth: 5, costGrowth: -3, includeDrafts: false })).revenueGrowth).toBe(1);
    await db.appSetting.update({ where: { key: "forecast_plan" }, data: { value: "{" } });
    expect((await readForecastPlan(db)).horizon).toBe(6);
  });

  it("operating expenses as entered; a month without entries repeats the last one and says so", async () => {
    await saveOpex(db, { month: "2026-10", title: "Servers", category: "HOSTING", amount: "300" });
    await saveOpex(db, { month: "2026-12", title: "Servers", category: "HOSTING", amount: "500" });
    const [oct, nov, dec, jan] = (await monthsForecast(TODAY, 7, 6)).months;
    expect([oct.opex, oct.opexCarried]).toEqual([300, false]);
    expect([nov.opex, nov.opexCarried]).toEqual([300, true]);
    expect([dec.opex, dec.opexCarried]).toEqual([500, false]);
    expect([jan.opex, jan.opexCarried]).toEqual([500, true]);
    expect(nov.margin).toBeCloseTo(nov.revenue - nov.cost - 300, 6);
  });

  it("planned lines: revenue and cost of a month, this month included; no past months; every change in the audit log", async () => {
    const rev = await savePlanItem(db, { month: "2026-11", kind: "REVENUE", title: "New site", amount: "1000" }, undefined, TODAY);
    await savePlanItem(db, { month: "2026-11", kind: "COST", title: "Traffic buy", amount: "200", siteId: "s1" }, undefined, TODAY);
    await savePlanItem(db, { month: "2026-09", kind: "REVENUE", title: "One-off", amount: "50" }, undefined, TODAY);
    await expect(savePlanItem(db, { month: "2026-08", kind: "REVENUE", title: "Late", amount: "5" }, undefined, TODAY)).rejects.toBeInstanceOf(RuleError);
    await expect(savePlanItem(db, { month: "2026-11", kind: "PROFIT", title: "x", amount: "5" }, undefined, TODAY)).rejects.toMatchObject({ field: "kind" });
    await expect(savePlanItem(db, { month: "2026-11", kind: "COST", title: "x", amount: "0" }, undefined, TODAY)).rejects.toMatchObject({ field: "amount" });
    const before = (await monthsForecast(TODAY, 7, 3));
    const nov = before.months[1];
    expect([nov.itemsRevenue, nov.itemsCost]).toEqual([1000, 200]);
    expect(nov.revenue).toBeCloseTo(nov.rotation + nov.deals + 1000, 6); expect(nov.cost).toBeCloseTo(nov.trafficCost + 200, 6);
    expect(before.current!.itemsRevenue).toBe(50);
    expect(before.items.map((x) => x.title)).toEqual(["One-off", "New site", "Traffic buy"]);
    await savePlanItem(db, { month: "2026-12", kind: "REVENUE", title: "New site", amount: "1500" }, rev, TODAY);
    await deletePlanItem(db, rev);
    expect((await db.auditLog.findMany({ where: { entity: "PlanItem", entityId: rev }, orderBy: { at: "asc" } })).map((a) => a.field)).toEqual(["created", "updated", "deleted"]);
    expect((await monthsForecast(TODAY, 7, 3)).months[1].itemsRevenue).toBe(0);
  });

  it("this month: the /forecast projection plus deals that start later this month and this month's lines", async () => {
    await flat("Starts 25th", "300", "2026-09-25");
    const f = await monthsForecast(TODAY, 7, 3);
    expect(f.current!.upcomingDeals).toBeCloseTo((300 * 6) / 30, 6);
    expect(f.current!.revenue).toBeCloseTo(128 + 64 * 9 + 60, 6); // $128 actual + $64 × 9 days ahead (today included) + the new deal
  });

  it("a cost cut from a hypothesis, every month from next one up to «по»; a repeating line that already runs keeps its start when edited; the base ignores lines and direct deals", async () => {
    const hyp = await db.hypothesis.create({ data: { source: "MANUAL", status: "TESTING", scope: "site", siteId: "s1", title: "Срезать дорогой источник", hypothesis: "Если отключить источник, то расход упадёт", impactMonth: "400", metric: "cost_per_1k" } });
    const id = await savePlanItem(db, { month: "2026-10", kind: "SAVING", title: "Срезать источник", amount: "400", recurring: true, untilMonth: "2026-11", hypothesisId: hyp.id }, undefined, TODAY);
    await expect(savePlanItem(db, { month: "2026-11", kind: "SAVING", title: "x", amount: "1", recurring: true, untilMonth: "2026-10" }, undefined, TODAY)).rejects.toMatchObject({ field: "untilMonth" });
    await expect(savePlanItem(db, { month: "2026-11", kind: "SAVING", title: "x", amount: "1", hypothesisId: "nope" }, undefined, TODAY)).rejects.toMatchObject({ field: "hypothesisId" });
    let f = await monthsForecast(TODAY, 7, 3);
    const [oct, nov, dec] = f.months;
    expect([oct.itemsSaving, nov.itemsSaving, dec.itemsSaving]).toEqual([400, 400, 0]);
    expect(oct.cost).toBeCloseTo(oct.trafficCost - 400, 6);
    expect(oct.baseMargin).toBeCloseTo(oct.rotation - oct.trafficCost - oct.opex, 6); // no saving, no direct deal in the base
    expect(oct.margin - oct.baseMargin).toBeCloseTo(oct.deals + 400, 6);
    expect(f.items[0]).toMatchObject({ hypothesisId: hyp.id, hypothesis: "Срезать дорогой источник", months: ["2026-10", "2026-11"] });
    expect((await db.planItem.findMany({ where: { hypothesisId: hyp.id } })).length).toBe(1);
    // A month later the line still runs; editing the amount keeps its October start.
    await savePlanItem(db, { month: "2026-10", kind: "SAVING", title: "Срезать источник", amount: "500", recurring: true, untilMonth: "2026-11", hypothesisId: hyp.id }, id, "2026-11-05");
    f = await monthsForecast(TODAY, 7, 3);
    expect(f.months[1].itemsSaving).toBe(500);
    await expect(savePlanItem(db, { month: "2026-09", kind: "SAVING", title: "Срезать источник", amount: "500" }, id, "2026-11-05")).rejects.toMatchObject({ field: "month" });
  });

  it("the month chain: next month starts from this month per day; an edited month carries on; reset goes back; only months ahead; audited", async () => {
    let f = await monthsForecast(TODAY, 7, 3);
    expect(f.monthRate.rotation).toBeCloseTo(61, 6); // Sept: 2 days of facts + 9 days of pace, all at $61 of rotation
    const deal = f.months[0].dealLines[0];
    await savePlanMonth(db, "2026-10", { rotation: "3100", traffic_cost: "", [`deal:${net.direct.id}`]: "0" }, TODAY);
    await expect(savePlanMonth(db, "2026-09", { rotation: "1" }, TODAY)).rejects.toMatchObject({ field: "month" });
    await expect(savePlanMonth(db, "2026-10", { rotation: "-5" }, TODAY)).rejects.toBeInstanceOf(RuleError);
    await expect(savePlanMonth(db, "2026-10", { "deal:nope": "5" }, TODAY)).rejects.toBeInstanceOf(RuleError);
    f = await monthsForecast(TODAY, 7, 3);
    const [oct, nov] = f.months;
    expect(oct).toMatchObject({ rotation: 3100, edited: { rotation: true, trafficCost: false } });
    expect(nov.rotation).toBeCloseTo(3000, 6); // $100/day × 30
    expect(oct.dealLines.find((d) => d.id === deal.id)).toMatchObject({ amount: 0, edited: true });
    expect(nov.dealLines.find((d) => d.id === deal.id)).toMatchObject({ amount: 0, source: "carried" });
    expect((await db.auditLog.findMany({ where: { entity: "PlanMonth", entityId: "2026-10" } })).map((a) => a.field).sort()).toEqual([`deal:${net.direct.id}`, "rotation"]);
    expect(await savePlanMonth(db, "2026-10", { rotation: "3100" }, TODAY)).toBe(0); // the same figure is no change
    expect(await resetPlanMonth(db, "2026-10")).toBe(2);
    expect((await monthsForecast(TODAY, 7, 3)).months[0].rotation).toBeCloseTo(61 * 31, 6);
  });

  it("copies the operating expenses of the last month that has them onto an empty month, once", async () => {
    await saveOpex(db, { month: "2026-09", title: "Servers", category: "HOSTING", amount: "300" });
    await saveOpex(db, { month: "2026-09", title: "People", category: "SALARY", amount: "1200", siteId: "s1" });
    expect(await copyOpexToMonth(db, "2026-11", TODAY)).toEqual({ from: "2026-09", count: 2 });
    expect((await db.opexEntry.findMany({ where: { month: new Date("2026-11-01T00:00:00Z") } })).map((e) => [e.title, Number(e.amount), e.siteId]).sort())
      .toEqual([["People", 1200, "s1"], ["Servers", 300, null]]);
    await expect(copyOpexToMonth(db, "2026-11", TODAY)).rejects.toMatchObject({ field: "month" });
    const [oct, nov] = (await monthsForecast(TODAY, 7, 3)).months;
    expect([oct.opex, oct.opexCarried, nov.opex, nov.opexCarried]).toEqual([1500, true, 1500, false]);
  });
});
