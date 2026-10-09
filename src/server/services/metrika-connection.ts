// The Metrika connection made from the UI (ADR 0018): the OAuth app the owner registered in Yandex
// and the tokens Yandex issued, stored encrypted in AppSetting `metrika_oauth`. A token from .env
// (METRIKA_TOKEN) remains the fallback, so the old setup keeps working.
import type { PrismaClient } from "@/generated/prisma/client";
import type { Config } from "@/server/config";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import { RuleError } from "@/server/domain/errors";
import { matchCounters, type MatchRow } from "@/server/domain/metrika-match";
import { MetrikaClient } from "@/server/ingest/metrika/client";
import { exchangeCode, refreshTokens } from "@/server/ingest/metrika/oauth";

export const METRIKA_SETTING = "metrika_oauth";
/** Refresh the access token when less than this is left of its life (Yandex tokens live about a year). */
export const REFRESH_BEFORE_DAYS = 30;

interface Stored { clientId: string; clientSecret: string; accessToken?: string; refreshToken?: string; expiresAt?: string; connectedAt?: string }
export interface MetrikaConnection { clientId: string; clientSecret: string; accessToken: string | null; refreshToken: string | null; expiresAt: Date | null; connectedAt: Date | null }

async function readStored(db: PrismaClient): Promise<Stored | null> {
  const row = await db.appSetting.findUnique({ where: { key: METRIKA_SETTING } });
  if (!row) return null;
  try { return JSON.parse(row.value) as Stored; } catch { return null; }
}
const write = (db: PrismaClient, s: Stored) => db.appSetting.upsert({ where: { key: METRIKA_SETTING }, create: { key: METRIKA_SETTING, value: JSON.stringify(s) }, update: { value: JSON.stringify(s) } });

/** The connection with its secrets decrypted; null when nothing was saved. A changed APP_SECRET surfaces as a RuleError. */
export async function getMetrikaConnection(db: PrismaClient, cfg: Config): Promise<MetrikaConnection | null> {
  const s = await readStored(db);
  if (!s) return null;
  const dec = (v?: string) => (v ? decryptSecret(v, cfg.appSecret) : null);
  return { clientId: s.clientId, clientSecret: dec(s.clientSecret) ?? "", accessToken: dec(s.accessToken), refreshToken: dec(s.refreshToken),
    expiresAt: s.expiresAt ? new Date(s.expiresAt) : null, connectedAt: s.connectedAt ? new Date(s.connectedAt) : null };
}

/** Step 1: the OAuth app. A different app drops the tokens of the old one. */
export async function saveMetrikaApp(db: PrismaClient, cfg: Config, i: { clientId: string; clientSecret: string }): Promise<void> {
  const clientId = i.clientId.trim(), clientSecret = i.clientSecret.trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(clientId)) throw new RuleError("clientId", "ID приложения — строка из oauth.yandex.ru без пробелов", "clientId");
  if (!clientSecret || /\s/.test(clientSecret)) throw new RuleError("clientSecret", "Секрет приложения — строка без пробелов", "clientSecret");
  const prev = await readStored(db);
  const keep = prev && prev.clientId === clientId ? { accessToken: prev.accessToken, refreshToken: prev.refreshToken, expiresAt: prev.expiresAt, connectedAt: prev.connectedAt } : {};
  await write(db, { ...keep, clientId, clientSecret: encryptSecret(clientSecret, cfg.appSecret) });
}

/** Step 2: the confirmation code from Yandex → tokens. */
export async function connectMetrika(db: PrismaClient, cfg: Config, code: string, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ expiresAt: Date }> {
  const conn = await getMetrikaConnection(db, cfg);
  if (!conn) throw new RuleError("app", "Сначала сохраните ID и секрет приложения", "code");
  if (!/^[0-9A-Za-z]{4,64}$/.test(code.trim())) throw new RuleError("code", "Код подтверждения — цифры со страницы Яндекса", "code");
  const t = await exchangeCode({ clientId: conn.clientId, clientSecret: conn.clientSecret }, code, fetchImpl, undefined, now);
  const prev = (await readStored(db))!;
  await write(db, { ...prev, accessToken: encryptSecret(t.accessToken, cfg.appSecret), refreshToken: t.refreshToken ? encryptSecret(t.refreshToken, cfg.appSecret) : undefined,
    expiresAt: t.expiresAt.toISOString(), connectedAt: now.toISOString() });
  return { expiresAt: t.expiresAt };
}

/** Forgets the tokens and the app. */
export const disconnectMetrika = (db: PrismaClient) => db.appSetting.deleteMany({ where: { key: METRIKA_SETTING } });

/** The token the ingest and the checks use: the UI connection first, METRIKA_TOKEN from .env otherwise. */
export async function metrikaToken(db: PrismaClient, cfg: Config): Promise<string | null> {
  try {
    const conn = await getMetrikaConnection(db, cfg);
    if (conn?.accessToken) return conn.accessToken;
  } catch (e) {
    if (!(e instanceof RuleError)) throw e; // a changed key: fall through to .env, the UI explains
  }
  return cfg.metrika.token || null;
}

export type MetrikaStatus =
  | { kind: "oauth"; expiresAt: Date | null; connectedAt: Date | null; clientId: string }
  | { kind: "app"; clientId: string }
  | { kind: "env" }
  | { kind: "broken"; error: string }
  | { kind: "none" };

/** What the Integrations page shows. */
export async function metrikaStatus(db: PrismaClient, cfg: Config): Promise<MetrikaStatus> {
  try {
    const conn = await getMetrikaConnection(db, cfg);
    if (conn?.accessToken) return { kind: "oauth", expiresAt: conn.expiresAt, connectedAt: conn.connectedAt, clientId: conn.clientId };
    if (conn) return { kind: "app", clientId: conn.clientId };
  } catch (e) {
    if (e instanceof RuleError) return { kind: "broken", error: e.message };
    throw e;
  }
  return cfg.metrika.configured ? { kind: "env" } : { kind: "none" };
}

/** Renews the access token through the refresh token when it is about to expire; returns true when it did. */
export async function ensureFreshToken(db: PrismaClient, cfg: Config, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<boolean> {
  const conn = await getMetrikaConnection(db, cfg);
  if (!conn?.accessToken || !conn.refreshToken || !conn.expiresAt) return false;
  if (conn.expiresAt.getTime() - now.getTime() > REFRESH_BEFORE_DAYS * 86_400_000) return false;
  const t = await refreshTokens({ clientId: conn.clientId, clientSecret: conn.clientSecret }, conn.refreshToken, fetchImpl, undefined, now);
  const prev = (await readStored(db))!;
  await write(db, { ...prev, accessToken: encryptSecret(t.accessToken, cfg.appSecret), refreshToken: encryptSecret(t.refreshToken ?? conn.refreshToken, cfg.appSecret), expiresAt: t.expiresAt.toISOString() });
  return true;
}

/** The counters the token sees, matched to our non-archived sites by domain. */
export async function metrikaCounters(db: PrismaClient, cfg: Config, fetchImpl: typeof fetch = fetch): Promise<MatchRow[]> {
  const token = await metrikaToken(db, cfg);
  if (!token) throw new RuleError("token", "Метрика не подключена");
  const { counters } = await new MetrikaClient({ token, fetchImpl }).listCounters();
  const sites = await db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" }, select: { id: true, domain: true, metrikaId: true } });
  return matchCounters(sites, counters);
}

/** Writes the matched counters onto the sites (nothing else is touched) and records each in the AuditLog. */
export async function applyMetrikaCounters(db: PrismaClient, rows: { siteId: string; counterId: string }[]): Promise<number> {
  let n = 0;
  for (const r of rows) {
    if (!/^\d+$/.test(r.counterId)) throw new RuleError("counter", `Счётчик ${r.counterId}: ожидается число`);
    const site = await db.site.findUnique({ where: { id: r.siteId }, select: { id: true, metrikaId: true } });
    if (!site || site.metrikaId === r.counterId) continue;
    await db.$transaction([
      db.site.update({ where: { id: site.id }, data: { metrikaId: r.counterId } }),
      db.auditLog.create({ data: { entity: "Site", entityId: site.id, field: "metrikaId", before: site.metrikaId, after: r.counterId, reason: "счётчик Метрики подобран по домену" } }),
    ]);
    n++;
  }
  return n;
}
