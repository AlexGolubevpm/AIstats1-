import { describe, expect, it } from "vitest";
import { BAD_KEY, decryptSecret, encryptSecret } from "@/server/crypto";
import { matchCounters } from "@/server/domain/metrika-match";
import { authorizeUrl, exchangeCode, refreshTokens } from "@/server/ingest/metrika/oauth";
import { MetrikaClient } from "@/server/ingest/metrika/client";

describe("secrets at rest", () => {
  it("round-trips, differs per call, refuses another key or a mangled blob, and needs a key at all", () => {
    const a = encryptSecret("tok-123", "k1"), b = encryptSecret("tok-123", "k1");
    expect(a).not.toBe(b); // a fresh IV every time
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("tok-123");
    expect(decryptSecret(a, "k1")).toBe("tok-123");
    expect(() => decryptSecret(a, "k2")).toThrow(BAD_KEY);
    expect(() => decryptSecret(a.slice(0, -2) + "zz", "k1")).toThrow(BAD_KEY);
    expect(() => decryptSecret("garbage", "k1")).toThrow(BAD_KEY);
    expect(() => encryptSecret("x", "")).toThrow(/APP_SECRET/);
  });
});

describe("Yandex OAuth", () => {
  const app = { clientId: "cid", clientSecret: "sec" };
  const now = new Date("2026-10-09T00:00:00Z");
  it("authorize url asks for a code and forces the account picker", () => {
    const u = new URL(authorizeUrl("abc"));
    expect(u.origin + u.pathname).toBe("https://oauth.yandex.ru/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("abc");
  });
  it("exchanges the pasted code with basic auth and reads the expiry; refresh is the same request with another grant", async () => {
    const calls: { url: string; body: string; auth: string }[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body), auth: String((init?.headers as Record<string, string>).Authorization) });
      return Response.json({ access_token: "acc", refresh_token: "ref", expires_in: 3600, token_type: "bearer" });
    }) as typeof fetch;
    const t = await exchangeCode(app, " 1234567 ", fetchImpl, undefined, now);
    expect(t).toEqual({ accessToken: "acc", refreshToken: "ref", expiresAt: new Date("2026-10-09T01:00:00Z") });
    expect(calls[0].url).toBe("https://oauth.yandex.ru/token");
    expect(calls[0].body).toBe("grant_type=authorization_code&code=1234567");
    expect(calls[0].auth).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    await refreshTokens(app, "ref", fetchImpl, undefined, now);
    expect(calls[1].body).toBe("grant_type=refresh_token&refresh_token=ref");
  });
  it("turns Yandex errors into words and never leaks the secret", async () => {
    const fail = (error: string, status = 400) => (async () => Response.json({ error, error_description: "x" }, { status })) as typeof fetch;
    await expect(exchangeCode(app, "1", fail("bad_verification_code"))).rejects.toThrow("Код не подошёл");
    await expect(exchangeCode(app, "1", fail("invalid_grant"))).rejects.toThrow("устарел");
    await expect(exchangeCode(app, "1", fail("invalid_client", 401))).rejects.toThrow("ID или секрет");
    await expect(exchangeCode(app, "1", fail("weird"))).rejects.toThrow("Яндекс OAuth: weird — x");
    await expect(exchangeCode(app, "1", (async () => { throw new Error("ECONNRESET"); }) as typeof fetch)).rejects.toThrow("недоступен");
    await expect(exchangeCode(app, "1", fail("invalid_client", 401))).rejects.not.toThrow("sec");
  });
});

describe("counters by domain", () => {
  const c = (id: string, site: string, extra: Partial<{ status: string; mirrors: string[]; name: string }> = {}) =>
    ({ id, name: extra.name ?? `c${id}`, site, status: extra.status ?? "Active", mirrors: extra.mirrors ?? [], permission: "own", ownerLogin: null });
  it("matches www, mirrors and case; several active counters → ambiguous; a deleted one is ignored; only our sites come out", () => {
    const rows = matchCounters([
      { id: "a", domain: "alpha.test", metrikaId: null },
      { id: "b", domain: "beta.test", metrikaId: null },
      { id: "g", domain: "gamma.test", metrikaId: "7" },
      { id: "d", domain: "delta.test", metrikaId: "9" },
      { id: "e", domain: "eps.test", metrikaId: null },
      { id: "z", domain: "zeta.test", metrikaId: null },
    ], [
      c("1", "https://www.Alpha.test/"),
      c("2", "mirror-host.test", { mirrors: ["www.beta.test"] }),
      c("3", "gamma.test"), // the site already has 7 → conflict
      c("9", "delta.test"), // the site already has 9 → same
      c("5", "eps.test"), c("6", "eps.test"), // two active → ambiguous
      c("7", "zeta.test", { status: "Deleted" }), // gone: no match
      c("8", "someone-else.test"), // not ours
    ]);
    expect(rows.map((r) => [r.domain, r.decision, r.counterId])).toEqual([
      ["alpha.test", "matched", "1"], ["beta.test", "matched", "2"], ["gamma.test", "conflict", null], ["delta.test", "same", null],
      ["eps.test", "ambiguous", null], ["zeta.test", "none", null],
    ]);
    expect(rows.find((r) => r.domain === "eps.test")!.counters.map((x) => x.id)).toEqual(["5", "6"]);
    expect(rows.some((r) => r.counters.some((x) => x.id === "8"))).toBe(false);
  });
  it("the Management API answer is read into counters", async () => {
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      const u = new URL(String(input));
      expect(u.pathname).toBe("/management/v1/counters");
      expect(u.searchParams.get("field")).toBe("mirrors");
      expect((init?.headers as Record<string, string>).Authorization).toBe("OAuth tok");
      return Response.json({ rows: 1, counters: [{ id: 123, name: "Main", site: "alpha.test", status: "Active", mirrors: ["www.alpha.test"], permission: "own", owner_login: "me" }] });
    }) as typeof fetch;
    const r = await new MetrikaClient({ token: "tok", fetchImpl }).listCounters();
    expect(r.counters).toEqual([{ id: "123", name: "Main", site: "alpha.test", status: "Active", mirrors: ["www.alpha.test"], permission: "own", ownerLogin: "me" }]);
    await expect(new MetrikaClient({ token: "bad", fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch }).listCounters()).rejects.toThrow("не пустила (403)");
  });
});
