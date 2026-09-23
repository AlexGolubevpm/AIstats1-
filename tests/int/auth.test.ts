import { beforeEach, describe, expect, it } from "vitest";
import { changePassword, issueMcpToken, login, logout, mcpTokenInfo, resetLoginGuard, validateSession, verifyMcpToken } from "@/server/auth";
import { resetDb, testDb } from "./helpers";

const db = testDb();
beforeEach(async () => { await resetDb(); resetLoginGuard(); });

describe("auth", () => {
  it("login requires a configured password", async () => {
    expect(await login(db, "x", "1.1.1.1", "")).toMatchObject({ ok: false, error: expect.stringContaining("APP_PASSWORD") });
  });

  it("sessions: login, validate, logout", async () => {
    const r = await login(db, "correct horse", "1.1.1.1", "correct horse");
    expect(r.ok).toBe(true);
    const token = (r as { token: string }).token;
    expect(await validateSession(db, token)).toBe(true);
    expect(await validateSession(db, "forged")).toBe(false);
    expect(await validateSession(db, undefined)).toBe(false);
    await logout(db, token);
    expect(await validateSession(db, token)).toBe(false);
  });

  it("locks an IP after 5 failures", async () => {
    for (let i = 0; i < 5; i++) expect((await login(db, "bad", "2.2.2.2", "pw-1234567")).ok).toBe(false);
    expect(await login(db, "pw-1234567", "2.2.2.2", "pw-1234567")).toMatchObject({ ok: false, error: expect.stringContaining("15 минут") });
    expect((await login(db, "pw-1234567", "3.3.3.3", "pw-1234567")).ok).toBe(true);
  });

  it("password change drops other sessions; env value is only the initial one", async () => {
    const a = (await login(db, "first-pass-1", "1", "first-pass-1")) as { token: string };
    const b = (await login(db, "first-pass-1", "1", "first-pass-1")) as { token: string };
    expect((await changePassword(db, "wrong", "second-pass-2", a.token, "first-pass-1")).ok).toBe(false);
    expect((await changePassword(db, "first-pass-1", "short", a.token, "first-pass-1")).ok).toBe(false);
    expect((await changePassword(db, "first-pass-1", "second-pass-2", a.token, "first-pass-1")).ok).toBe(true);
    expect(await validateSession(db, a.token)).toBe(true);
    expect(await validateSession(db, b.token)).toBe(false);
    expect((await login(db, "first-pass-1", "1", "first-pass-1")).ok).toBe(false);
    expect((await login(db, "second-pass-2", "1", "first-pass-1")).ok).toBe(true);
  });

  it("MCP tokens: only the hash is stored; env token also accepted", async () => {
    const t = await issueMcpToken(db);
    expect(await verifyMcpToken(db, t, "")).toBe(true);
    expect(await verifyMcpToken(db, t + "x", "")).toBe(false);
    expect(await verifyMcpToken(db, null, "")).toBe(false);
    expect(await verifyMcpToken(db, "env-token", "env-token")).toBe(true);
    expect(JSON.stringify(await db.appSetting.findMany())).not.toContain(t);
    expect((await mcpTokenInfo(db))?.lastUsedAt).not.toBeNull();
    const t2 = await issueMcpToken(db);
    expect(await verifyMcpToken(db, t, "")).toBe(false);
    expect(await verifyMcpToken(db, t2, "")).toBe(true);
  });
});
