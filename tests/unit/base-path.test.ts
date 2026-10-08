import { describe, expect, it, vi } from "vitest";

// BASE_PATH is inlined at build time from NEXT_PUBLIC_BASE_PATH; the module is re-imported per case.
async function load(base: string | undefined) {
  vi.resetModules();
  if (base === undefined) delete process.env.NEXT_PUBLIC_BASE_PATH; else process.env.NEXT_PUBLIC_BASE_PATH = base;
  return import("@/lib/base-path");
}

describe("base path", () => {
  it("at the root nothing changes and the cookie lives at /", async () => {
    const m = await load(undefined);
    expect(m.BASE_PATH).toBe("");
    expect(m.withBase("/api/export/month?month=2026-09")).toBe("/api/export/month?month=2026-09");
    expect(m.cookiePath()).toBe("/");
  });

  it("under /admin plain links and the cookie get the prefix once; a trailing slash in the setting is ignored", async () => {
    const m = await load("/admin/");
    expect(m.BASE_PATH).toBe("/admin");
    expect(m.withBase("/api/mcp")).toBe("/admin/api/mcp");
    expect(m.withBase("api/mcp")).toBe("/admin/api/mcp");
    expect(m.withBase("/admin/api/mcp")).toBe("/admin/api/mcp"); // already prefixed
    expect(m.withBase("/administration")).toBe("/admin/administration"); // a prefix in letters only is not the base path
    expect(m.cookiePath()).toBe("/admin");
  });

  it("the session cookie is HttpOnly, Lax, Secure only with COOKIE_SECURE=1 and scoped to the base path", async () => {
    await load("/admin");
    const { sessionCookieOptions, SESSION_DAYS } = await import("@/server/auth");
    expect(sessionCookieOptions(true)).toEqual({ httpOnly: true, sameSite: "lax", secure: true, path: "/admin", maxAge: SESSION_DAYS * 86_400 });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
