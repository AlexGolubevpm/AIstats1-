// First line of defence for the MCP `query` tool: exactly one read-only statement that touches
// only reporting views and calls only whitelisted functions. The second line is the database:
// the statement runs as NOLOGIN role mcp_reader in a READ ONLY transaction with a 10 s timeout.
import { astVisitor, parse, type Statement } from "pgsql-ast-parser";

export const MCP_VIEWS = ["v_sites", "v_bundles", "v_site_geo_daily", "v_bundle_daily", "v_zone_daily", "v_network_geo", "v_format_daily", "v_deal_daily", "v_alerts_active"] as const;
export const MAX_ROWS = 1000;

const FUNCTIONS = new Set([
  "count", "sum", "avg", "min", "max", "round", "trunc", "coalesce", "nullif", "greatest", "least", "abs", "ceil", "ceiling", "floor", "sign", "power", "sqrt",
  "ln", "log", "exp", "mod", "div", "date_trunc", "date_part", "extract", "to_char", "to_date", "make_date", "age", "now", "current_date", "lower", "upper",
  "length", "concat", "concat_ws", "substring", "substr", "trim", "btrim", "ltrim", "rtrim", "split_part", "left", "right", "replace", "position", "strpos",
  "percentile_cont", "percentile_disc", "stddev", "stddev_pop", "stddev_samp", "variance", "var_pop", "corr", "string_agg", "array_agg", "array_length",
  "unnest", "bool_and", "bool_or", "every", "rank", "row_number", "dense_rank", "percent_rank", "cume_dist", "lag", "lead", "first_value", "last_value",
  "nth_value", "ntile", "generate_series", "exists", "any", "all", "some", "cardinality", "format",
]);

export class SqlRejected extends Error {}

/** Validates `sql` and returns it wrapped with an enforced row limit. */
export function guardSql(sql: string): string {
  let ast: Statement[];
  try { ast = parse(sql); } catch (e) { throw new SqlRejected(`SQL не разобран: ${(e as Error).message.split("\n")[0]}`); }
  if (ast.length !== 1) throw new SqlRejected("Разрешён ровно один оператор");
  const top = ast[0];
  if (!["select", "union", "union all", "with", "with recursive", "values"].includes(top.type)) throw new SqlRejected(`Разрешён только SELECT, получено: ${top.type}`);

  const ctes = new Set<string>();
  const problems: string[] = [];
  const v = astVisitor((m) => ({
    with: (w) => { for (const b of w.bind) ctes.add(b.alias.name); return m.super().with(w); },
    tableRef: (t) => {
      const ok = (!t.schema || t.schema === "public") && ((MCP_VIEWS as readonly string[]).includes(t.name) || (!t.schema && ctes.has(t.name)));
      if (!ok) problems.push(`недоступная таблица ${t.schema ? `${t.schema}.` : ""}${t.name}`);
    },
    call: (c) => {
      const name = c.function.name.toLowerCase();
      if (c.function.schema || !FUNCTIONS.has(name)) problems.push(`функция ${c.function.schema ? `${c.function.schema}.` : ""}${name} не разрешена`);
      return m.super().call(c);
    },
    insert: () => { problems.push("INSERT запрещён"); return null; },
    update: () => { problems.push("UPDATE запрещён"); return null; },
    delete: () => { problems.push("DELETE запрещён"); return null; },
  }));
  v.statement(top);
  if (problems.length) throw new SqlRejected([...new Set(problems)].join("; "));
  const body = sql.trim().replace(/;\s*$/, "");
  return `SELECT * FROM (\n${body}\n) AS _q LIMIT ${MAX_ROWS}`;
}
