import { beforeEach, describe, expect, it } from "vitest";
import { buildNetwork } from "@tests/factories/network";
import { POST } from "@/app/api/mcp/route";
import { issueMcpToken } from "@/server/auth";
import { getAlerts, getDeals, getNetworkMatrix, getPnl, getZones, queryTool } from "@/server/mcp/tools";
import { geoTable } from "@/server/queries/reports";
import { resetDb, testDb } from "./helpers";

const db = testDb();
beforeEach(async () => { await resetDb(); await buildNetwork(db); });
const P = { date_from: "2026-09-20", date_to: "2026-09-21" };

describe("MCP tools", () => {
  it("query runs over views as mcp_reader and enforces the limit", async () => {
    const r = await queryTool(db, "SELECT site_id, SUM(revenue) revenue FROM v_site_geo_daily GROUP BY 1 ORDER BY 1");
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toEqual({ site_id: "s1", revenue: 42 }); // 40 mediated + 2 own_deals, via-ASG deal not doubled
    const big = await queryTool(db, "SELECT * FROM v_site_geo_daily, generate_series(1, 200) g");
    expect([big.rows.length, big.truncated]).toEqual([1000, true]);
    await expect(queryTool(db, 'SELECT * FROM "FactCost"')).rejects.toThrow(/FactCost/);
  });

  it("the database role is the second line of defence", async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL ROLE mcp_reader");
      return tx.$queryRawUnsafe('SELECT * FROM "Site"');
    })).rejects.toThrow(/permission denied/);
  });

  it("get_pnl by country for a bundle equals the bundle page geo block", async () => {
    const bundle = await db.bundle.findUniqueOrThrow({ where: { slug: "jav" }, include: { sites: true } });
    const ui = await geoTable({ from: P.date_from, to: P.date_to }, { siteIds: bundle.sites.map((s) => s.siteId) }, 0);
    const mcp = (await getPnl({ ...P, group_by: "country", bundle: "jav" })) as { country: string; margin: number }[];
    const loss = (xs: { country: string; margin: number }[]) => xs.filter((x) => x.margin < 0).map((x) => [x.country, x.margin]).sort();
    expect(loss(mcp)).toEqual(loss(ui));
    expect(loss(mcp)).toEqual([["JP", -6]]); // 2 sites × 2 days × (10 − 12) + own_deals 2
  });

  it("get_pnl validates input and groups", async () => {
    await expect(getPnl({ date_from: "bad", date_to: "2026-09-21", group_by: "site" })).rejects.toThrow(/YYYY/);
    await expect(getPnl({ ...P, group_by: "site", bundle: "nope" })).rejects.toThrow(/Бандл/);
    await expect(getPnl({ ...P, group_by: "device" })).rejects.toThrow(/site/);
    const sites = await getPnl({ ...P, group_by: "site" });
    expect(sites.map((s) => (s as { site: string }).site).sort()).toEqual(["one.test", "three.test", "two.test"]);
    expect((await getPnl({ ...P, group_by: "bundle" })).length).toBe(2);
    expect((await getPnl({ ...P, group_by: "device", site: "one.test" }))[0]).toMatchObject({ device: "DESKTOP" });
  });

  it("network matrix, zones, alerts, deals", async () => {
    const m = await getNetworkMatrix({ site: "one.test", ...P });
    expect(m.map((x) => `${x.country}:${x.network}`)).toContain("JP:own_deals");
    const z = await getZones({ site: "one.test", ...P });
    expect(z[0]).toMatchObject({ zone: "Banners_Footer_A", view_rate: 0.1, invisible: true }); // 6000 views / 60000 imps
    await db.alert.create({ data: { rule: "loss_geo", entityKey: "s1:JP", level: "CRITICAL", title: "t", message: "m", link: "/sites/one.test", siteId: "s1", moneyAtRisk: "4", payload: {} } });
    expect(await getAlerts({ bundle: "hentai" })).toEqual([]);
    expect(await getAlerts({ site: "one.test" })).toHaveLength(1);
    const deals = await getDeals({ ...P });
    expect(deals.map((d) => d.deal).sort()).toEqual(["Own popunder", "Sponsor banner"]);
  });
});

describe("MCP route", () => {
  const rpc = (body: unknown, token?: string) => POST(new Request("http://t/api/mcp", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  }));

  it("rejects without a token", async () => {
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(401);
    expect((await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
  });

  it("lists tools and calls one with a valid token", async () => {
    const token = await issueMcpToken(db);
    const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }, token);
    expect(init.status).toBe(200);
    expect((await init.json()).result.instructions).toContain("rev_per_1k_loads");
    const list = await (await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token)).json();
    expect(list.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["get_alerts", "get_deals", "get_network_matrix", "get_pnl", "get_zones", "query"]);
    expect(list.result.tools.find((t: { name: string }) => t.name === "query").description).toContain("v_site_geo_daily(");
    const call = await (await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "query", arguments: { sql: 'SELECT * FROM "Site"' } } }, token)).json();
    expect(call.result.isError).toBe(true);
    expect(call.result.content[0].text).toContain("недоступная таблица");
  });
});
