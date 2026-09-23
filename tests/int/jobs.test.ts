import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { config } from "@/server/config";
import { runJob, windowFor } from "@/server/jobs/handlers";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { pauseAsg } from "@/server/ingest/run";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
const today = "2026-09-22";

beforeEach(async () => {
  await resetDb();
  await buildNetwork(db);
});

describe("job handlers", () => {
  it("windows", () => {
    const cfg = config({});
    expect(windowFor("asg:totals", { db, cfg, raw, today }, {})).toEqual({ from: "2026-09-21", to: "2026-09-22" });
    expect(windowFor("asg:sites", { db, cfg, raw, today }, {})).toEqual({ from: "2026-09-20", to: "2026-09-21" });
    expect(windowFor("derive", { db, cfg, raw, today }, {})).toEqual({ from: "2026-09-18", to: "2026-09-21" });
    expect(windowFor("metrika", { db, cfg, raw, today }, { from: "2026-09-01", to: "2026-09-02" })).toEqual({ from: "2026-09-01", to: "2026-09-02" });
  });

  it("skips unconfigured sources and a paused AdSpyglass without sending requests", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("[]"); }) as typeof fetch;
    expect((await runJob("asg:totals", { db, cfg: config({}), raw, today, fetchImpl })).status).toBe("skipped");
    expect((await runJob("metrika", { db, cfg: config({}), raw, today, fetchImpl })).skipped).toContain("METRIKA_TOKEN");
    await pauseAsg(db, 60, "тест");
    const cfg = config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t" });
    expect((await runJob("asg:totals", { db, cfg, raw, today, fetchImpl })).skipped).toContain("паузе");
    expect(calls).toBe(0);
  });

  it("asg:totals sends one request per day and respects the daily budget", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: URL | string) => { urls.push(String(u)); return new Response(JSON.stringify([{ name: "1. one.test", hits: 1, broker_income: 1 }])); }) as typeof fetch;
    const cfg = config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t", ASG_MIN_INTERVAL_MS: "0", ASG_DAILY_BUDGET: "1" });
    const r = await runJob("asg:totals", { db, cfg, raw, today, fetchImpl });
    expect(urls).toHaveLength(1);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("бюджет");
  });

  it("derive recalculates costs, forecasts deals and evaluates alerts", async () => {
    await db.costRate.create({ data: { sourceSlug: "tubecrown", rateModel: "CPU", rate: "0.012", validFrom: new Date("2026-01-01T00:00:00Z") } });
    const r = await runJob("derive", { db, cfg: config({}), raw, today }, {});
    expect(r.status).toBe("ok");
    const run = await db.ingestRun.findFirstOrThrow({ where: { source: "derive" } });
    expect(run.rowsUpsert).toBeGreaterThan(0);
    expect(await db.alert.count({ where: { rule: "loss_geo" } })).toBeGreaterThan(0);
  });
});
