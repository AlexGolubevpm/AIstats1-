import { beforeEach, describe, expect, it } from "vitest";
import { config } from "@/server/config";
import { checkSite, withAsg } from "@/server/ingest/probe";
import { asgPause, asgRequestsToday } from "@/server/ingest/run";
import { clearData, isDemo } from "@/server/seed/demo";
import { loadDemo } from "@/server/seed/load-demo";
import { seedReference } from "@/server/seed/reference";
import { resetDb, testDb } from "./helpers";

const db = testDb();
beforeEach(async () => { await resetDb(); });

describe("demo data", () => {
  it("loads a consistent network, derives costs, deal periods and alerts; clears cleanly", async () => {
    const r = await loadDemo(db, { today: "2026-09-28", days: 40 });
    expect(r.sites).toBe(12);
    expect(await isDemo(db)).toBe(true);
    const [t] = await db.$queryRaw<{ rev: number; cost: number }[]>`SELECT SUM(revenue)::float8 rev, SUM(cost)::float8 cost FROM v_site_geo_daily`;
    expect(t.rev).toBeGreaterThan(t.cost); // profitable network overall
    expect(await db.dealPeriod.count()).toBeGreaterThan(0);
    expect(await db.dealPeriod.count({ where: { status: "PAID" } })).toBe(1);
    expect(await db.alert.count({ where: { rule: "loss_geo" } })).toBeGreaterThan(0);
    await clearData(db);
    expect([await db.site.count(), await isDemo(db)]).toEqual([0, false]);
  });
});

describe("interactive AdSpyglass checks", () => {
  const cfg = config({ ASG_AUTH_EMAIL: "e", ASG_AUTH_TOKEN: "t", ASG_MIN_INTERVAL_MS: "0", METRIKA_TOKEN: "m" });

  it("refuses without credentials and while paused; counts the budget", async () => {
    await seedReference(db);
    expect(await withAsg(db, config({}), async () => 1)).toEqual({ ok: false, error: expect.stringContaining("не заданы") });
    const ok = await withAsg(db, cfg, (c) => c.report({ from: "2026-09-27", to: "2026-09-27", groupBy: "date" }),
      (async () => new Response(JSON.stringify([{ name: "2026-09-27", hits: 1 }]))) as typeof fetch);
    expect(ok).toMatchObject({ ok: true });
    expect(await asgRequestsToday(db)).toBe(1);
    const bad = await withAsg(db, cfg, (c) => c.report({ from: "a", to: "a", groupBy: "date" }),
      (async () => new Response(null, { status: 302, headers: { location: "https://x/users/sign_in" } })) as typeof fetch);
    expect(bad.ok).toBe(false);
    expect(await asgPause(db)).toBeTruthy(); // auth failure pauses the queue
    expect((await withAsg(db, cfg, async () => 1)).ok).toBe(false);
  });

  it("checkSite reports both sources in one request each, scoped with platforms_ids[]", async () => {
    await seedReference(db);
    const s = await db.site.create({ data: { domain: "a.test", title: "A", adsgSiteId: 5, metrikaId: "77" } });
    const urls: string[] = [];
    const fetchImpl = (async (u: URL | string) => {
      urls.push(String(u));
      if (String(u).includes("adok") || String(u).includes("/report")) return new Response(JSON.stringify([{ name: "2026-09-27", hits: 1234, broker_income: 2 }]));
      return new Response(JSON.stringify({ data: [{ dimensions: [{ name: "2026-09-27" }, { name: "Japan", iso_name: "JP" }, { name: "Desktop", id: "desktop" }], metrics: [321, 400, 900, 0.3, 2.2] }] }));
    }) as typeof fetch;
    const r = await checkSite(db, cfg, s.id, "2026-09-27", fetchImpl);
    expect(r.asg).toEqual({ ok: true, value: { pageLoads: 1234, revenue: 2 } });
    expect(r.metrika).toEqual({ ok: true, value: { uniques: 321 } });
    expect(urls[0]).toContain("platforms_ids%5B%5D=5");
    const none = await db.site.create({ data: { domain: "b.test", title: "B", metrikaId: "1" } });
    expect((await checkSite(db, config({}), none.id, "2026-09-27")).asg).toMatchObject({ ok: false });
  });
});
