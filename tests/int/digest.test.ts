import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { buildDigest, digestPlain, digestProblems } from "@/lib/digest";
import { config } from "@/server/config";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { runJob, SCHEDULES } from "@/server/jobs/handlers";
import { digestData, digestReady } from "@/server/queries/digest";
import { DIGEST_SENT_KEY, TELEGRAM_SETTING, digestTick, disconnectTelegram, findTelegramChats, getTelegram, saveTelegramSettings, saveTelegramToken, sendDigestNow, telegramView } from "@/server/services/telegram";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const cfg = config({ APP_SECRET: "test-secret", APP_URL: "https://stat.test/" });
const TOKEN = "123456789:AAtesttokentesttokentesttokentest_x";
const D = (s: string) => new Date(`${s}T00:00:00Z`);
let net: Awaited<ReturnType<typeof buildNetwork>>;

/** A fake Bot API: records the calls, answers getMe / getUpdates / sendMessage. */
function fakeTelegram(over: Partial<Record<string, () => Response>> = {}) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (u: URL | string, init?: RequestInit) => {
    const url = String(u), method = url.split("/").pop()!;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (over[method]) return over[method]!();
    if (method === "getMe") return Response.json({ ok: true, result: { username: "tubestat_bot" } });
    if (method === "getUpdates") return Response.json({ ok: true, result: [
      { message: { chat: { id: 4242, type: "private", first_name: "Alex", last_name: "G" } } },
      { message: { chat: { id: 4242, type: "private", first_name: "Alex", last_name: "G" } } },
      { my_chat_member: { chat: { id: -100777, type: "supergroup", title: "TubeStat team" } } },
      { edited_message: {} },
    ] });
    return Response.json({ ok: true, result: { message_id: 1 } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(async () => {
  await resetDb();
  net = await buildNetwork(db);
});

describe("digest numbers", () => {
  it("yesterday against the days before: network over sites, AdSpyglass and direct deals apart, bundles overlap, cost by source", async () => {
    const d = await digestData(db, "2026-09-21");
    // 09-21: 3 sites × 2 countries × $10 mediated; the DIRECT deal adds $3 on s3. 09-20 is the only base day: $62 mediated (own_deals inside) + $3.
    expect(d.baseDays).toBe(1);
    expect(d.total).toEqual({ revenue: 63, mediated: 60, direct: 3, cost: 51, margin: 12 });
    expect(d.avg.revenue).toBe(65);
    expect(d.bundles.map((b) => [b.name, b.revenue, b.margin, b.avgRevenue]).sort()).toEqual([["Hentai", 43, 9, 43], ["JAV", 40, 6, 42]]);
    expect(d.bundlesOverlap).toBe(true); // s2 is in both: 40 + 43 > 63
    expect(d.sites.map((s) => [s.name, s.revenue, s.pageLoads]).sort()).toEqual([["one.test", 20, 20_000], ["three.test", 23, 20_000], ["two.test", 20, 20_000]]);
    expect(d.costs).toEqual([{ title: (await db.costSource.findUniqueOrThrow({ where: { slug: "tubecrown" } })).title, cost: 51 }]);
    expect(d.incomplete).toBe(true); // no derive run yet
    const text = digestPlain(buildDigest(d, { appUrl: cfg.appUrl }));
    expect(text).toContain("Выручка $63 (−3% к ср. 7 дн.) · расход $51 · маржа $12");
    expect(text).toContain("AdSpyglass $60 (95%) · фикс-дилы $3 (5%)");
    expect(text).toContain("пересекаются");
  });

  it("a site that stopped loading and a site that fell are problems; an archived site is not counted; alerts and the paused queue are listed", async () => {
    // 09-22: s1 sends nothing, s2 falls to $2, s3 keeps $20.
    await db.factRevenueGeo.createMany({ data: [
      { date: D("2026-09-22"), siteId: "s2", networkId: net.net.id, countryCode: "JP", device: "DESKTOP", pageLoads: 2_000, revenueReported: "2" },
      { date: D("2026-09-22"), siteId: "s3", networkId: net.net.id, countryCode: "JP", device: "DESKTOP", pageLoads: 20_000, revenueReported: "20" },
    ] });
    await db.alert.create({ data: { rule: "ingest_down", entityKey: "source:metrika", level: "CRITICAL", title: "Метрика: ингест упал", message: "m", link: "/settings/integrations", payload: {}, firstSeenAt: D("2026-09-10") } });
    await db.alert.create({ data: { rule: "discrepancy", entityKey: "n", level: "WARNING", title: "Дискрепанси AdPulsar", message: "m", link: "/", payload: {}, firstSeenAt: new Date("2026-09-23T04:50:00Z") } });
    for (const [k, title, risk] of [["a", "Убыточное гео JP на two.test", "7"], ["b", "Убыточное гео US на two.test", "3.5"]] as const)
      await db.alert.create({ data: { rule: "loss_geo", entityKey: k, level: "CRITICAL", title, message: "m", link: "/", payload: {}, moneyAtRisk: risk, firstSeenAt: k === "b" ? new Date("2026-09-23T04:50:00Z") : D("2026-09-10") } });
    await db.alert.create({ data: { rule: "low_fill", entityKey: "z", level: "WARNING", title: "Старый алерт", message: "m", link: "/", payload: {}, firstSeenAt: D("2026-09-01") } });
    await db.alert.create({ data: { rule: "low_fill", entityKey: "r", level: "CRITICAL", title: "Решённый", message: "m", link: "/", payload: {}, resolvedAt: new Date() } });
    const { pauseAsg } = await import("@/server/ingest/run");
    await pauseAsg(db, 60, "AdSpyglass ограничил частоту запросов (429)");
    const d = await digestData(db, "2026-09-22", new Date("2026-09-23T06:00:00Z"));
    expect(d.baseDays).toBe(2);
    const problems = digestProblems(d, 5).map((p) => p.text);
    expect(problems[0]).toMatch(/^AdSpyglass на паузе до \d\d:\d\d UTC: AdSpyglass ограничил/);
    expect(problems).toContain("one.test: нет загрузок (обычно 20 000 в день, $21)");
    expect(problems).toContain("Сеть: выручка −66% к ср. 7 дн. (−$42)");
    expect(problems).toContain("Метрика: ингест упал"); // a critical alert stays in the digest while it is active
    expect(problems).toContain("Дискрепанси AdPulsar · новый"); // a warning — only on the day it appeared
    expect(problems).toContain("Убыточное гео US на two.test и ещё 1 такой · новых 1 · под риском $11"); // one line per rule: the new one names it
    expect(problems).toContain("two.test: выручка −90% к ср. 7 дн. (−$18)");
    expect(problems.join("|")).not.toMatch(/Старый алерт|Решённый/); // an old warning is not news; a resolved alert is gone
    await db.site.update({ where: { id: "s1" }, data: { status: "ARCHIVED" } });
    expect(digestProblems(await digestData(db, "2026-09-22"), 5).map((p) => p.text).join("|")).not.toContain("one.test");
  });

  it("ready = the per-site cut for the day and a derive run after the day ended", async () => {
    expect(await digestReady(db, "2026-09-21")).toBe(false);
    await db.ingestRun.create({ data: { source: "derive", job: "derive", dateFrom: D("2026-09-18"), dateTo: D("2026-09-21"), status: "ok", startedAt: new Date("2026-09-21T04:45:00Z") } });
    expect(await digestReady(db, "2026-09-21")).toBe(false); // that run was before the day ended
    await db.ingestRun.create({ data: { source: "derive", job: "derive", dateFrom: D("2026-09-18"), dateTo: D("2026-09-21"), status: "ok", startedAt: new Date("2026-09-22T04:45:00Z") } });
    expect(await digestReady(db, "2026-09-21")).toBe(true);
  });
});

describe("telegram connection", () => {
  it("the token is checked with getMe and stored encrypted; chats come from getUpdates; settings validate; disconnect forgets everything", async () => {
    const tg = fakeTelegram();
    await expect(saveTelegramToken(db, cfg, "not a token", tg.fetchImpl)).rejects.toThrow(/BotFather/);
    expect(tg.calls).toHaveLength(0);
    await expect(saveTelegramToken(db, config({ APP_URL: "x" }), TOKEN, tg.fetchImpl)).rejects.toThrow(/APP_SECRET/);
    expect(await saveTelegramToken(db, cfg, ` ${TOKEN} `, tg.fetchImpl)).toBe("tubestat_bot");
    expect(tg.calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    const stored = (await db.appSetting.findUniqueOrThrow({ where: { key: TELEGRAM_SETTING } })).value;
    expect(stored).not.toContain(TOKEN.split(":")[1]);
    expect((await getTelegram(db, cfg))!.token).toBe(TOKEN);
    expect(await telegramView(db)).toEqual({ bot: "tubestat_bot", chatId: null, chatTitle: null, hour: 9, minAmount: 30, enabled: true });
    expect(JSON.stringify(await telegramView(db))).not.toContain("AAtest");
    expect(await findTelegramChats(db, cfg, tg.fetchImpl)).toEqual([{ id: "4242", title: "Alex G", type: "private" }, { id: "-100777", title: "TubeStat team", type: "supergroup" }]);
    await expect(saveTelegramSettings(db, { chatId: "abc", hour: 9, minAmount: 30, enabled: true })).rejects.toThrow(/чат/);
    await expect(saveTelegramSettings(db, { chatId: "4242", hour: 3, minAmount: 30, enabled: true })).rejects.toThrow(/время/);
    await saveTelegramSettings(db, { chatId: "-100777", chatTitle: "TubeStat team", hour: 10, minAmount: 50, enabled: true });
    await saveTelegramSettings(db, { hour: 11, minAmount: 50, enabled: false }); // no chat in the form: the chosen one stays
    expect(await telegramView(db)).toEqual({ bot: "tubestat_bot", chatId: "-100777", chatTitle: "TubeStat team", hour: 11, minAmount: 50, enabled: false });
    expect(await db.auditLog.count({ where: { entityId: TELEGRAM_SETTING } })).toBe(3);
    // The same bot again keeps the chat; a wrong token is refused with a clear text and without the token in it.
    await saveTelegramToken(db, cfg, TOKEN, tg.fetchImpl);
    expect((await telegramView(db))!.chatId).toBe("-100777");
    const bad = fakeTelegram({ getMe: () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }) });
    const err = await saveTelegramToken(db, cfg, TOKEN.replace("AA", "BB"), bad.fetchImpl).catch((e: Error) => e.message);
    expect(err).toContain("токен не подошёл");
    expect(err).not.toContain("BBtest");
    await disconnectTelegram(db);
    expect(await telegramView(db)).toBeNull();
  });

  it("a network failure names the cause and never the token; TELEGRAM_API_BASE redirects the calls", async () => {
    const down = (async () => { throw Object.assign(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`), { cause: { code: "ETIMEDOUT" } }); }) as unknown as typeof fetch;
    const err = await saveTelegramToken(db, cfg, TOKEN, down).catch((e: Error) => e.message);
    expect(err).toContain("Telegram недоступен с сервера (ETIMEDOUT)");
    expect(err).not.toContain(TOKEN);
    const tg = fakeTelegram();
    await saveTelegramToken(db, config({ APP_SECRET: "test-secret", TELEGRAM_API_BASE: "https://proxy.test/" }), TOKEN, tg.fetchImpl);
    expect(tg.calls[0].url).toBe(`https://proxy.test/bot${TOKEN}/getMe`);
  });
});

describe("digest job", () => {
  const connect = async (over: Partial<{ hour: number; enabled: boolean }> = {}) => {
    const tg = fakeTelegram();
    await saveTelegramToken(db, cfg, TOKEN, tg.fetchImpl);
    await saveTelegramSettings(db, { chatId: "4242", chatTitle: "Alex G", hour: over.hour ?? 9, minAmount: 30, enabled: over.enabled ?? true });
  };
  const derived = () => db.ingestRun.create({ data: { source: "derive", job: "derive", dateFrom: D("2026-09-18"), dateTo: D("2026-09-21"), status: "ok", startedAt: new Date("2026-09-22T04:45:00Z") } });
  const at = (hhmm: string) => new Date(`2026-09-22T${hhmm}:00Z`); // yesterday = 09-21; 09:00 MSK = 06:00 UTC

  it("is scheduled every half hour; not connected or switched off — a skip without requests", async () => {
    expect(SCHEDULES.find((s) => s.name === "digest")).toEqual({ name: "digest", pattern: "0,30 * * * *", queue: "main" });
    const tg = fakeTelegram();
    expect((await digestTick(db, cfg, tg.fetchImpl, at("06:00"))).skipped).toContain("не подключён");
    await connect({ enabled: false });
    expect((await digestTick(db, cfg, tg.fetchImpl, at("06:00"))).skipped).toContain("выключена");
    expect(tg.calls).toHaveLength(0);
  });

  it("waits for the hour, then for the data; sends once; the mark survives a restart", async () => {
    await connect();
    const tg = fakeTelegram();
    expect((await digestTick(db, cfg, tg.fetchImpl, at("05:30"))).skipped).toContain("в 9:00 МСК");
    expect((await digestTick(db, cfg, tg.fetchImpl, at("06:00"))).skipped).toContain("ждёт данные за 2026-09-21");
    await derived();
    const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
    const r = await runJob("digest", { db, cfg, raw, fetchImpl: tg.fetchImpl, now: at("06:30") }); // through the job, as the worker runs it
    expect(r.status).toBe("ok");
    expect(tg.calls.map((c) => c.method)).toEqual(["sendMessage"]);
    const body = tg.calls[0].body!;
    expect(body).toMatchObject({ chat_id: "4242", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    expect(String(body.text)).toContain("<b>TubeStat · пн 21.09</b>");
    expect(String(body.text)).toContain('<a href="https://stat.test/?preset=yesterday">');
    expect(String(body.text)).not.toContain("не полностью");
    expect((await db.appSetting.findUniqueOrThrow({ where: { key: DIGEST_SENT_KEY } })).value).toBe("2026-09-21");
    const run = await db.ingestRun.findFirstOrThrow({ where: { source: "telegram" } });
    expect([run.job, run.status, run.dateTo.toISOString().slice(0, 10)]).toEqual(["digest", "ok", "2026-09-21"]);
    expect((await digestTick(db, cfg, tg.fetchImpl, at("07:00"))).skipped).toContain("уже отправлена");
    expect(tg.calls).toHaveLength(1);
  });

  it("data still missing three hours later — goes out marked as incomplete", async () => {
    await connect();
    const tg = fakeTelegram();
    expect((await digestTick(db, cfg, tg.fetchImpl, at("08:30"))).skipped).toContain("ждёт данные");
    expect((await digestTick(db, cfg, tg.fetchImpl, at("09:00"))).status).toBe("ok");
    expect(String(tg.calls[0].body!.text)).toContain("⚠️ Данные за вчера загружены не полностью");
  });

  it("a Telegram refusal fails the run without the token in the log and without the sent mark — the next tick tries again; «send now» ignores the hour", async () => {
    await connect();
    await derived();
    const bad = fakeTelegram({ sendMessage: () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }) });
    const r = await digestTick(db, cfg, bad.fetchImpl, at("06:00"));
    expect(r.status).toBe("failed");
    const run = await db.ingestRun.findFirstOrThrow({ where: { source: "telegram" } });
    expect(run.error).toBe("Telegram: Bad Request: chat not found");
    expect(JSON.stringify(run)).not.toContain("AAtest");
    expect(await db.appSetting.findUnique({ where: { key: DIGEST_SENT_KEY } })).toBeNull();
    const tg = fakeTelegram();
    expect((await digestTick(db, cfg, tg.fetchImpl, at("06:30"))).status).toBe("ok");
    expect(await sendDigestNow(db, cfg, tg.fetchImpl, at("01:00"))).toBe("2026-09-21");
    expect(tg.calls).toHaveLength(2);
    await expect(sendDigestNow(db, cfg, bad.fetchImpl, at("01:00"))).rejects.toThrow(/chat not found/);
  });
});
