import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProxyAgent } from "undici";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { buildDigest, digestPlain, digestProblems } from "@/lib/digest";
import { config } from "@/server/config";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { runJob, SCHEDULES } from "@/server/jobs/handlers";
import { digestData, digestReady } from "@/server/queries/digest";
import { DIGEST_SENT_KEY, RETRY_MS, TELEGRAM_SETTING, chatsFromUpdates, checkTelegramLink, digestTick, disconnectTelegram, findTelegramChats, getTelegram, parseProxy,
  resolveTelegramChat, saveTelegramProxy, saveTelegramSettings, saveTelegramToken, sendDigestNow, telegramView } from "@/server/services/telegram";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const cfg = config({ APP_SECRET: "test-secret", APP_URL: "https://stat.test/" });
const TOKEN = "123456789:AAtesttokentesttokentesttokentest_x";
const D = (s: string) => new Date(`${s}T00:00:00Z`);
let net: Awaited<ReturnType<typeof buildNetwork>>;

/** A fake Bot API: records the calls, answers getMe / getUpdates / sendMessage. */
function fakeTelegram(over: Partial<Record<string, () => Response>> = {}) {
  const calls: { method: string; url: string; body: Record<string, unknown> | null; dispatcher?: unknown }[] = [];
  const fetchImpl = (async (u: URL | string, init?: RequestInit & { dispatcher?: unknown }) => {
    const url = String(u), method = url.split("/").pop()!;
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null, dispatcher: init?.dispatcher });
    if (over[method]) return over[method]!();
    if (method === "getMe") return Response.json({ ok: true, result: { username: "tubestat_bot" } });
    if (method === "getChat") return Response.json({ ok: true, result: { id: -100555, type: "supergroup", title: "Team <chat>" } });
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

beforeAll(() => { RETRY_MS.splice(0, RETRY_MS.length, 0, 0); }); // no real pauses between attempts in tests

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
    expect(text).toContain("💰 Выручка $63  ▼ 3% к ср. 7 дн.\n💸 Расход $51\n📈 Маржа $12");
    expect(text).toContain("AdSpyglass    $60 ▓▓▓▓▓▓▓▓▓▓  95%\nФикс-дилы      $3 ▓░░░░░░░░░   5%");
    expect(text).toContain("(сайт может быть в нескольких)");
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
    expect(problems).toContain("<b>one.test</b> не отдал ни одной загрузки. Обычно 20 000 загрузок и $21 в день — проверьте сайт и код ADOK.");
    expect(problems).toContain("<b>Выручка сети упала на 66%</b>: $22 вместо обычных $64 в день.");
    expect(problems).toContain("<b>two.test</b>: выручка $2 вместо обычных $20 (−90%, −$18).");
    // Alerts come as groups per rule, with the alerts themselves (new and costly first) and what to do.
    expect(d.alerts.map((g) => [g.level, g.rule, g.count, g.newCount, Math.round(g.moneyAtRisk * 10) / 10, g.items.map((i) => i.title)])).toEqual([
      ["CRITICAL", "loss_geo", 2, 1, 10.5, ["Убыточное гео US на two.test", "Убыточное гео JP на two.test"]],
      ["CRITICAL", "ingest_down", 1, 0, 0, ["Метрика: ингест упал"]],
      ["WARNING", "discrepancy", 1, 1, 0, ["Дискрепанси AdPulsar"]],
      ["WARNING", "low_fill", 1, 0, 0, ["Старый алерт"]],
    ]);
    const text = digestPlain(buildDigest(d, { minAmount: 5 }));
    expect(text).toContain("Метрика: ингест упал"); // a critical alert stays in the digest while it is active
    expect(text).toContain("Дискрепанси — наши показы и показы сетки расходятся\n▪️ AdPulsar"); // a warning — on the day it appeared, under the rule in words
    expect(text).not.toMatch(/Старый алерт|Решённый/); // an old warning is not news; a resolved alert is gone
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
    expect(await telegramView(db, cfg)).toEqual({ bot: "tubestat_bot", chatId: null, chatTitle: null, hour: 9, minAmount: 30, enabled: true, proxy: null });
    expect(JSON.stringify(await telegramView(db, cfg))).not.toContain("AAtest");
    expect(await findTelegramChats(db, cfg, tg.fetchImpl)).toEqual([{ id: "-100777", title: "TubeStat team", type: "supergroup" }, { id: "4242", title: "Alex G", type: "private" }]); // groups first
    await expect(saveTelegramSettings(db, { chatId: "abc", hour: 9, minAmount: 30, enabled: true })).rejects.toThrow(/чат/);
    await expect(saveTelegramSettings(db, { chatId: "4242", hour: 3, minAmount: 30, enabled: true })).rejects.toThrow(/время/);
    await saveTelegramSettings(db, { chatId: "-100777", chatTitle: "TubeStat team", hour: 10, minAmount: 50, enabled: true });
    await saveTelegramSettings(db, { hour: 11, minAmount: 50, enabled: false }); // no chat in the form: the chosen one stays
    expect(await telegramView(db, cfg)).toEqual({ bot: "tubestat_bot", chatId: "-100777", chatTitle: "TubeStat team", hour: 11, minAmount: 50, enabled: false, proxy: null });
    expect(await db.auditLog.count({ where: { entityId: TELEGRAM_SETTING } })).toBe(3);
    // The same bot again keeps the chat; a wrong token is refused with a clear text and without the token in it.
    await saveTelegramToken(db, cfg, TOKEN, tg.fetchImpl);
    expect((await telegramView(db, cfg))!.chatId).toBe("-100777");
    const bad = fakeTelegram({ getMe: () => Response.json({ ok: false, description: "Unauthorized" }, { status: 401 }) });
    const err = await saveTelegramToken(db, cfg, TOKEN.replace("AA", "BB"), bad.fetchImpl).catch((e: Error) => e.message);
    expect(err).toContain("токен не подошёл");
    expect(err).not.toContain("BBtest");
    await disconnectTelegram(db);
    expect(await telegramView(db, cfg)).toBeNull();
  });

  it("a network failure is retried (IPv4 first, then dual-stack); three failures name the cause and never the token; TELEGRAM_API_BASE redirects the calls", async () => {
    let n = 0;
    const dispatchers: unknown[] = [];
    const down = (async (_u: string, init?: { dispatcher?: unknown }) => {
      n++; dispatchers.push(init?.dispatcher);
      throw Object.assign(new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/getMe`), { cause: { code: "ETIMEDOUT" } });
    }) as unknown as typeof fetch;
    const err = await saveTelegramToken(db, cfg, TOKEN, down).catch((e: Error) => e.message);
    expect(n).toBe(3);
    expect(dispatchers[0]).toBeDefined();
    expect(dispatchers[1]).not.toBe(dispatchers[0]); // the second attempt lets the system pick IPv4 or IPv6
    expect(err).toBe("Сервер не достучался до Telegram (ETIMEDOUT, 3 попытки). Нажмите «Проверить связь» или задайте прокси ниже");
    expect(err).not.toContain(TOKEN);
    // One blip recovers on the next attempt.
    let k = 0;
    const tg = fakeTelegram();
    const flaky = (async (u: string, init?: RequestInit) => { if (k++ === 0) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }); return tg.fetchImpl(u, init); }) as unknown as typeof fetch;
    expect(await saveTelegramToken(db, cfg, TOKEN, flaky)).toBe("tubestat_bot");
    const tg2 = fakeTelegram();
    await saveTelegramToken(db, config({ APP_SECRET: "test-secret", TELEGRAM_API_BASE: "https://proxy.test/" }), TOKEN, tg2.fetchImpl);
    expect(tg2.calls[0].url).toBe(`https://proxy.test/bot${TOKEN}/getMe`);
  });
});

describe("telegram reachability", () => {
  it("proxy addresses: a worker mirror (https, no path) or an HTTP proxy with a port; anything else is refused", () => {
    expect(parseProxy(" https://tg-proxy.alex.workers.dev/ ")).toEqual({ kind: "mirror", base: "https://tg-proxy.alex.workers.dev" });
    expect(parseProxy("http://u:p@1.2.3.4:8080")).toEqual({ kind: "proxy", url: "http://u:p@1.2.3.4:8080" });
    for (const bad of ["tg-proxy.workers.dev", "https://x.dev/bot", "https://u:p@x.dev", "http://1.2.3.4", "socks5://1.2.3.4:1080"]) expect(() => parseProxy(bad)).toThrow(/workers\.dev|host:port/);
  });

  it("a worker: checked with getMe through it, stored encrypted, every call goes to it; an HTTP proxy rides as the dispatcher; empty — back to direct", async () => {
    const tg = fakeTelegram();
    await saveTelegramToken(db, cfg, TOKEN, tg.fetchImpl);
    await expect(saveTelegramProxy(db, cfg, "nonsense", tg.fetchImpl)).rejects.toThrow(/workers\.dev/);
    const dead = (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); }) as unknown as typeof fetch;
    await expect(saveTelegramProxy(db, cfg, "https://w.example", dead)).rejects.toThrow("Сервер не достучался до Telegram через воркер w.example (ENOTFOUND, 3 попытки). Нажмите «Проверить связь»");
    expect((await telegramView(db, cfg))!.proxy).toBeNull(); // a proxy that does not answer is not saved
    tg.calls.length = 0;
    expect(await saveTelegramProxy(db, cfg, "https://w.example/", tg.fetchImpl)).toBe("воркер w.example");
    expect(tg.calls[0].url).toBe(`https://w.example/bot${TOKEN}/getMe`);
    expect((await db.appSetting.findUniqueOrThrow({ where: { key: TELEGRAM_SETTING } })).value).not.toContain("w.example");
    expect((await telegramView(db, cfg))!.proxy).toBe("воркер w.example");
    await findTelegramChats(db, cfg, tg.fetchImpl);
    expect(tg.calls.at(-1)!.url).toBe(`https://w.example/bot${TOKEN}/getUpdates`);
    await saveTelegramToken(db, cfg, TOKEN, tg.fetchImpl); // a new token keeps the proxy
    expect(tg.calls.at(-1)!.url).toContain("https://w.example/");

    await saveTelegramProxy(db, cfg, "http://user:secret@1.2.3.4:8080", tg.fetchImpl);
    expect(tg.calls.at(-1)!.url).toBe(`https://api.telegram.org/bot${TOKEN}/getMe`);
    expect(tg.calls.at(-1)!.dispatcher).toBeInstanceOf(ProxyAgent);
    const v = await telegramView(db, cfg);
    expect(v!.proxy).toBe("HTTP-прокси 1.2.3.4:8080");
    expect(JSON.stringify(v)).not.toContain("secret");
    expect(await saveTelegramProxy(db, cfg, "", tg.fetchImpl)).toBeNull();
    expect((await telegramView(db, cfg))!.proxy).toBeNull();
    expect(await db.auditLog.count({ where: { entityId: TELEGRAM_SETTING, field: "proxy" } })).toBe(3);
  });

  it("groups: a group turned supergroup takes its new id, a group the bot left goes away, groups first; a chat typed by hand is checked with getChat", async () => {
    const chat = (id: number, type: string, title?: string) => ({ id, type, ...(title ? { title } : { first_name: "Owner" }) });
    expect(chatsFromUpdates([
      { message: { chat: chat(1, "private") } },
      { my_chat_member: { chat: chat(-5, "group", "Old group"), new_chat_member: { status: "member" } } },
      { message: { chat: chat(-5, "group", "Old group"), migrate_to_chat_id: -1005 } },
      { my_chat_member: { chat: chat(-7, "group", "Left"), new_chat_member: { status: "member" } } },
      { my_chat_member: { chat: chat(-7, "group", "Left"), new_chat_member: { status: "kicked" } } },
      { channel_post: { chat: chat(-1009, "channel", "Канал") } },
    ])).toEqual([{ id: "-1005", title: "Old group", type: "supergroup" }, { id: "-1009", title: "Канал", type: "channel" }, { id: "1", title: "Owner", type: "private" }]);

    const tg = fakeTelegram();
    await saveTelegramToken(db, cfg, TOKEN, tg.fetchImpl);
    await expect(resolveTelegramChat(db, cfg, "not a chat", tg.fetchImpl)).rejects.toThrow(/Chat id/);
    expect(await resolveTelegramChat(db, cfg, "-100555", tg.fetchImpl)).toEqual({ id: "-100555", title: "Team <chat>", type: "supergroup" });
    expect(tg.calls.at(-1)!.body).toEqual({ chat_id: "-100555" });
    const missing = fakeTelegram({ getChat: () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }) });
    await expect(resolveTelegramChat(db, cfg, "@nogroup", missing.fetchImpl)).rejects.toThrow("Чат не найден: добавьте бота в этот чат и повторите");
  });

  it("«Проверить связь»: DNS A / AAAA, TCP :443 to each address, getMe directly and through the proxy", async () => {
    const tg = fakeTelegram();
    let t = 0;
    const deps = {
      now: () => (t += 10),
      resolve4: async () => ["149.154.167.220"],
      resolve6: async () => { throw Object.assign(new Error("queryAaaa ENODATA"), { code: "ENODATA" }); },
      tcp: async (ip: string) => { if (ip !== "149.154.167.220") throw Object.assign(new Error("t"), { code: "ETIMEDOUT" }); },
    };
    const before = await checkTelegramLink(db, cfg, tg.fetchImpl, deps);
    expect(before.map((r) => [r.step, r.ok, r.detail])).toEqual([["DNS A (IPv4)", true, "149.154.167.220"], ["DNS AAAA (IPv6)", false, "ENODATA"], ["TCP :443 (IPv4)", true, "ok"]]);
    await saveTelegramToken(db, cfg, TOKEN, tg.fetchImpl);
    await saveTelegramProxy(db, cfg, "https://w.example", tg.fetchImpl);
    const blocked = (async (u: string, init?: RequestInit) => {
      if (String(u).startsWith("https://api.telegram.org")) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
      return tg.fetchImpl(u, init);
    }) as unknown as typeof fetch;
    const rows = await checkTelegramLink(db, cfg, blocked, { ...deps, tcp: async () => { throw Object.assign(new Error("t"), { code: "ETIMEDOUT" }); } });
    expect(rows.slice(2).map((r) => [r.step, r.target, r.ok])).toEqual([
      ["TCP :443 (IPv4)", "149.154.167.220", false], ["HTTPS getMe напрямую", "api.telegram.org", false], ["HTTPS getMe через прокси", "воркер w.example", true]]);
    expect(rows[3].detail).toContain("ETIMEDOUT");
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
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
    expect(String(body.text)).toContain("<b>TubeStat · понедельник, 21 сентября</b>");
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
    expect(String(tg.calls[0].body!.text)).toContain("⚠️ <i>Данные за вчера загружены не полностью");
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
