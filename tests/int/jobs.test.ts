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

  it("a week-long skip of the per-site cuts shows as partial, never as ok", async () => {
    const { FILTER_IGNORED_KEY } = await import("@/server/ingest/adspyglass/ingest");
    await db.appSetting.create({ data: { key: FILTER_IGNORED_KEY, value: "AdSpyglass игнорирует website_id (test)" } });
    const fetchImpl = (async (u: URL | string) => new Response(JSON.stringify(new URL(String(u)).searchParams.get("group_by") === "spot" ? [] : []))) as typeof fetch;
    const cfg = config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t", ASG_MIN_INTERVAL_MS: "0" });
    const r = await runJob("asg:sites", { db, cfg, raw, today, fetchImpl }, {});
    expect(r.status).toBe("partial");
    const run = await db.ingestRun.findFirstOrThrow({ where: { job: "asg:sites" }, orderBy: { startedAt: "desc" } });
    expect(run.error).toContain("пропущено");
  });

  it("geo:reprocess rewrites XX rows from raw after mapping, without API calls", async () => {
    const date = "2026-09-20";
    const s1 = await db.site.findUniqueOrThrow({ where: { id: "s1" } });
    const runId = "rp1";
    await raw.put(`raw/adspyglass/country/${s1.adsgSiteId}/${date}/${runId}.json`, [{ name: "Atlantis", hits: 10, impressions: 5, broker_income: 4 }]);
    await db.countryAlias.create({ data: { source: "adspyglass", raw: "Atlantis", countryCode: "GR" } });
    let calls = 0;
    const fetchImpl = (async () => { calls++; return new Response("[]"); }) as typeof fetch;
    const r = await runJob("geo:reprocess", { db, cfg: config({}), raw, today, fetchImpl });
    expect(r.status).toBe("ok");
    const gr = await db.factRevenueGeo.findMany({ where: { siteId: "s1", date: new Date(`${date}T00:00:00Z`), countryCode: "GR" } });
    expect(gr.map((x) => Number(x.revenueReported))).toEqual([4]);
    expect(calls).toBe(0);
  });
});

describe("asg:backfill", () => {
  // Factory sites s1..s3 have adsgSiteId 1..3; one day = 2 + 4 × 3 = 14 requests.
  const fakeApi = (() => {
    const fetchImpl = (async (u: URL | string) => {
      const url = new URL(String(u)), g = url.searchParams.get("group_by"), site = url.searchParams.get("platforms_ids[]");
      if (g === "website") return new Response(JSON.stringify([1, 2, 3].map((i) => ({ name: `${i}. ${["one", "two", "three"][i - 1]}.test`, hits: 1000, broker_income: 10, predicted_income: 10 }))));
      if (g === "country") return new Response(JSON.stringify([{ name: "Japan", iso: "JP", hits: 1000, broker_income: 10, predicted_income: 10 }]));
      if (g === "adnetwork_squashed") return new Response(JSON.stringify([{ name: "AdPulsar", hits: 1000, broker_income: 10 }]));
      if (g === "device") return new Response(JSON.stringify([{ name: "Desktop", hits: 1000, impressions: 500, broker_income: 10, predicted_income: 10 }]));
      if (g === "traffic_source") return new Response(JSON.stringify([{ name: "TubeCrown", hits: 1000, broker_income: 4 }, { name: "Direct", hits: 0, broker_income: 6 }]));
      if (g === "spot") return new Response(JSON.stringify([{ name: `49${site ?? "1"}. Footer (one.test)`, hits: 100, broker_income: 1 }]));
      return new Response("[]");
    }) as typeof fetch;
    return fetchImpl;
  })();
  const cfg = (budget: number) => config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t", ASG_MIN_INTERVAL_MS: "0", ASG_DAILY_BUDGET: String(budget), ASG_BACKFILL_RESERVE: "10" });

  it("ingests the newest pending days that fit the budget minus the reserve, stops, continues next day and finishes with derive", async () => {
    const ctx = { db, cfg: cfg(10 + 14 * 2 + 1), raw, today, fetchImpl: fakeApi };
    expect((await runJob("asg:backfill", ctx, {})).skipped).toContain("нечего"); // no window set: the half-hourly tick is a no-op
    const r1 = await runJob("asg:backfill", ctx, { from: "2026-09-01", to: "2026-09-03" });
    expect(r1.status).toBe("partial"); // stopped on the budget with one day left
    const { readBackfill } = await import("@/server/jobs/backfill");
    let s = (await readBackfill(db))!;
    expect(s.done).toEqual(["2026-09-03", "2026-09-02"]);
    expect(s.pending).toEqual(["2026-09-01"]);
    expect(s.lastStop).toContain("бюджет");
    expect((await runJob("asg:backfill", ctx, {})).status).toBe("partial"); // same day: nothing fits, stops at once without requests
    expect((await db.ingestRun.findFirstOrThrow({ where: { job: "asg:backfill" }, orderBy: { startedAt: "desc" } })).requests).toBe(0);
    const run = await db.ingestRun.findFirstOrThrow({ where: { job: "asg:backfill" }, orderBy: { startedAt: "asc" } });
    expect([run.dateFrom.toISOString().slice(0, 10), run.dateTo.toISOString().slice(0, 10), run.requests]).toEqual(["2026-09-02", "2026-09-03", 28]);
    expect(await db.factRevenueGeo.count({ where: { date: new Date("2026-09-03T00:00:00Z"), countryCode: "JP" } })).toBe(3);
    expect(await db.factCost.count({ where: { date: new Date("2026-09-03T00:00:00Z"), origin: "ASG" } })).toBe(3); // TubeCrown cost per site
    // Next UTC day: the budget counter is fresh, the last day lands and derive runs over the window.
    await db.appSetting.deleteMany({ where: { key: { startsWith: "asg_requests:" } } });
    const r2 = await runJob("asg:backfill", ctx, {}); // the scheduled tick picks the stored window up
    expect(r2.status).toBe("ok");
    s = (await readBackfill(db))!;
    expect([s.pending, s.done.length]).toEqual([[], 3]);
    expect(await db.ingestRun.count({ where: { source: "derive" } })).toBe(1);
    expect((await runJob("asg:backfill", ctx, {})).skipped).toContain("нечего");
  });

  it("planCatchUp queues the days of the month without a country cut, newest first, and yields to a running backfill", async () => {
    const { planCatchUp, readBackfill, startBackfill, cancelBackfill } = await import("@/server/jobs/backfill");
    // Factory data: JP/US rows on 09-20 and 09-21. Totals-only day 09-22 has just ZZ.
    const s1 = await db.site.findFirstOrThrow();
    const net = await db.network.findFirstOrThrow({ where: { slug: { not: "own_deals" } } });
    await db.factRevenueGeo.create({ data: { date: new Date("2026-09-22T00:00:00Z"), siteId: s1.id, networkId: net.id, countryCode: "ZZ", device: "DESKTOP", pageLoads: 1, revenueReported: "1" } });
    expect(await planCatchUp(db, "2026-09-23")).toEqual([...Array.from({ length: 19 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`), "2026-09-22"]);
    const s = (await readBackfill(db))!;
    expect([s.from, s.to, s.mode, s.pending[0], s.pending.at(-1)]).toEqual(["2026-09-01", "2026-09-22", "full", "2026-09-22", "2026-09-01"]);
    expect(await planCatchUp(db, "2026-09-23")).toEqual([]); // already pending: no second plan
    await cancelBackfill(db);
    await startBackfill(db, { from: "2026-09-10", to: "2026-09-12" });
    expect(await planCatchUp(db, "2026-09-23")).toEqual([]); // a backfill set by hand is left alone
    await cancelBackfill(db);
    expect(await planCatchUp(db, "2026-09-01")).toEqual([]); // the 1st: nothing before today
  });

  it("a cancelled backfill does nothing; a new window keeps the days already done", async () => {
    const { startBackfill, cancelBackfill, readBackfill } = await import("@/server/jobs/backfill");
    await startBackfill(db, { from: "2026-09-01", to: "2026-09-02" });
    await cancelBackfill(db);
    expect((await readBackfill(db))!.pending).toEqual([]);
    const s = await startBackfill(db, { from: "2026-09-01", to: "2026-09-04" });
    expect(s.pending).toEqual(["2026-09-04", "2026-09-03", "2026-09-02", "2026-09-01"]);
    const widened = await startBackfill(db, { from: "2026-08-30", to: "2026-09-04" });
    expect(widened.pending).toHaveLength(6);
    expect(widened.startedAt).toBe(s.startedAt);
  });
});

describe("asg:backfill — только итоги", () => {
  it("one website request per day writes ZZ site totals, leaves days with a country cut alone, and ends with derive", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (u: URL | string) => {
      urls.push(String(u));
      return new Response(JSON.stringify([1, 2, 3].map((i) => ({ name: `${i}. ${["one", "two", "three"][i - 1]}.test`, hits: 500, broker_income: 7 }))));
    }) as typeof fetch;
    const cfg = config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t", ASG_MIN_INTERVAL_MS: "0", ASG_DAILY_BUDGET: "100", ASG_BACKFILL_RESERVE: "10" });
    const ctx = { db, cfg, raw, today, fetchImpl };
    // 2026-09-20 already has JP/US rows from the factory; 09-18 and 09-19 are empty.
    const r = await runJob("asg:backfill", ctx, { from: "2026-09-18", to: "2026-09-20", mode: "totals" });
    expect(r.status).toBe("ok");
    expect(urls).toHaveLength(3);
    expect(urls.every((u) => new URL(u).searchParams.get("group_by") === "website" && !new URL(u).searchParams.has("platforms_ids[]"))).toBe(true);
    const zz = await db.factRevenueGeo.findMany({ where: { countryCode: "ZZ" }, orderBy: [{ date: "asc" }, { siteId: "asc" }] });
    expect(zz.map((x) => [x.date.toISOString().slice(0, 10), Number(x.revenueReported)])).toEqual([
      ["2026-09-18", 7], ["2026-09-18", 7], ["2026-09-18", 7], ["2026-09-19", 7], ["2026-09-19", 7], ["2026-09-19", 7]]);
    expect(await db.factRevenueGeo.count({ where: { date: new Date("2026-09-20T00:00:00Z"), countryCode: "JP" } })).toBe(4); // untouched: 3 sites + the own-deals row on s1
    const { readBackfill } = await import("@/server/jobs/backfill");
    expect((await readBackfill(db))!).toMatchObject({ mode: "totals", pending: [], done: ["2026-09-20", "2026-09-19", "2026-09-18"] });
    expect(await db.ingestRun.count({ where: { source: "derive" } })).toBe(1);
  });
});
