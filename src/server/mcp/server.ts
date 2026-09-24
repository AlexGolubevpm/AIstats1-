// MCP server definition (docs/architecture/09-mcp.md). Stateless: a fresh server per request.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { db } from "@/server/db";
import { MCP_VIEWS, SqlRejected } from "./sql-guard";
import { getAlerts, getDeals, getNetworkMatrix, getPnl, getZones, queryTool, ToolError } from "./tools";

export const INSTRUCTIONS = `TubeStat — маржа по сети тьюб-сайтов. Только чтение. Все деньги в USD.
Правила анализа:
1. rCPM не используется: сравнивать сетки и источники только по rev_per_1k_loads (выручка на 1000 загрузок).
2. Own deals и фикс-дилы лежат отдельно (v_deal_daily) и НЕ входят в зонный и форматный разрезы AdSpyglass (v_zone_daily, v_format_daily). Выручка сайта в v_site_geo_daily уже включает прямые фикс-дилы (revenue_direct), дилы через AdSpyglass не задваиваются.
3. Сайт может входить в несколько бандлов: сумма по бандлам ≠ итог сети. Итог сети считать по сайтам.
4. revenue — включая прогноз; revenue_confirmed — только подтверждённое деньгами.
5. Метрики — отношение сумм (SUM(margin)/SUM(cost)), не среднее средних.
ROMI = маржа / расход × 100.`;

let ddlCache: string | null = null;
async function viewsDdl(): Promise<string> {
  if (ddlCache) return ddlCache;
  const cols = await db.$queryRaw<{ t: string; c: string; ty: string }[]>`
    SELECT table_name t, column_name c, data_type ty FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ANY(${[...MCP_VIEWS]}) ORDER BY table_name, ordinal_position`;
  const by = new Map<string, string[]>();
  for (const r of cols) by.set(r.t, [...(by.get(r.t) ?? []), `${r.c} ${r.ty}`]);
  ddlCache = [...by].map(([t, c]) => `${t}(${c.join(", ")})`).join("\n");
  return ddlCache;
}

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });

/** Wraps a tool: logs the call and turns rule errors into tool errors the model can read. */
function wrap<A>(name: string, fn: (a: A) => Promise<unknown>) {
  return async (a: A) => {
    const t0 = Date.now();
    try {
      const out = await fn(a);
      const rows = Array.isArray(out) ? out.length : Array.isArray((out as { rows?: unknown[] })?.rows) ? (out as { rows: unknown[] }).rows.length : 1;
      console.log(JSON.stringify({ mcp: name, args: a, ms: Date.now() - t0, rows }));
      return json(out);
    } catch (e) {
      const msg = e instanceof ToolError || e instanceof SqlRejected ? e.message : `Ошибка: ${(e as Error).message}`;
      console.log(JSON.stringify({ mcp: name, args: a, ms: Date.now() - t0, error: msg }));
      return { ...json({ error: msg }), isError: true };
    }
  };
}

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe("YYYY-MM-DD");
const ro = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

export async function createMcpServer(): Promise<McpServer> {
  const server = new McpServer({ name: "tubestat", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  server.registerTool("query", {
    description: `Произвольный SELECT по отчётным вьюхам (только они доступны; LIMIT ${1000} навязывается; таймаут 10 с).\nВьюхи:\n${await viewsDdl()}`,
    inputSchema: { sql: z.string().min(1).describe("Один SELECT или WITH … SELECT") }, annotations: ro,
  }, wrap("query", (a: { sql: string }) => queryTool(db, a.sql)));
  server.registerTool("get_pnl", {
    description: "P&L за период с группировкой. Итог сети — по сайтам. Поля: revenue, cost, margin, romi, uniques, rpm, rev_per_1k_loads.",
    inputSchema: { date_from: date, date_to: date, group_by: z.enum(["bundle", "site", "country", "device", "format", "network"]),
      bundle: z.string().optional().describe("слаг бандла"), site: z.string().optional().describe("домен"), country: z.string().length(2).optional().describe("ISO-код") },
    annotations: ro,
  }, wrap("get_pnl", getPnl));
  server.registerTool("get_network_matrix", {
    description: "Сетки × гео по сайту: объём, доля, fill rate, rev/1000 loads, ранг по цене, дискрепанси, рекомендация флора, инверсии waterfall.",
    inputSchema: { site: z.string(), date_from: date, date_to: date, country: z.string().length(2).optional() }, annotations: ro,
  }, wrap("get_network_matrix", getNetworkMatrix));
  server.registerTool("get_zones", {
    description: "Зоны сайта: view rate, viewable CPM, доля выручки, флаги «не видна» (<15% view rate) и «кандидат на снос» (<1% выручки).",
    inputSchema: { site: z.string(), date_from: date, date_to: date }, annotations: ro,
  }, wrap("get_zones", getZones));
  server.registerTool("get_alerts", {
    description: "Активные алерты с деньгами под риском и ссылками на UI.",
    inputSchema: { level: z.enum(["WARNING", "CRITICAL"]).optional(), bundle: z.string().optional(), site: z.string().optional() }, annotations: ro,
  }, wrap("get_alerts", getAlerts));
  server.registerTool("get_deals", {
    description: "Фикс-дилы: прогноз, выставлено, подтверждено, остаток к оплате, множитель показов (рекламодатель / наш счётчик). Период по умолчанию — текущий месяц.",
    inputSchema: { status: z.enum(["ACTIVE", "PAUSED", "ENDED", "DRAFT"]).optional(), advertiser: z.string().optional(), date_from: date.optional(), date_to: date.optional() },
    annotations: ro,
  }, wrap("get_deals", getDeals));
  return server;
}
