// The Slack bot of the digest (ADR 0022): the same daily digest, week and month reports as Telegram, in
// Slack mrkdwn. The owner's IT creates the app from the manifest (docs/product/05-settings.md) and pastes
// the bot token on /settings/integrations; it is stored in AppSetting `slack` encrypted with APP_SECRET.
// The bot only posts (chat.postMessage): no events, no commands. Schedule and thresholds are the digest's,
// set in the Telegram block (defaults without it).
import type { PrismaClient } from "@/generated/prisma/client";
import { DIGEST_DEFAULTS, digestToSlack, type DigestKind } from "@/lib/digest";
import { addDays } from "@/lib/period";
import type { Config } from "@/server/config";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { RuleError } from "@/server/domain/errors";
import { withIngestRun } from "@/server/ingest/run";
import { digestReady } from "@/server/queries/digest";
import {
  JOB, MSK_OFFSET_H, WAIT_FOR_DATA_H, defaultFetch, digestText, dow, dual, ipv4, lastComplete, netCause, startOf, telegramView, yesterdayOf, type TgFetch,
} from "@/server/services/telegram";

export const SLACK_SETTING = "slack";
const SENT_KEY: Record<DigestKind, string> = { day: "slack_digest_sent", week: "slack_weekly_sent", month: "slack_monthly_sent" };

interface Stored { token: string; team?: string; bot?: string; channelId?: string; channelName?: string; enabled?: boolean }
export interface SlackView { team: string | null; bot: string | null; channelId: string | null; channelName: string | null; enabled: boolean }

async function readStored(db: PrismaClient): Promise<Stored | null> {
  const row = await db.appSetting.findUnique({ where: { key: SLACK_SETTING } });
  if (!row) return null;
  try { return JSON.parse(row.value) as Stored; } catch { return null; }
}
const write = (db: PrismaClient, s: Stored) => db.appSetting.upsert({ where: { key: SLACK_SETTING }, create: { key: SLACK_SETTING, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } });
const view = (s: Stored): SlackView => ({ team: s.team ?? null, bot: s.bot ?? null, channelId: s.channelId ?? null, channelName: s.channelName ?? null, enabled: s.enabled !== false });

/** What the page shows: everything but the token. */
export async function slackView(db: PrismaClient): Promise<SlackView | null> {
  const s = await readStored(db);
  return s ? view(s) : null;
}
async function token(db: PrismaClient, cfg: Config): Promise<{ s: Stored; token: string } | null> {
  const s = await readStored(db);
  return s ? { s, token: decryptSecret(s.token, cfg.appSecret) } : null;
}

const RETRY_MS = [2_000, 5_000];
/** Words for the Web API errors the owner can act on. */
const SLACK_ERROR: Record<string, string> = {
  invalid_auth: "токен не подошёл — возьмите Bot User OAuth Token (xoxb-…) на странице OAuth & Permissions",
  not_authed: "токен не подошёл", token_revoked: "токен отозван — переустановите приложение и вставьте новый", account_inactive: "приложение отключено в воркспейсе",
  not_in_channel: "бота нет в канале — пригласите его: /invite @бот", channel_not_found: "канал не найден — пригласите бота в приватный канал и выберите его снова",
  is_archived: "канал в архиве", missing_scope: "у приложения нет нужного права — создайте его из манифеста (chat:write, chat:write.public, channels:read, groups:read)",
  ratelimited: "Slack просит подождать (лимит запросов)",
};

/** One Web API call (Bearer token, IPv4 first, two retries on a network error). The token never gets into an error text. */
async function call<T>(cfg: Config, tok: string, method: string, body: Record<string, unknown> | null, query: Record<string, string> = {}, fetchImpl: TgFetch = defaultFetch,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  const scrub = (s: string) => s.split(tok).join("<token>");
  const qs = new URLSearchParams(query).toString();
  let res: Response | null = null, last = "";
  for (let attempt = 0; attempt <= RETRY_MS.length && !res; attempt++) {
    if (attempt) await sleep(RETRY_MS[attempt - 1]);
    try {
      res = await fetchImpl(`${cfg.slack.apiBase}/${method}${qs ? `?${qs}` : ""}`, {
        method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${tok}`, ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(30_000), dispatcher: attempt === 1 ? dual : ipv4,
      });
    } catch (e) { last = netCause(e); }
  }
  if (!res) throw new RuleError("slack", scrub(`Сервер не достучался до Slack (${last}, 3 попытки)`));
  const json = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string } & T) | null;
  if (!res.ok || !json?.ok) {
    const code = json?.error ?? `HTTP ${res.status}`;
    throw new RuleError("slack", scrub(`Slack: ${SLACK_ERROR[code] ?? code}`));
  }
  return json as T;
}

/** Step 1: the bot token. Checked with auth.test; a token of another workspace forgets the channel of the old one. */
export async function saveSlackToken(db: PrismaClient, cfg: Config, raw: string, fetchImpl: TgFetch = defaultFetch): Promise<string> {
  const tok = raw.trim();
  if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(tok)) throw new RuleError("token", "Нужен Bot User OAuth Token вида xoxb-… со страницы OAuth & Permissions", "token");
  const enc = encryptSecret(tok, cfg.appSecret);
  const me = await call<{ team?: string; user?: string }>(cfg, tok, "auth.test", {}, {}, fetchImpl);
  const prev = await readStored(db);
  const team = me.team ?? "Slack";
  await write(db, { ...(prev && prev.team === team ? prev : {}), token: enc, team, bot: me.user ?? "bot" });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: SLACK_SETTING, field: "workspace", before: prev?.team ?? null, after: team } });
  return team;
}

export interface SlackChannel { id: string; name: string; private: boolean; member: boolean }
/** Channels to pick from: public ones and the private ones the bot was invited to. */
export async function listSlackChannels(db: PrismaClient, cfg: Config, fetchImpl: TgFetch = defaultFetch): Promise<SlackChannel[]> {
  const t = await token(db, cfg);
  if (!t) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  type Ch = { id: string; name: string; is_private?: boolean; is_member?: boolean };
  const out: SlackChannel[] = [];
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const r = await call<{ channels: Ch[]; response_metadata?: { next_cursor?: string } }>(cfg, t.token, "conversations.list", null,
      { types: "public_channel,private_channel", exclude_archived: "true", limit: "200", ...(cursor ? { cursor } : {}) }, fetchImpl);
    out.push(...r.channels.map((c) => ({ id: c.id, name: c.name, private: Boolean(c.is_private), member: Boolean(c.is_member) })));
    cursor = r.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return out.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
}

/** Step 2: the channel and on/off. */
export async function saveSlackSettings(db: PrismaClient, i: { channelId?: string | null; channelName?: string | null; enabled: boolean }): Promise<void> {
  const prev = await readStored(db);
  if (!prev) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  if (i.channelId && !/^[CG][A-Z0-9]{6,}$/.test(i.channelId)) throw new RuleError("channel", "Выберите канал из списка", "channel");
  const channelId = i.channelId || prev.channelId, channelName = i.channelId ? i.channelName || i.channelId : prev.channelName;
  await write(db, { ...prev, channelId, channelName, enabled: i.enabled });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: SLACK_SETTING, field: "settings",
    before: prev.channelId ? `#${prev.channelName ?? prev.channelId} · ${prev.enabled === false ? "выкл" : "вкл"}` : null,
    after: `${channelId ? `#${channelName ?? channelId}` : "канал не выбран"} · ${i.enabled ? "вкл" : "выкл"}` } });
}

export async function disconnectSlack(db: PrismaClient): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: { in: [SLACK_SETTING, ...Object.values(SENT_KEY)] } } });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: SLACK_SETTING, field: "workspace", after: null } });
}

/** The digest's schedule and thresholds: set in the Telegram block; defaults when Telegram is not connected. */
async function digestSettings(db: PrismaClient, cfg: Config) {
  const tg = await telegramView(db, cfg).catch(() => null);
  return { hour: tg?.hour ?? 9, minAmount: tg?.minAmount ?? DIGEST_DEFAULTS.minAmount, problemMin: tg?.problemMin ?? DIGEST_DEFAULTS.problemMin,
    weekly: tg?.weekly ?? true, monthly: tg?.monthly ?? true };
}

/** Posts a report ending on `day` to the chosen channel: the same messages as Telegram, in Slack mrkdwn. */
export async function sendSlackDigest(db: PrismaClient, cfg: Config, day: string, fetchImpl: TgFetch = defaultFetch, now = new Date(), kind: DigestKind = "day"): Promise<void> {
  const t = await token(db, cfg);
  if (!t) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  if (!t.s.channelId) throw new RuleError("channel", "Выберите канал: «Найти каналы»", "channel");
  const set = await digestSettings(db, cfg);
  for (const text of await digestText(db, cfg, day, set.minAmount, now, set.problemMin, kind)) {
    await call(cfg, t.token, "chat.postMessage", { channel: t.s.channelId, text: digestToSlack(text), unfurl_links: false, unfurl_media: false }, {}, fetchImpl);
  }
}

/** The half-hourly tick for Slack: the same rules as Telegram (hour, data ready, Mondays, the 1st), its own sent marks and runs. */
export async function slackTick(db: PrismaClient, cfg: Config, fetchImpl: TgFetch = defaultFetch, now = new Date()): Promise<{ status: string; skipped?: string; error?: string }> {
  let t: Awaited<ReturnType<typeof token>>;
  try { t = await token(db, cfg); } catch (e) { return { status: "skipped", skipped: `Slack: ${(e as Error).message}` }; }
  if (!t || !t.s.channelId) return { status: "skipped", skipped: "Slack не подключён" };
  if (t.s.enabled === false) return { status: "skipped", skipped: "сводка в Slack выключена" };
  const set = await digestSettings(db, cfg);
  const day = yesterdayOf(now);
  const wanted: DigestKind[] = ["day", ...(set.weekly && dow(day) === 0 ? ["week" as const] : []), ...(set.monthly && day.slice(0, 7) !== now.toISOString().slice(0, 7) ? ["month" as const] : [])];
  const marks = await db.appSetting.findMany({ where: { key: { in: wanted.map((k) => SENT_KEY[k]) } } });
  const todo = wanted.filter((k) => marks.find((m) => m.key === SENT_KEY[k])?.value !== lastComplete(k, now));
  if (!todo.length) return { status: "skipped", skipped: `Slack: сводка за ${day} уже отправлена` };
  const due = new Date(`${addDays(day, 1)}T00:00:00Z`).getTime() + (set.hour - MSK_OFFSET_H) * 3_600_000;
  if (now.getTime() < due) return { status: "skipped", skipped: `Slack: сводка за ${day} — в ${set.hour}:00 МСК` };
  if (now.getTime() < due + WAIT_FOR_DATA_H * 3_600_000 && !(await digestReady(db, day))) return { status: "skipped", skipped: `Slack: сводка ждёт данные за ${day}` };
  let result: { status: string; error?: string } = { status: "ok" };
  for (const kind of todo) {
    const end = lastComplete(kind, now);
    const r = await withIngestRun(db, { source: "slack", job: JOB[kind], from: startOf(kind, end), to: end }, async () => {
      await sendSlackDigest(db, cfg, end, fetchImpl, now, kind);
      await db.appSetting.upsert({ where: { key: SENT_KEY[kind] }, create: { key: SENT_KEY[kind], value: end }, update: { value: end } });
      return { rows: 1 };
    });
    if (r.status === "failed" && result.status !== "failed") result = r;
  }
  return result;
}

/** «Отправить сейчас» to Slack: the last complete day, week or month at once; logged like the scheduled one. */
export async function sendSlackNow(db: PrismaClient, cfg: Config, fetchImpl: TgFetch = defaultFetch, now = new Date(), kind: DigestKind = "day"): Promise<string> {
  const end = lastComplete(kind, now);
  const r = await withIngestRun(db, { source: "slack", job: JOB[kind], from: startOf(kind, end), to: end }, async () => { await sendSlackDigest(db, cfg, end, fetchImpl, now, kind); return { rows: 1 }; });
  if (r.status === "failed") throw new RuleError("slack", r.error ?? "Не удалось отправить");
  return end;
}
