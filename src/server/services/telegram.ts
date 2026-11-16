// The Telegram bot of the morning digest (ADR 0022). The owner creates the bot in @BotFather and
// pastes its token on /settings/integrations; it is stored in AppSetting `telegram` encrypted with
// APP_SECRET, like the Metrika secrets. The bot only sends: no webhook, no incoming commands.
import { promises as dnsp } from "node:dns";
import { connect as tcpConnect } from "node:net";
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";
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

interface Stored { token: string; bot?: string; chatId?: string; chatTitle?: string; hour?: number; minAmount?: number; enabled?: boolean; proxy?: string }
export interface TelegramConnection { token: string; bot: string | null; chatId: string | null; chatTitle: string | null; hour: number; minAmount: number; enabled: boolean; proxy: string | null }
/** What the page shows: no token, the proxy only as its kind and host (it may carry a password). */
export type TelegramView = Omit<TelegramConnection, "token" | "proxy"> & { proxy: string | null };

async function readStored(db: PrismaClient): Promise<Stored | null> {
  const row = await db.appSetting.findUnique({ where: { key: TELEGRAM_SETTING } });
  if (!row) return null;
  try { return JSON.parse(row.value) as Stored; } catch { return null; }
}
const write = (db: PrismaClient, s: Stored) => db.appSetting.upsert({ where: { key: TELEGRAM_SETTING }, create: { key: TELEGRAM_SETTING, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } });

const base = (s: Stored) => ({ bot: s.bot ?? null, chatId: s.chatId ?? null, chatTitle: s.chatTitle ?? null,
  hour: DIGEST_HOURS.includes(s.hour as 9) ? s.hour! : 9, minAmount: s.minAmount ?? DIGEST_DEFAULTS.minAmount, enabled: s.enabled !== false });

/** What the page shows: everything but the token. */
export async function telegramView(db: PrismaClient, cfg: Config): Promise<TelegramView | null> {
  const s = await readStored(db);
  if (!s) return null;
  let proxy: string | null = null;
  try { proxy = s.proxy ? proxyLabel(parseProxy(decryptSecret(s.proxy, cfg.appSecret))) : null; } catch { proxy = "не читается — задайте заново"; }
  return { ...base(s), proxy };
}

/** The connection with the token decrypted; null when nothing was saved. A changed APP_SECRET surfaces as a RuleError. */
export async function getTelegram(db: PrismaClient, cfg: Config): Promise<TelegramConnection | null> {
  const s = await readStored(db);
  return s ? { ...base(s), token: decryptSecret(s.token, cfg.appSecret), proxy: s.proxy ? decryptSecret(s.proxy, cfg.appSecret) : null } : null;
}

type Tg<T> = { ok: boolean; result?: T; description?: string };

/**
 * How the requests reach Telegram (ADR 0022). A Russian hosting may cut api.telegram.org or have no IPv6 route:
 * - `https://…` — a Bot API mirror, e.g. a Cloudflare Worker forwarding to api.telegram.org (path /bot<token>/<method>);
 * - `http://[user:pass@]host:port` — an HTTP proxy (CONNECT), via undici's ProxyAgent.
 */
export type Route = { kind: "mirror"; base: string } | { kind: "proxy"; url: string };
export function parseProxy(raw: string): Route {
  const v = raw.trim();
  let u: URL;
  try { u = new URL(v); } catch { throw new RuleError("proxy", "Адрес вида https://….workers.dev или http://user:pass@host:port", "proxy"); }
  if (u.protocol === "https:" && !u.username && !u.password && (u.pathname === "/" || u.pathname === "")) return { kind: "mirror", base: `https://${u.host}` };
  if (u.protocol === "http:" && u.port) return { kind: "proxy", url: u.toString().replace(/\/$/, "") };
  throw new RuleError("proxy", "Адрес вида https://….workers.dev (воркер, без пути) или http://user:pass@host:port (HTTP-прокси с портом)", "proxy");
}
export const proxyLabel = (r: Route) => (r.kind === "mirror" ? `воркер ${new URL(r.base).host}` : `HTTP-прокси ${new URL(r.url).host}`);

export const TIMEOUT_MS = 30_000;
/** Pauses before the 2nd and the 3rd attempt on a network error. */
export const RETRY_MS = [2_000, 5_000];
/** IPv4 first: a VPS with an AAAA record and no IPv6 route hangs on every IPv6 attempt. */
const ipv4 = new Agent({ connect: { family: 4, timeout: 15_000 } });
const dual = new Agent({ connect: { autoSelectFamily: true, timeout: 15_000 } });
const proxies = new Map<string, ProxyAgent>();
const proxyAgent = (url: string) => { let a = proxies.get(url); if (!a) proxies.set(url, (a = new ProxyAgent({ uri: url, connect: { timeout: 15_000 } }))); return a; };

export type TgFetch = (url: string, init: RequestInit & { dispatcher?: Dispatcher }) => Promise<Response>;
const defaultFetch: TgFetch = (url, init) => undiciFetch(url, init as never) as unknown as Promise<Response>;
const netCause = (e: unknown) => { const c = (e as { cause?: { code?: string; message?: string } }).cause; return c?.code ?? c?.message ?? (e as Error).message; };

/** One Bot API call: via the saved proxy, else directly (IPv4 first); network errors are retried twice. The token is scrubbed from every error text. */
async function call<T>(cfg: Config, token: string, method: string, body: Record<string, unknown> | null, fetchImpl: TgFetch = defaultFetch,
  proxy: string | null = null, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<T> {
  const scrub = (s: string) => s.split(token).join("<token>");
  const route = proxy ? parseProxy(proxy) : null;
  const apiBase = route?.kind === "mirror" ? route.base : cfg.telegram.apiBase;
  let res: Response | null = null, last = "";
  for (let attempt = 0; attempt <= RETRY_MS.length && !res; attempt++) {
    if (attempt) await sleep(RETRY_MS[attempt - 1]);
    const dispatcher = route?.kind === "proxy" ? proxyAgent(route.url) : attempt === 1 ? dual : ipv4;
    try {
      res = await fetchImpl(`${apiBase}/bot${token}/${method}`, {
        method: body ? "POST" : "GET", headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS), dispatcher,
      });
    } catch (e) { last = netCause(e); }
  }
  if (!res) {
    throw new RuleError("telegram", scrub(`Сервер не достучался до Telegram${route ? ` через ${proxyLabel(route)}` : ""} (${last}, 3 попытки). Нажмите «Проверить связь»${route ? "" : " или задайте прокси ниже"}`));
  }
  const json = (await res.json().catch(() => null)) as Tg<T> | null;
  if (!res.ok || !json?.ok) {
    const why = res.status === 401 || (res.status === 404 && json?.description === "Not Found") ? "токен не подошёл — проверьте его в @BotFather" : json?.description ?? `HTTP ${res.status}`;
    throw new RuleError("telegram", scrub(`Telegram: ${why}`));
  }
  return json.result as T;
}

/** Step 1: the bot token. Checked with getMe; a different bot forgets the chat of the old one. */
export async function saveTelegramToken(db: PrismaClient, cfg: Config, raw: string, fetchImpl: TgFetch = defaultFetch): Promise<string> {
  const token = raw.trim();
  if (!/^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new RuleError("token", "Токен бота выглядит как 123456789:AA… — скопируйте его целиком из @BotFather", "token");
  const enc = encryptSecret(token, cfg.appSecret); // before the request: without APP_SECRET nothing can be stored anyway
  const prev = await readStored(db);
  const proxy = prev?.proxy ? decryptSecret(prev.proxy, cfg.appSecret) : null;
  const me = await call<{ username?: string }>(cfg, token, "getMe", null, fetchImpl, proxy);
  const bot = me.username ?? "bot";
  await write(db, { ...(prev && prev.bot === bot ? prev : {}), ...(prev?.proxy ? { proxy: prev.proxy } : {}), token: enc, bot });
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: TELEGRAM_SETTING, field: "bot", before: prev?.bot ?? null, after: bot } });
  return bot;
}

export interface TelegramChat { id: string; title: string; type: string }
type Chat = { id: number; type: string; title?: string; username?: string; first_name?: string; last_name?: string };
type Update = { message?: { chat: Chat; migrate_to_chat_id?: number }; channel_post?: { chat: Chat }; my_chat_member?: { chat: Chat; new_chat_member?: { status?: string } }; chat_member?: { chat: Chat } };
const chatTitle = (c: Chat) => c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(" ") || (c.username ? `@${c.username}` : String(c.id)));

/** Chats from updates: the newest state wins — a group turned supergroup takes its new id, a group the bot was removed from goes away. Groups first. */
export function chatsFromUpdates(updates: Update[]): TelegramChat[] {
  const chats = new Map<string, TelegramChat>();
  for (const u of updates) {
    const migrated = u.message?.migrate_to_chat_id;
    if (u.message && migrated) { chats.delete(String(u.message.chat.id)); chats.set(String(migrated), { id: String(migrated), title: chatTitle(u.message.chat), type: "supergroup" }); continue; }
    const c = u.message?.chat ?? u.channel_post?.chat ?? u.my_chat_member?.chat ?? u.chat_member?.chat;
    if (!c) continue;
    if (u.my_chat_member && ["left", "kicked"].includes(u.my_chat_member.new_chat_member?.status ?? "")) { chats.delete(String(c.id)); continue; }
    chats.set(String(c.id), { id: String(c.id), title: chatTitle(c), type: c.type });
  }
  const rank = (t: string) => (t === "private" ? 1 : 0);
  return [...chats.values()].sort((a, b) => rank(a.type) - rank(b.type) || a.title.localeCompare(b.title));
}

/** Chats the bot has heard from (someone pressed Start, it was added to a group, /start@bot in a group): the owner picks one. */
export async function findTelegramChats(db: PrismaClient, cfg: Config, fetchImpl: TgFetch = defaultFetch): Promise<TelegramChat[]> {
  const conn = await getTelegram(db, cfg);
  if (!conn) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  const updates = await call<Update[]>(cfg, conn.token, "getUpdates", { limit: 100, timeout: 0, allowed_updates: ["message", "channel_post", "my_chat_member", "chat_member"] }, fetchImpl, conn.proxy);
  return chatsFromUpdates(updates);
}

/** A chat typed by hand (numeric id or @username of a channel / public group), checked with getChat: the bot must be in it. */
export async function resolveTelegramChat(db: PrismaClient, cfg: Config, raw: string, fetchImpl: TgFetch = defaultFetch): Promise<TelegramChat> {
  const v = raw.trim();
  if (!/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/.test(v)) throw new RuleError("manualChat", "Chat id (например −1001234567890) или @username канала / публичной группы", "manualChat");
  const conn = await getTelegram(db, cfg);
  if (!conn) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  const c = await call<Chat>(cfg, conn.token, "getChat", { chat_id: v }, fetchImpl, conn.proxy).catch((e: Error) => {
    throw new RuleError("manualChat", /chat not found/i.test(e.message) ? "Чат не найден: добавьте бота в этот чат и повторите" : e.message, "manualChat");
  });
  return { id: String(c.id), title: chatTitle(c), type: c.type };
}

/** The proxy: checked with getMe through it before it is stored (encrypted — an HTTP proxy may carry a password). Empty — back to direct. */
export async function saveTelegramProxy(db: PrismaClient, cfg: Config, raw: string, fetchImpl: TgFetch = defaultFetch): Promise<string | null> {
  const conn = await getTelegram(db, cfg);
  const prev = await readStored(db);
  if (!conn || !prev) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  const v = raw.trim();
  if (v) {
    parseProxy(v);
    await call(cfg, conn.token, "getMe", null, fetchImpl, v).catch((e: Error) => { throw new RuleError("proxy", e.message, "proxy"); });
  }
  const { proxy: _old, ...rest } = prev;
  await write(db, v ? { ...rest, proxy: encryptSecret(v, cfg.appSecret) } : rest);
  const label = v ? proxyLabel(parseProxy(v)) : null;
  await db.auditLog.create({ data: { entity: "AppSetting", entityId: TELEGRAM_SETTING, field: "proxy", before: prev.proxy ? "задан" : null, after: label } });
  return label;
}

export interface LinkCheck { step: string; target: string; ok: boolean; ms: number | null; detail: string }
export interface ProbeDeps {
  resolve4: (h: string) => Promise<string[]>; resolve6: (h: string) => Promise<string[]>;
  tcp: (ip: string, family: 4 | 6, timeoutMs: number) => Promise<void>; now: () => number;
}
const realProbe: ProbeDeps = {
  resolve4: (h) => dnsp.resolve4(h), resolve6: (h) => dnsp.resolve6(h), now: () => Date.now(),
  tcp: (ip, family, timeoutMs) => new Promise((ok, fail) => {
    const sock = tcpConnect({ host: ip, port: 443, family, timeout: timeoutMs });
    sock.once("connect", () => { sock.destroy(); ok(); });
    sock.once("timeout", () => { sock.destroy(); fail(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); });
    sock.once("error", (e) => { sock.destroy(); fail(e); });
  }),
};

/**
 * «Проверить связь»: what the server sees on the way to Telegram — DNS (A / AAAA), a TCP connect to
 * each address on :443, then getMe directly and through the proxy when one is saved. No access to
 * the server needed to tell an IPv6 hole from a block from a bad token.
 */
export async function checkTelegramLink(db: PrismaClient, cfg: Config, fetchImpl: TgFetch = defaultFetch, deps: ProbeDeps = realProbe): Promise<LinkCheck[]> {
  const host = new URL(cfg.telegram.apiBase).hostname;
  const out: LinkCheck[] = [];
  const timed = async (step: string, target: string, fn: () => Promise<string | void>) => {
    const t0 = deps.now();
    try { const d = await fn(); out.push({ step, target, ok: true, ms: deps.now() - t0, detail: d || "ok" }); return true; }
    catch (e) { out.push({ step, target, ok: false, ms: deps.now() - t0, detail: e instanceof RuleError ? e.message : (e as { code?: string }).code ?? netCause(e) }); return false; }
  };
  const addrs: { ip: string; family: 4 | 6 }[] = [];
  await timed("DNS A (IPv4)", host, async () => { const a = await deps.resolve4(host); addrs.push(...a.slice(0, 2).map((ip) => ({ ip, family: 4 as const }))); return a.join(", "); });
  await timed("DNS AAAA (IPv6)", host, async () => { const a = await deps.resolve6(host); addrs.push(...a.slice(0, 2).map((ip) => ({ ip, family: 6 as const }))); return a.join(", "); });
  for (const a of addrs) await timed(`TCP :443 (IPv${a.family})`, a.ip, () => deps.tcp(a.ip, a.family, 8_000));
  let conn: TelegramConnection | null = null;
  try { conn = await getTelegram(db, cfg); } catch (e) { out.push({ step: "Токен", target: "—", ok: false, ms: null, detail: (e as Error).message }); }
  if (conn) {
    const quick = async () => {}; // the diagnosis should answer fast: retries without pauses
    await timed("HTTPS getMe напрямую", host, async () => { await call(cfg, conn!.token, "getMe", null, fetchImpl, null, quick); });
    if (conn.proxy) await timed("HTTPS getMe через прокси", proxyLabel(parseProxy(conn.proxy)), async () => { await call(cfg, conn!.token, "getMe", null, fetchImpl, conn!.proxy, quick); });
  }
  return out;
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
export async function sendDigest(db: PrismaClient, cfg: Config, day: string, fetchImpl: TgFetch = defaultFetch, now = new Date()): Promise<void> {
  const conn = await getTelegram(db, cfg);
  if (!conn) throw new RuleError("token", "Сначала сохраните токен бота", "token");
  if (!conn.chatId) throw new RuleError("chatId", "Выберите чат: напишите боту и нажмите «Найти чат»", "chatId");
  const text = await digestText(db, cfg, day, conn.minAmount, now);
  await call(cfg, conn.token, "sendMessage", { chat_id: conn.chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } }, fetchImpl, conn.proxy);
}

const yesterdayOf = (now: Date) => addDays(now.toISOString().slice(0, 10), -1);

/**
 * The half-hourly tick: once a day, when the chosen hour (MSK) has come and yesterday is loaded
 * (the per-site cut and derive). Data still missing WAIT_FOR_DATA_H hours later — the digest goes
 * out anyway, marked as incomplete. The sent mark survives restarts and deploys.
 */
export async function digestTick(db: PrismaClient, cfg: Config, fetchImpl: TgFetch = defaultFetch, now = new Date()): Promise<{ status: string; skipped?: string; error?: string }> {
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
export async function sendDigestNow(db: PrismaClient, cfg: Config, fetchImpl: TgFetch = defaultFetch, now = new Date()): Promise<string> {
  const day = yesterdayOf(now);
  const r = await withIngestRun(db, { source: "telegram", job: "digest", from: day, to: day }, async () => { await sendDigest(db, cfg, day, fetchImpl, now); return { rows: 1 }; });
  if (r.status === "failed") throw new RuleError("telegram", r.error ?? "Не удалось отправить");
  return day;
}
