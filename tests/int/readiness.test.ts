import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { resetDb, testDb } from "./helpers";

// scripts/readiness.sql runs against production and prints into a public CI log.
const db = testDb();
const SQL = readFileSync("scripts/readiness.sql", "utf8").replace(/^--.*$/gm, "").trim().replace(/;$/, "");
const run = () => db.$queryRawUnsafe<{ c: string; v: string; verdict: string }[]>(SQL);
const yesterday = () => { const d = new Date(); d.setUTCDate(d.getUTCDate() - 1); return new Date(d.toISOString().slice(0, 10)); };

beforeAll(async () => {
  await resetDb();
  await buildNetwork(db);
});

describe("readiness.sql", () => {
  it("prints one verdict per checklist item and nothing identifying", async () => {
    const rows = await run();
    expect(rows).toHaveLength(11);
    expect(rows.every((r) => ["PASS", "FAIL", "INFO"].includes(r.verdict))).toBe(true);
    const text = JSON.stringify(rows);
    for (const leak of ["one.test", "two.test", "three.test", "$"]) expect(text).not.toContain(leak);
  });

  it("passes the ingest check only for a finished ok run covering yesterday", async () => {
    const byCheck = async () => new Map((await run()).map((r) => [r.c, r]));
    expect((await byCheck()).get("ingest adspyglass yesterday")).toMatchObject({ v: "none", verdict: "FAIL" });
    await db.ingestRun.create({ data: { source: "adspyglass", job: "asg:totals", dateFrom: yesterday(), dateTo: yesterday(), status: "ok" } });
    expect((await byCheck()).get("ingest adspyglass yesterday")).toMatchObject({ v: "none", verdict: "FAIL" }); // the hourly totals do not count as the nightly
    await db.ingestRun.create({ data: { source: "adspyglass", job: "asg:geo", dateFrom: yesterday(), dateTo: yesterday(), status: "ok" } });
    expect((await byCheck()).get("ingest adspyglass yesterday")).toMatchObject({ v: "ok", verdict: "PASS" });
    expect((await byCheck()).get("asg runs off ADOK site total >2%, 7d")).toMatchObject({ v: "0 of 2", verdict: "PASS" });
    await db.ingestRun.create({ data: { source: "adspyglass", job: "asg:geo", dateFrom: yesterday(), dateTo: yesterday(), status: "partial",
      error: "one.test 2026-09-27: сверка с итогом ADOK — выручка по странам расходится на 3.1%" } });
    const after = await byCheck();
    expect(after.get("ingest adspyglass yesterday")).toMatchObject({ v: "partial", verdict: "PASS" }); // data landed; check 5 reports the note
    expect(after.get("asg runs off ADOK site total >2%, 7d")).toMatchObject({ v: "1 of 3", verdict: "FAIL" });
  });

  it("network total equals the sum of sites; Metrika checks are INFO until a counter is configured", async () => {
    const by = new Map((await run()).map((r) => [r.c, r]));
    expect(by.get("network cut vs site totals, 7d (gap %) / sites in several bundles")).toMatchObject({ v: expect.stringMatching(/^(no data|0\.00%) \/ 1$/), verdict: "PASS" });
    expect(by.get("days with revenue but no traffic-source cut (cost missing), 7d")).toMatchObject({ verdict: expect.stringMatching(/PASS|FAIL/) });
    expect(by.get("ingest metrika yesterday")).toMatchObject({ v: "not configured", verdict: "INFO" });
    expect(by.get("active sites / with asg id / with metrika id")).toMatchObject({ v: "3 / 3 / 0", verdict: "INFO" });
    expect(by.get("asg sites with traffic-source cut (cost base) yesterday")).toMatchObject({ v: "0 of 3", verdict: "FAIL" });
  });

  it("flags accrual rows of a site that is no longer in the deal", async () => {
    const check = "fix-deal accrual rows outside the deal (site, dates, superseded, draft)";
    const byCheck = async () => new Map((await run()).map((r) => [r.c, r]));
    expect((await byCheck()).get(check)).toMatchObject({ v: "0", verdict: "PASS" });
    const direct = await db.deal.findFirstOrThrow({ where: { billedVia: "DIRECT" } });
    const other = await db.site.findFirstOrThrow({ where: { NOT: { dealSites: { some: { dealId: direct.id } } } } });
    await db.factFixDeal.create({ data: { date: new Date("2026-09-20T00:00:00Z"), dealId: direct.id, siteId: other.id, countryCode: "ZZ", revenue: "5", revenueState: "FORECAST" } });
    expect((await byCheck()).get(check)).toMatchObject({ v: "1", verdict: "FAIL" });
  });
});
