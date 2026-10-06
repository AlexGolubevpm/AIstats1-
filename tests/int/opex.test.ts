import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork, D1 } from "@tests/factories/network";
import { RuleError } from "@/server/domain/errors";
import { financeKpis, monthlyPnl, opexEntries, pnlTable } from "@/server/queries/finance";
import { deleteOpex, saveOpex } from "@/server/services/opex";
import { setSourceShare } from "@/server/services/settings";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const SEP = { from: "2026-09-01", to: "2026-09-30" };
beforeEach(async () => { await resetDb(); await buildNetwork(db); });

describe("operating expenses per calendar month", () => {
  it("v_opex_daily spreads the month's figure evenly over its days and sums back exactly; the view is readable by MCP", async () => {
    await saveOpex(db, { month: "2026-09", title: "Servers", category: "HOSTING", amount: "300" });
    await saveOpex(db, { month: "2026-10", title: "Servers", category: "HOSTING", amount: "310" });
    const sep = await db.$queryRaw<{ days: number; total: number; per_day: number }[]>`SELECT count(*)::int days, SUM(amount)::float8 total, MIN(amount)::float8 per_day
      FROM v_opex_daily WHERE date >= '2026-09-01' AND date <= '2026-09-30'`;
    expect(sep[0]).toEqual({ days: 30, total: 300, per_day: 10 });
    const oct = await db.$queryRaw<{ days: number; total: number; per_day: number }[]>`SELECT count(*)::int days, SUM(amount)::float8 total, MIN(amount)::float8 per_day
      FROM v_opex_daily WHERE date >= '2026-10-01' AND date <= '2026-10-31'`;
    expect(oct[0]).toEqual({ days: 31, total: 310, per_day: 10 });
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE mcp_reader");
      expect((await tx.$queryRawUnsafe<unknown[]>("SELECT * FROM v_opex_daily LIMIT 1")).length).toBe(1);
    });
  });

  it("KPIs and P&L: margin is after opex; network-wide opex is shared between sites by revenue, site-tied opex stays on its site", async () => {
    const before = await financeKpis(SEP);
    await saveOpex(db, { month: "2026-09", title: "Servers", category: "HOSTING", amount: "300" }); // $10 a day, 2 days with data in the factory
    await saveOpex(db, { month: "2026-09", title: "Translator", category: "CONTENT", amount: "150", siteId: "s3" }); // $5 a day
    const k = await financeKpis(SEP);
    expect(k.opex).toBeCloseTo(450, 6);
    expect(k.margin).toBeCloseTo(before.margin - 450, 6);
    expect(k.romi).toBe(before.romi); // ROMI stays on traffic cost
    const pnl = await pnlTable(SEP);
    const by = Object.fromEntries(pnl.map((r) => [r.siteId, r]));
    const revenue = pnl.reduce((a, r) => a + r.revenue, 0);
    expect(by.s1.opex).toBeCloseTo((300 * by.s1.revenue) / revenue, 6);
    expect(by.s3.opex).toBeCloseTo(150 + (300 * by.s3.revenue) / revenue, 6);
    expect(pnl.reduce((a, r) => a + r.opex, 0)).toBeCloseTo(450, 6);
    expect(by.s1.margin).toBeCloseTo(by.s1.revenue - by.s1.cost - by.s1.opex, 6);
  });

  it("opex of an archived site is out of the KPIs; a site with opex but no data still has a P&L row", async () => {
    await saveOpex(db, { month: "2026-09", title: "Server s2", category: "HOSTING", amount: "90", siteId: "s2" });
    await db.site.create({ data: { id: "s9", domain: "nine.test", title: "Nine" } });
    await saveOpex(db, { month: "2026-09", title: "Server s9", category: "HOSTING", amount: "30", siteId: "s9" });
    expect((await financeKpis(SEP, "2026-09-22")).opex).toBe(120);
    const pnl = await pnlTable(SEP);
    expect(pnl.find((r) => r.domain === "nine.test")).toMatchObject({ revenue: 0, opex: 30, margin: -30 });
    expect(pnl.filter((r) => (r.marginShare ?? 0) > 0).reduce((a, r) => a + (r.marginShare ?? 0), 0)).toBeCloseTo(1, 6); // shares of the positive margins add up to 100%
    await db.site.update({ where: { id: "s2" }, data: { status: "ARCHIVED" } });
    expect((await financeKpis(SEP, "2026-09-22")).opex).toBe(30);
  });

  it("the month table carries AdSpyglass, deals, traffic cost, opex and margin per calendar month; entries list newest first", async () => {
    await saveOpex(db, { month: "2026-09", title: "Servers", category: "HOSTING", amount: "300", note: "Hetzner" });
    const months = await monthlyPnl(6, "2026-10-03");
    const sep = months.find((m) => m.month === "2026-09")!, oct = months.find((m) => m.month === "2026-10")!;
    expect(sep).toMatchObject({ asg: 122, deals: 6, revenue: 128, cost: 102, opex: 300, margin: 128 - 102 - 300, isCurrent: false });
    expect(oct).toMatchObject({ asg: 0, revenue: 0, opex: 0, isCurrent: true });
    // Today's partial hourly total (no cost yet) is not in the current month row; yesterday is.
    const netId = (await db.network.findUniqueOrThrow({ where: { slug: "adpulsar" } })).id;
    await db.factRevenueGeo.createMany({ data: [
      { date: new Date("2026-10-03T00:00:00Z"), siteId: "s1", networkId: netId, countryCode: "ZZ", device: "UNKNOWN", pageLoads: 10, revenueReported: "999" },
      { date: new Date("2026-10-02T00:00:00Z"), siteId: "s1", networkId: netId, countryCode: "ZZ", device: "UNKNOWN", pageLoads: 10, revenueReported: "7" },
    ] });
    expect((await monthlyPnl(6, "2026-10-03")).find((m) => m.month === "2026-10")).toMatchObject({ asg: 7 });
    expect(months.find((m) => m.month === "2026-05")).toBeUndefined(); // nothing before the data start
    const list = await opexEntries(6, "2026-10-03");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ month: "2026-09", title: "Servers", category: "HOSTING", amount: 300, siteId: null, domain: null, note: "Hetzner" });
    await saveOpex(db, { month: "2026-09", title: "Server", category: "SOFTWARE", amount: "99.5", siteId: "s1" }, list[0].id);
    expect((await opexEntries(6, "2026-10-03"))[0]).toMatchObject({ title: "Server", category: "SOFTWARE", amount: 99.5, domain: "one.test" });
    await deleteOpex(db, list[0].id);
    expect(await opexEntries(6, "2026-10-03")).toEqual([]);
  });

  it("validation", async () => {
    const base = { month: "2026-09", title: "X", category: "OTHER", amount: "10" };
    await expect(saveOpex(db, { ...base, month: "2026-13" })).rejects.toMatchObject({ field: "month" });
    await expect(saveOpex(db, { ...base, title: " " })).rejects.toMatchObject({ field: "title" });
    await expect(saveOpex(db, { ...base, category: "FOOD" })).rejects.toMatchObject({ field: "category" });
    await expect(saveOpex(db, { ...base, amount: "0" })).rejects.toMatchObject({ field: "amount" });
    await expect(saveOpex(db, { ...base, amount: "abc" })).rejects.toBeInstanceOf(RuleError);
    await expect(saveOpex(db, { ...base, siteId: "nope" })).rejects.toMatchObject({ field: "siteId" });
  });
});

describe("traffic source share", () => {
  it("changing a source's share recomputes its revshare cost right away", async () => {
    await db.costSource.update({ where: { slug: "tubecrown" }, data: { asgName: "TubeCrown" } });
    await db.factTrafficSource.create({ data: { date: D1, siteId: "s1", sourceSlug: "tubecrown", pageLoads: 1000, revenueReported: "40" } });
    const rows = await setSourceShare(db, "tubecrown", "50", 62, "2026-09-25");
    expect(rows).toBe(1);
    const c = await db.factCost.findFirstOrThrow({ where: { origin: "ASG" } });
    expect([c.cost.toString(), c.rate.toString(), c.countryCode]).toEqual(["20", "0.5", "ZZ"]);
    expect(await setSourceShare(db, "tubecrown", "0", 62, "2026-09-25")).toBe(0);
    expect(await db.factCost.count({ where: { origin: "ASG" } })).toBe(0);
    await expect(setSourceShare(db, "tubecrown", "150")).rejects.toMatchObject({ field: "revShare" });
  });
});
