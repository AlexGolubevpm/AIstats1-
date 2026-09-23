import { describe, expect, it } from "vitest";
import { guardSql, MAX_ROWS } from "@/server/mcp/sql-guard";

describe("MCP sql guard", () => {
  it("accepts selects over views, CTEs and whitelisted functions, enforcing the limit", () => {
    const sql = guardSql("WITH w AS (SELECT site_id, SUM(revenue) r FROM v_site_geo_daily GROUP BY 1) SELECT * FROM w ORDER BY r DESC;");
    expect(sql).toMatch(new RegExp(`LIMIT ${MAX_ROWS}$`));
    expect(sql).not.toContain(";");
    expect(() => guardSql("SELECT date_trunc('month', date) m, round(SUM(margin), 2) FROM v_bundle_daily GROUP BY 1")).not.toThrow();
    expect(() => guardSql("SELECT * FROM v_site_geo_daily LIMIT 5000")).not.toThrow(); // outer limit still wins
  });

  it.each([
    ["SELECT * FROM \"Site\"", /недоступная таблица Site/],
    ["SELECT * FROM pg_catalog.pg_user", /pg_catalog/],
    ["SELECT * FROM information_schema.tables", /information_schema/],
    ["SELECT 1; SELECT 2", /ровно один/],
    ["DELETE FROM v_sites", /только SELECT/],
    ["WITH d AS (DELETE FROM \"Site\" RETURNING *) SELECT * FROM d", /DELETE/],
    ["SELECT pg_sleep(20)", /pg_sleep/],
    ["SELECT set_config('session_authorization', 'postgres', false)", /set_config/],
    ["SELECT query_to_xml('select 1', true, true, '')", /query_to_xml/],
    ["SELECT * FROM dblink('x', 'y') t", /dblink/],
    ["SELECT * FROM public.\"FactCost\"", /FactCost/],
    ["not sql at all", /не разобран/],
  ])("rejects %s", (sql, err) => {
    expect(() => guardSql(sql)).toThrow(err);
  });
});
