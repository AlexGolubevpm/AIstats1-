import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { config } from "@/server/config";
import { runJob } from "@/server/jobs/handlers";
import { LocalRawStore } from "@/server/ingest/raw-store";
import { SLACK_SETTING, disconnectSlack, listSlackChannels, saveSlackSettings, saveSlackToken, sendSlackNow, slackTick, slackView } from "@/server/services/slack";
import { saveTelegramSettings, saveTelegramToken } from "@/server/services/telegram";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resetDb, testDb } from "./helpers";

const db = testDb();
const cfg = config({ APP_SECRET: "test-secret", APP_URL: "https://stat.test/" });
// Assembled at runtime so secret scanners do not mistake the fake for a real token.
const TOKEN = ["xoxb", "1111111111", "2222222222222", "a".repeat(24)].join("-");
const D = (s: string) => new Date(`${s}T00:00:00Z`);

/** A fake Slack Web API: records the calls, answers auth.test / conversations.list / chat.postMessage. */
function fakeSlack(over: Partial<Record<string, () => Response>> = {}) {
  const calls: { method: string; url: string; auth: string | null; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = (async (u: URL | string, init?: RequestInit) => {
    const url = String(u), method = url.split("/").pop()!.split("?")[0];
    calls.push({ method, url, auth: new Headers(init?.headers).get("authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (over[method]) return over[method]!();
    if (method === "auth.test") return Response.json({ ok: true, team: "Mavs", user: "tubestat" });
    if (method === "conversations.list") return Response.json(url.includes("cursor=") ? { ok: true, channels: [{ id: "C0AAAAAA3", name: "general" }] }
      : { ok: true, channels: [{ id: "C0AAAAAA1", name: "tube-stats", is_member: true }, { id: "G0AAAAAA2", name: "money", is_private: true, is_member: true }], response_metadata: { next_cursor: "abc" } });
    return Response.json({ ok: true, ts: "1.0" });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

beforeAll(async () => { const { RETRY_MS } = await import("@/server/services/telegram"); RETRY_MS.splice(0, RETRY_MS.length, 0, 0); });
beforeEach(async () => { await resetDb(); await buildNetwork(db); });

describe("slack", () => {
  it("the token is checked with auth.test and stored encrypted; channels come from conversations.list (all pages, the bot's first); settings validate; disconnect forgets it", async () => {
    const sl = fakeSlack();
    await expect(saveSlackToken(db, cfg, "xoxp-user-token", sl.fetchImpl)).rejects.toThrow(/xoxb/);
    expect(sl.calls).toHaveLength(0);
    expect(await saveSlackToken(db, cfg, ` ${TOKEN} `, sl.fetchImpl)).toBe("Mavs");
    expect(sl.calls[0]).toMatchObject({ method: "auth.test", url: "https://slack.com/api/auth.test", auth: `Bearer ${TOKEN}` });
    expect((await db.appSetting.findUniqueOrThrow({ where: { key: SLACK_SETTING } })).value).not.toContain(TOKEN.slice(5));
    expect(await slackView(db)).toEqual({ team: "Mavs", bot: "tubestat", channelId: null, channelName: null, enabled: true });
    expect(await listSlackChannels(db, cfg, sl.fetchImpl)).toEqual([
      { id: "G0AAAAAA2", name: "money", private: true, member: true }, { id: "C0AAAAAA1", name: "tube-stats", private: false, member: true },
      { id: "C0AAAAAA3", name: "general", private: false, member: false }]);
    expect(sl.calls.filter((c) => c.method === "conversations.list")).toHaveLength(2);
    await expect(saveSlackSettings(db, { channelId: "#general", enabled: true })).rejects.toThrow(/канал/);
    await saveSlackSettings(db, { channelId: "C0AAAAAA1", channelName: "tube-stats", enabled: true });
    expect(await slackView(db)).toMatchObject({ channelId: "C0AAAAAA1", channelName: "tube-stats" });
    const bad = fakeSlack({ "auth.test": () => Response.json({ ok: false, error: "invalid_auth" }) });
    const err = await saveSlackToken(db, cfg, TOKEN.replace("aaa", "zzz"), bad.fetchImpl).catch((e: Error) => e.message);
    expect(err).toBe("Slack: токен не подошёл — возьмите Bot User OAuth Token (xoxb-…) на странице OAuth & Permissions");
    await disconnectSlack(db);
    expect(await slackView(db)).toBeNull();
  });

  it("«send now» posts the week and the day in Slack mrkdwn to the channel; a bot outside the channel gets a clear error", async () => {
    const sl = fakeSlack();
    await saveSlackToken(db, cfg, TOKEN, sl.fetchImpl);
    await saveSlackSettings(db, { channelId: "C0AAAAAA1", channelName: "tube-stats", enabled: true });
    const now = new Date("2026-09-22T12:00:00Z");
    expect(await sendSlackNow(db, cfg, sl.fetchImpl, now, "week")).toBe("2026-09-20");
    expect(await sendSlackNow(db, cfg, sl.fetchImpl, now, "day")).toBe("2026-09-21");
    const posts = sl.calls.filter((c) => c.method === "chat.postMessage");
    expect(posts.map((c) => String(c.body!.text).split("\n")[0])).toEqual(["📅 *TubeStat · неделя 14–20 сентября*", "📊 *TubeStat · понедельник, 21 сентября*"]);
    expect(posts.every((c) => c.body!.channel === "C0AAAAAA1" && c.body!.unfurl_links === false && !/<\/?(b|i|pre)>/.test(String(c.body!.text)))).toBe(true);
    expect(String(posts[1].body!.text)).toContain("<https://stat.test/?preset=yesterday|Открыть сводку>");
    expect((await db.ingestRun.findMany({ where: { source: "slack" }, orderBy: { startedAt: "asc" } })).map((r) => [r.job, r.status])).toEqual([["digest:week", "ok"], ["digest", "ok"]]);
    const out = fakeSlack({ "chat.postMessage": () => Response.json({ ok: false, error: "not_in_channel" }) });
    await expect(sendSlackNow(db, cfg, out.fetchImpl, now)).rejects.toThrow("Slack: бота нет в канале — пригласите его: /invite @бот");
    expect(JSON.stringify(await db.ingestRun.findMany({ where: { source: "slack" } }))).not.toContain(TOKEN);
  });

  it("the digest job sends to Telegram and Slack; Slack follows the Telegram block's hour, has its own sent marks; off — skipped", async () => {
    const sl = fakeSlack();
    await saveSlackToken(db, cfg, TOKEN, sl.fetchImpl);
    await saveSlackSettings(db, { channelId: "C0AAAAAA1", channelName: "tube-stats", enabled: true });
    await db.ingestRun.create({ data: { source: "derive", job: "derive", dateFrom: D("2026-09-18"), dateTo: D("2026-09-21"), status: "ok", startedAt: new Date("2026-09-22T04:45:00Z") } });
    // No Telegram: the default hour (09:00 MSK = 06:00 UTC).
    expect((await slackTick(db, cfg, sl.fetchImpl, new Date("2026-09-22T05:30:00Z"))).skipped).toContain("в 9:00 МСК");
    // Telegram connected at 11:00 MSK: Slack waits for that hour too; one job run sends to both.
    const tg = (async (u: URL | string) => Response.json({ ok: true, result: String(u).endsWith("getMe") ? { username: "b" } : { message_id: 1 } })) as typeof fetch;
    await saveTelegramToken(db, cfg, "123456789:AAtesttokentesttokentesttokentest_x", tg);
    await saveTelegramSettings(db, { chatId: "4242", chatTitle: "x", hour: 11, minAmount: 30, enabled: true });
    expect((await slackTick(db, cfg, sl.fetchImpl, new Date("2026-09-22T07:00:00Z"))).skipped).toContain("в 11:00 МСК");
    const both = (async (u: URL | string, init?: RequestInit) => (String(u).includes("slack.com") ? sl.fetchImpl(u, init) : tg(u))) as typeof fetch;
    const raw = new LocalRawStore(mkdtempSync(path.join(tmpdir(), "raw-")));
    expect((await runJob("digest", { db, cfg, raw, fetchImpl: both, now: new Date("2026-09-22T08:00:00Z") })).status).toBe("ok");
    expect(sl.calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
    expect((await db.appSetting.findUniqueOrThrow({ where: { key: "slack_digest_sent" } })).value).toBe("2026-09-21");
    expect((await slackTick(db, cfg, sl.fetchImpl, new Date("2026-09-22T08:30:00Z"))).skipped).toContain("уже отправлена");
    await saveSlackSettings(db, { enabled: false });
    expect((await slackTick(db, cfg, sl.fetchImpl, new Date("2026-09-23T08:30:00Z"))).skipped).toContain("выключена");
  });
});
