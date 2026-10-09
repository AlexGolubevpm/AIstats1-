// The Metrika connection made from the UI (ADR 0018): app + code → encrypted tokens in AppSetting,
// the token reaches the jobs and the checks, counters are matched and written onto our sites.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "@/server/config";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { configuredSources, runJob } from "@/server/jobs/handlers";
import {
  METRIKA_SETTING, applyMetrikaCounters, connectMetrika, disconnectMetrika, ensureFreshToken, getMetrikaConnection, metrikaCounters, metrikaStatus, metrikaToken, saveMetrikaApp,
} from "@/server/services/metrika-connection";
import { seedReference } from "@/server/seed/reference";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
const cfg = config({ APP_SECRET: "test-key" });
const now = new Date("2026-10-09T10:00:00Z");

/** Yandex OAuth + Metrika in one fake: token exchange, counters, and an empty stat answer. */
function yandex(opts: { expiresIn?: number; counters?: unknown[] } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input)); calls.push(`${init?.method ?? "GET"} ${u.pathname}${u.pathname.endsWith("/token") ? ` ${init?.body}` : ""}`);
    // The first token may be short-lived (to test the renewal); a renewed one lives a year.
    const tokens = calls.filter((c) => c.includes("/token")).length;
    if (u.pathname === "/token") return Response.json({ access_token: `acc-${calls.length}`, refresh_token: "ref-1", expires_in: tokens === 1 ? opts.expiresIn ?? 365 * 86_400 : 365 * 86_400 });
    if (u.pathname === "/management/v1/counters") return Response.json({ counters: opts.counters ?? [] });
    if (u.pathname === "/stat/v1/data") return Response.json({ data: [] });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(async () => {
  await resetDb();
  await seedReference(db);
  await db.site.createMany({ data: [
    { id: "a", domain: "alpha.test", title: "Alpha", adsgSiteId: 1 },
    { id: "b", domain: "beta.test", title: "Beta", adsgSiteId: 2, metrikaId: "777" },
    { id: "c", domain: "gamma.test", title: "Gamma", adsgSiteId: 3 },
  ] });
});

describe("connecting", () => {
  it("app → code → tokens; nothing is stored in clear text; status, token and configured sources follow", async () => {
    expect(await metrikaStatus(db, cfg)).toEqual({ kind: "none" });
    expect(await metrikaToken(db, cfg)).toBeNull();
    expect(await configuredSources(db, cfg)).toEqual([]);
    await saveMetrikaApp(db, cfg, { clientId: "client-id-123", clientSecret: "s3cr3t" });
    expect(await metrikaStatus(db, cfg)).toEqual({ kind: "app", clientId: "client-id-123" });
    expect(await metrikaToken(db, cfg)).toBeNull(); // the app alone gives no token
    const y = yandex();
    const r = await connectMetrika(db, cfg, "1234567", y.fetchImpl, now);
    expect(r.expiresAt).toEqual(new Date("2027-10-09T10:00:00Z"));
    expect(y.calls[0]).toBe("POST /token grant_type=authorization_code&code=1234567");
    const stored = (await db.appSetting.findUniqueOrThrow({ where: { key: METRIKA_SETTING } })).value;
    expect(stored).not.toContain("s3cr3t"); expect(stored).not.toContain("acc-1"); expect(stored).not.toContain("ref-1");
    expect(stored).toContain("client-id-123"); // the id is public: it is in the authorize link
    const conn = await getMetrikaConnection(db, cfg);
    expect(conn).toMatchObject({ clientId: "client-id-123", clientSecret: "s3cr3t", accessToken: "acc-1", refreshToken: "ref-1" });
    expect(await metrikaToken(db, cfg)).toBe("acc-1");
    expect(await metrikaStatus(db, cfg)).toMatchObject({ kind: "oauth", clientId: "client-id-123" });
    expect(await configuredSources(db, cfg)).toEqual(["metrika"]);
    // A token from .env is the fallback, the UI connection wins when both exist.
    const envCfg = config({ APP_SECRET: "test-key", METRIKA_TOKEN: "env-tok" });
    expect(await metrikaToken(db, envCfg)).toBe("acc-1");
    await disconnectMetrika(db);
    expect(await metrikaToken(db, envCfg)).toBe("env-tok");
    expect(await metrikaStatus(db, envCfg)).toEqual({ kind: "env" });
  });

  it("validates the inputs; a changed APP_SECRET is reported, not crashed on, and .env still works", async () => {
    await expect(saveMetrikaApp(db, cfg, { clientId: "a b", clientSecret: "x" })).rejects.toThrow("ID приложения");
    await expect(saveMetrikaApp(db, cfg, { clientId: "client-id-123", clientSecret: "" })).rejects.toThrow("Секрет");
    await expect(saveMetrikaApp(db, config({}), { clientId: "client-id-123", clientSecret: "x" })).rejects.toThrow("APP_SECRET");
    await expect(connectMetrika(db, cfg, "1", yandex().fetchImpl)).rejects.toThrow("Сначала сохраните");
    await saveMetrikaApp(db, cfg, { clientId: "client-id-123", clientSecret: "s" });
    await expect(connectMetrika(db, cfg, "not a code", yandex().fetchImpl)).rejects.toThrow("Код подтверждения");
    await connectMetrika(db, cfg, "1234", yandex().fetchImpl, now);
    const other = config({ APP_SECRET: "another-key", METRIKA_TOKEN: "env-tok" });
    expect(await metrikaStatus(db, other)).toMatchObject({ kind: "broken" });
    expect(await metrikaToken(db, other)).toBe("env-tok");
    // Saving the same app again keeps the tokens; a different app drops them.
    await saveMetrikaApp(db, cfg, { clientId: "client-id-123", clientSecret: "s2" });
    expect((await getMetrikaConnection(db, cfg))!.accessToken).toBe("acc-1");
    await saveMetrikaApp(db, cfg, { clientId: "client-id-456", clientSecret: "s3" });
    expect((await getMetrikaConnection(db, cfg))!.accessToken).toBeNull();
  });

  it("the metrika job and the site check use the stored token; the token is renewed 30 days before it expires", async () => {
    await saveMetrikaApp(db, cfg, { clientId: "client-id-123", clientSecret: "s" });
    const y = yandex({ expiresIn: 20 * 86_400 }); // expires in 20 days → renewal due at once
    await connectMetrika(db, cfg, "1234", y.fetchImpl, now);
    expect(await ensureFreshToken(db, cfg, y.fetchImpl, now)).toBe(true);
    expect(y.calls[1]).toBe("POST /token grant_type=refresh_token&refresh_token=ref-1");
    expect(await metrikaToken(db, cfg)).toBe("acc-2");
    expect(await ensureFreshToken(db, cfg, y.fetchImpl, now)).toBe(false); // a year ahead now
    const run = await runJob("metrika", { db, cfg, raw, today: "2026-10-09", fetchImpl: y.fetchImpl }, { from: "2026-10-08", to: "2026-10-08" });
    expect(run.status).toBe("ok");
    expect(y.calls.filter((c) => c.includes("/stat/v1/data"))).toHaveLength(1); // only beta has a counter
    const { checkSite } = await import("@/server/ingest/probe");
    expect((await checkSite(db, cfg, "b", "2026-10-08", y.fetchImpl)).metrika).toEqual({ ok: true, value: { uniques: 0 } });
    expect((await checkSite(db, cfg, "a", "2026-10-08", y.fetchImpl)).metrika).toEqual({ ok: false, error: "Счётчик не задан" });
  });
});

describe("counters onto sites", () => {
  it("matched counters are written with an audit trail; conflicts, duplicates and strangers are left alone", async () => {
    await saveMetrikaApp(db, cfg, { clientId: "client-id-123", clientSecret: "s" });
    const y = yandex({ counters: [
      { id: 1, name: "Alpha", site: "www.alpha.test", status: "Active", mirrors: [] },
      { id: 2, name: "Beta", site: "beta.test", status: "Active", mirrors: [] }, // beta already has 777 → conflict
      { id: 3, name: "Gamma", site: "gamma.test", status: "Active", mirrors: [] },
      { id: 4, name: "Gamma 2", site: "other.test", status: "Active", mirrors: ["gamma.test"] }, // two for gamma → ambiguous
      { id: 5, name: "Stranger", site: "nobody.test", status: "Active", mirrors: [] },
    ] });
    await connectMetrika(db, cfg, "1234", y.fetchImpl, now);
    const rows = await metrikaCounters(db, cfg, y.fetchImpl);
    expect(rows.map((r) => [r.domain, r.decision])).toEqual([["alpha.test", "matched"], ["beta.test", "conflict"], ["gamma.test", "ambiguous"]]);
    const n = await applyMetrikaCounters(db, rows.filter((r) => r.decision === "matched").map((r) => ({ siteId: r.siteId, counterId: r.counterId! })));
    expect(n).toBe(1);
    expect((await db.site.findUniqueOrThrow({ where: { id: "a" } })).metrikaId).toBe("1");
    expect((await db.site.findUniqueOrThrow({ where: { id: "b" } })).metrikaId).toBe("777");
    expect((await db.site.findUniqueOrThrow({ where: { id: "c" } })).metrikaId).toBeNull();
    expect(await db.auditLog.findMany({ where: { entity: "Site", field: "metrikaId" } })).toMatchObject([{ entityId: "a", before: null, after: "1" }]);
    // Applying again changes nothing; a non-numeric counter is refused.
    expect(await applyMetrikaCounters(db, [{ siteId: "a", counterId: "1" }])).toBe(0);
    await expect(applyMetrikaCounters(db, [{ siteId: "a", counterId: "x" }])).rejects.toThrow("число");
    await expect(metrikaCounters(db, config({ APP_SECRET: "test-key" }), (async () => new Response("no", { status: 401 })) as typeof fetch)).rejects.toThrow("не пустила");
  });
});
