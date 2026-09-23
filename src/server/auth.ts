// Single-password access (internal tool, no roles). The password hash lives in AppSetting and
// is initialised from APP_PASSWORD; sessions are random tokens, stored hashed, 30-day cookie.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@/generated/prisma/client";

export const SESSION_COOKIE = "ts_session";
export const SESSION_DAYS = 30;
const PASSWORD_KEY = "password_hash";
const MCP_KEY = "mcp_token_hash";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

async function passwordHash(db: PrismaClient, envPassword: string): Promise<string | null> {
  const s = await db.appSetting.findUnique({ where: { key: PASSWORD_KEY } });
  if (s) return s.value;
  if (!envPassword) return null;
  const hash = await bcrypt.hash(envPassword, 10);
  await db.appSetting.create({ data: { key: PASSWORD_KEY, value: hash } });
  return hash;
}

export async function isPasswordConfigured(db: PrismaClient, envPassword: string): Promise<boolean> {
  return (await passwordHash(db, envPassword)) != null;
}

/** Brute-force guard: 5 failures per IP → 15 minutes lockout. In-memory, per process. */
const failures = new Map<string, { count: number; until: number }>();
export function loginLocked(ip: string, now = Date.now()): boolean {
  const f = failures.get(ip);
  return Boolean(f && f.count >= 5 && f.until > now);
}
function recordFailure(ip: string, now = Date.now()) {
  const f = failures.get(ip);
  const count = f && f.until > now ? f.count + 1 : 1;
  failures.set(ip, { count, until: now + 15 * 60_000 });
}
export function resetLoginGuard() { failures.clear(); }

export type LoginResult = { ok: true; token: string } | { ok: false; error: string };

export async function login(db: PrismaClient, password: string, ip: string, envPassword: string): Promise<LoginResult> {
  if (loginLocked(ip)) return { ok: false, error: "Слишком много попыток. Подождите 15 минут." };
  const hash = await passwordHash(db, envPassword);
  if (!hash) return { ok: false, error: "Пароль не задан: добавьте APP_PASSWORD в /opt/tubestat/.env на сервере." };
  if (!(await bcrypt.compare(password, hash))) {
    recordFailure(ip);
    return { ok: false, error: "Неверный пароль" };
  }
  failures.delete(ip);
  const token = randomBytes(32).toString("base64url");
  await db.session.create({ data: { id: sha256(token), ip } });
  return { ok: true, token };
}

export async function validateSession(db: PrismaClient, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const s = await db.session.findUnique({ where: { id: sha256(token) } });
  if (!s) return false;
  if (Date.now() - s.createdAt.getTime() > SESSION_DAYS * 86_400_000) {
    await db.session.delete({ where: { id: s.id } });
    return false;
  }
  if (Date.now() - s.lastSeenAt.getTime() > 3_600_000) await db.session.update({ where: { id: s.id }, data: { lastSeenAt: new Date() } });
  return true;
}

export async function logout(db: PrismaClient, token: string | undefined): Promise<void> {
  if (token) await db.session.deleteMany({ where: { id: sha256(token) } });
}

/** Changing the password drops every session except the current one. */
export async function changePassword(db: PrismaClient, current: string, next: string, keepToken: string | undefined, envPassword: string): Promise<{ ok: boolean; error?: string }> {
  const hash = await passwordHash(db, envPassword);
  if (!hash || !(await bcrypt.compare(current, hash))) return { ok: false, error: "Текущий пароль неверен" };
  if (next.length < 10) return { ok: false, error: "Новый пароль — минимум 10 символов" };
  await db.appSetting.update({ where: { key: PASSWORD_KEY }, data: { value: await bcrypt.hash(next, 10) } });
  await db.session.deleteMany({ where: keepToken ? { id: { not: sha256(keepToken) } } : {} });
  return { ok: true };
}

// ---- MCP bearer token ----

/** Issues a new MCP token; only its hash is stored, the token is shown once. */
export async function issueMcpToken(db: PrismaClient): Promise<string> {
  const token = `tsmcp_${randomBytes(24).toString("base64url")}`;
  const value = JSON.stringify({ hash: sha256(token), createdAt: new Date().toISOString(), lastUsedAt: null });
  await db.appSetting.upsert({ where: { key: MCP_KEY }, create: { key: MCP_KEY, value }, update: { value } });
  return token;
}

export async function mcpTokenInfo(db: PrismaClient): Promise<{ createdAt: string; lastUsedAt: string | null } | null> {
  const s = await db.appSetting.findUnique({ where: { key: MCP_KEY } });
  if (!s) return null;
  const v = JSON.parse(s.value);
  return { createdAt: v.createdAt, lastUsedAt: v.lastUsedAt };
}

/** Accepts the DB-issued token, or MCP_TOKEN from env (bootstrap before the UI is reachable). */
export async function verifyMcpToken(db: PrismaClient, bearer: string | null, envToken: string): Promise<boolean> {
  if (!bearer) return false;
  const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
  if (envToken && eq(bearer, envToken)) return true;
  const s = await db.appSetting.findUnique({ where: { key: MCP_KEY } });
  if (!s) return false;
  const v = JSON.parse(s.value);
  if (!eq(sha256(bearer), v.hash)) return false;
  if (!v.lastUsedAt || Date.now() - Date.parse(v.lastUsedAt) > 60_000) {
    await db.appSetting.update({ where: { key: MCP_KEY }, data: { value: JSON.stringify({ ...v, lastUsedAt: new Date().toISOString() }) } });
  }
  return true;
}
