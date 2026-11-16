// The Telegram bot of the morning digest (ADR 0022). The owner creates the bot in @BotFather and
// pastes its token on /settings/integrations; it is stored in AppSetting `telegram` encrypted with
// APP_SECRET, like the Metrika secrets. The bot only sends: no webhook, no incoming commands.
import type { PrismaClient } from "@/generated/prisma/client";
import { buildDigest, DIGEST_DEFAULTS } from "@/lib/digest";
import { addDays } from "@/lib/period";
import type { Config } from "@/server/config";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { RuleError } from "@/server/domain/errors";
import { withIngestRun } from "@/server/ingest/run";
import { digestData, digestReady } from "@/server/queries/digest";

export const TELEGRAM_SETTING = "telegram";
export const DIGEST_SENT_KEY = "telegram_digest_sent";
/** Moscow time: the owner's clock. Fixed UTC+3 (no DST since 2014). */
export const MSK_OFFSET_H = 3;
/** Send hours offered (MSK). The nightly load ends about 08:00 MSK, the UTC day about 03:00. */
export const DIGEST_HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18] as const;
/** How long the digest waits for yesterday's data past the chosen hour before it goes out with a warning. */
export const WAIT_FOR_DATA_H = 3;

interface Stored { token: string; bot?: string; chatId?: string; chatTitle?: string; hour?: number; minAmount?: number; enabled?: boolean }
export interface TelegramConnection { token: string; bot: string | null; chatId: string | null; chatTitle: string | null; hour: number; minAmount: number; enabled: boolean }
export type TelegramView = Omit<TelegramConnection, "token">;

async function readStored(db: PrismaClient): Promise<Stored | null> {
  const row = await db.appSetting.findUnique({ where: { key: TELEGRAM_SETTING } });
  if (!row) return null;
  try { return JSON.parse(row.value) as Stored; } catch { return null; }
}
const write = (db: PrismaClient, s: Stored) => db.appSetting.upsert({ where: { key: TELEGRAM_SETTING }, create: { key: TELEGRAM_SETTING, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } });

const view = (s: Stored): TelegramView => ({ bot: s.bot ?? null, chatId: s.chatId ?? null, chatTitle: s.chatTitle ?? null,
  hour: DIGEST_HOURS.includes(s.hour as 9) ? s.hour! : 9, minAmount: s.minAmount ?? DIGEST_DEFAULTS.minAmount, enabled: s.enabled !== false });

/** What the page shows: everything but the token. */
export async function telegramView(db: PrismaClient): Promise<TelegramView | null> {
  const s = await readStored(db);
  return s ? view(s) : null;
}

/** The connection with the token decrypted; null when nothing was saved. A changed APP_SECRET surfaces as a RuleError. */
export async function getTelegram(db: PrismaClient, cfg: Config): Promise<TelegramConnection | null> {
  const s = await readStored(db);
  return s ? { ...view(s), token: decryptSecret(s.token, cfg.appSecret) } : null;
}

type Tg<T> = { ok: boolean; result?: T; description?: string };
/** One Bot API call. The token is part of the URL, so it is scrubbed from every error text. */
async function call<T>(cfg: Config, token: string, method: string, body: Record<string, unknown> | null, fetchImpl: typeof fetch): Promise<T> {
  const scrub = (s: string) => s.split(token).join("<token>");
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.telegram.apiBase}/bot${token}/${method}`, {
      method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new RuleError("telegram", scrub(`Telegram недоступен с сервера (${cause?.code ?? cause?.message ?? (e as Error).message}). Если хостинг режет api.telegram.org — задайте TELEGRAM_API_BASE в .env`));
  }
  const json = (await res.json().catch(() => null)) as Tg<T> | null;
  if (!res.ok || !json?.ok) {
    const why = res.status === 401 || res.status === 404 ? "токен не подошёл — проверьте его в @BotFather" : json?.description ?? `HTTP ${res.status}`;
    throw new RuleError("telegram", scrub(`Telegram: ${why}`));
  }
  return json.result as T;
}

/** Step 1: the bot token. Checked with getMe; a different bot forgets the chat of the old one. */
export async function saveTelegramToken(db: PrismaClient, cfg: Config, raw: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = raw.trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new RuleError("token", "Токен бота выглядит как 123456789:AA… — скопируйте его целиком из @BotFather", "token");
  const enc = encryptSecret(token, cfg.appSecret); // before the request: without APP_SECRET nothing can be stored anyway
  const me = await call<{ username?: string }>(cfg, token, "getMe", null, fetchImpl);
  const prev = await readStored(db);
  const bot = me.username ?? "bot";
  await write(db, { ...(prev && prev.bot === bot ? prev : {}), token: enc, bot });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: TELEGRAM_SETTING, field: "bot", before: prev?.bot ?? null, after: bot } });
  return bot;
}

export interface TelegramChat { id: string; title: string; type: string }
/** Chats the bot has heard from (someone pressed Start or it was added to a group): the owner picks one, no chat id by hand. */
export async function findTelegramChats(db: PrismaClient, cfg: Config, fetchImpl: typeof fetch = fetch): Promise<TelegramChat[]> {
  const conn = await getTelegram(db, cfg);
  if (!conn) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  type Chat = { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
  type Update = { message?: { chat: Chat }; channel_post?: { chat: Chat }; my_chat_member?: { chat: Chat } };
  const updates = await call<Update[]>(cfg, conn.token, "getUpdates", { limit: 100, timeout: 0, allowed_updates: ["message", "channel_post", "my_chat_member"] }, fetchImpl);
  const chats = new Map<string, TelegramChat>();
  for (const u of updates) {
    const c = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat;
    if (!c) continue;
    const title = c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || c.username || String(c.id));
    chats.set(String(c.id), { id: String(c.id), title, type: c.type });
  }
  return [...chats.values()];
}

/** Step 2: where to send, when (hour MSK), what counts as noise, on/off. */
export async function saveTelegramSettings(db: PrismaClient, i: { chatId?: string | null; chatTitle?: string | null; hour: number; minAmount: number; enabled: boolean }): Promise<void> {
  const prev = await readStored(db);
  if (!prev) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  if (i.chatId && !/^-?\d{1,20}$/.test(i.chatId)) throw new RuleError("chatId", "Выберите чат из списка", "chatId");
  if (!DIGEST_HOURS.includes(i.hour as 9)) throw new RuleError("hour", "Выберите время отправки", "hour");
  if (!Number.isFinite(i.minAmount) || i.minAmount < 0 || i.minAmount > 100_000) throw new RuleError("minAmount", "Порог — сумма в долларах от 0", "minAmount");
  const chatId = i.chatId || prev.chatId, chatTitle = i.chatId ? i.chatTitle || i.chatId : prev.chatTitle;
  await write(db, { ...prev, chatId, chatTitle, hour: i.hour, minAmount: Math.round(i.minAmount), enabled: i.enabled });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: TELEGRAM_SETTING, field: "settings",
    before: prev.chatId ? `${prev.chatTitle ?? prev.chatId} · ${prev.hour ?? 9}:00 · ${prev.enabled === false ? "выкл" : "вкл"}` : null,
    after: `${chatTitle ?? chatId ?? "чат не выбран"} · ${i.hour}:00 · ${i.enabled ? "вкл" : "выкл"}` } });
}

/** Forgets the bot. */
export async function disconnectTelegram(db: PrismaClient): Promise<void> {
  await db.appSetting.deleteMany({ where: { key: { in: [TELEGRAM_SETTING, DIGEST_SENT_KEY] } } });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: TELEGRAM_SETTING, field: "bot", after: null } });
}

/** The digest text for a day, as it would be sent now. */
export async function digestText(db: PrismaClient, cfg: Config, day: string, minAmount: number = DIGEST_DEFAULTS.minAmount, now = new Date()): Promise<string> {
  return buildDigest(await digestData(db, day, now), { appUrl: cfg.appUrl || undefined, minAmount });
}

/** Sends the digest for `day` to the chosen chat. */
export async function sendDigest(db: PrismaClient, cfg: Config, day: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<void> {
  const conn = await getTelegram(db, cfg);
  if (!conn) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  if (!conn.chatId) throw new RuleError("chatId", "Выберите чат: напишите боту и нажмите «Найти чат»", "chatId");
  const text = await digestText(db, cfg, day, conn.minAmount, now);
  await call(cfg, conn.token, "sendMessage", { chat_id: conn.chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }, fetchImpl);
}

const yesterdayOf = (now: Date) => addDays(now.toISOString().slice(0, 10), -1);

/**
 * The half-hourly tick: once a day, when the chosen hour (MSK) has come and yesterday is loaded
 * (the per-site cut and derive). Data still missing WAIT_FOR_DATA_H hours later — the digest goes
 * out anyway, marked as incomplete. The sent mark survives restarts and deploys.
 */
export async function digestTick(db: PrismaClient, cfg: Config, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ status: string; skipped?: string; error?: string }> {
  let conn: TelegramConnection | null;
  try { conn = await getTelegram(db, cfg); } catch (e) { return { status: "skipped", skipped: `Telegram: ${(e as Error).message}` }; }
  if (!conn || !conn.chatId) return { status: "skipped", skipped: "Telegram не подключён (Настройки → Интеграции)" };
  if (!conn.enabled) return { status: "skipped", skipped: "сводка в Telegram выключена" };
  const day = yesterdayOf(now);
  const sent = await db.appSetting.findUnique({ where: { key: DIGEST_SENT_KEY } });
  if (sent?.value === day) return { status: "skipped", skipped: `сводка за ${day} уже отправлена` };
  const due = new Date(`${addDays(day, 1)}T00:00:00Z`).getTime() + (conn.hour - MSK_OFFSET_H) * 3_600_000;
  if (now.getTime() < due) return { status: "skipped", skipped: `сводка за ${day} — в ${conn.hour}:00 МСК` };
  if (now.getTime() < due + WAIT_FOR_DATA_H * 3_600_000 && !(await digestReady(db, day))) return { status: "skipped", skipped: `сводка ждёт данные за ${day}` };
  return withIngestRun(db, { source: "telegram", job: "digest", from: day, to: day }, async () => {
    await sendDigest(db, cfg, day, fetchImpl, now);
    await db.appSetting.upsert({ where: { key: DIGEST_SENT_KEY }, create: { key: DIGEST_SENT_KEY, value: day }, update: { value: day } });
    return { rows: 1 };
  });
}

/** «Отправить сейчас»: yesterday's digest at once, whatever the hour; logged like the scheduled one. */
export async function sendDigestNow(db: PrismaClient, cfg: Config, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<string> {
  const day = yesterdayOf(now);
  const r = await withIngestRun(db, { source: "telegram", job: "digest", from: day, to: day }, async () => { await sendDigest(db, cfg, day, fetchImpl, now); return { rows: 1 }; });
  if (r.status === "failed") throw new RuleError("telegram", r.error ?? "Не удалось отправить");
  return day;
}
