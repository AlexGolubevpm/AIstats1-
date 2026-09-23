import { describe, expect, it, vi } from "vitest";
import { AsgClient, AsgError } from "@/server/ingest/adspyglass/client";

function fakeFetch(responses: (() => Response)[]) {
  const calls: string[] = [];
  const fn = vi.fn(async (url: URL | string) => {
    calls.push(String(url));
    const next = responses.shift();
    if (!next) throw new Error("unexpected request");
    return next();
  });
  return { fn: fn as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), { status });
const opts = (f: typeof fetch, extra = {}) => ({ baseUrl: "https://api.test/api", email: "e", token: "t", fetchImpl: f, minIntervalMs: 5000, sleep: async () => {}, retryDelaysMs: [1, 1], ...extra });

describe("AsgClient", () => {
  it("builds the report URL and returns rows", async () => {
    const f = fakeFetch([json([{ name: "1. a.com", hits: 5 }])]);
    const c = new AsgClient(opts(f.fn));
    expect(await c.report({ from: "2026-09-22", to: "2026-09-22", groupBy: "country", websiteId: 7 })).toEqual([{ name: "1. a.com", hits: 5 }]);
    expect(f.calls[0]).toBe("https://api.test/api/report?from=2026-09-22&to=2026-09-22&group_by=country&website_id=7");
  });

  it("treats a redirect to sign_in as an auth failure that pauses the queue", async () => {
    const f = fakeFetch([() => new Response(null, { status: 302, headers: { location: "https://api.test/users/sign_in?x=1" } })]);
    const err = await new AsgClient(opts(f.fn)).report({ from: "a", to: "a", groupBy: "website" }).catch((e) => e);
    expect(err).toBeInstanceOf(AsgError);
    expect(err.kind).toBe("auth");
    expect(err.pausesQueue).toBe(true);
    expect(err.message).toContain("/users/sign_in");
    expect(err.message).not.toContain("x=1");
  });

  it("429 is a rate limit; 5xx is retried then fails", async () => {
    expect((await new AsgClient(opts(fakeFetch([json({}, 429)]).fn)).report({ from: "a", to: "a", groupBy: "w" }).catch((e) => e)).kind).toBe("rate_limit");
    const f = fakeFetch([json({}, 502), json({}, 503), json([{ name: "ok" }])]);
    expect(await new AsgClient(opts(f.fn)).report({ from: "a", to: "a", groupBy: "w" })).toEqual([{ name: "ok" }]);
    const g = fakeFetch([json({}, 500), json({}, 500), json({}, 500)]);
    expect((await new AsgClient(opts(g.fn)).report({ from: "a", to: "a", groupBy: "w" }).catch((e) => e)).kind).toBe("server");
  });

  it("serialises requests and waits the minimum interval", async () => {
    let t = 0;
    const sleeps: number[] = [];
    const f = fakeFetch([json([]), json([]), json([])]);
    const c = new AsgClient(opts(f.fn, { now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } }));
    await Promise.all([1, 2, 3].map((i) => c.report({ from: "a", to: "a", groupBy: String(i) })));
    expect(f.calls.map((u) => new URL(u).searchParams.get("group_by"))).toEqual(["1", "2", "3"]);
    expect(sleeps).toEqual([5000, 5000]);
    expect(c.requests).toBe(3);
  });

  it("stops when the daily budget is exhausted", async () => {
    let left = 1;
    const f = fakeFetch([json([])]);
    const c = new AsgClient(opts(f.fn, { takeBudget: async () => left-- > 0 }));
    await c.report({ from: "a", to: "a", groupBy: "w" });
    expect((await c.report({ from: "a", to: "a", groupBy: "w" }).catch((e) => e)).kind).toBe("budget");
    expect(f.calls).toHaveLength(1);
  });

  it("connection errors are reported, not retried", async () => {
    const fn = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    const err = await new AsgClient(opts(fn)).report({ from: "a", to: "a", groupBy: "w" }).catch((e) => e);
    expect(err.kind).toBe("connection");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
