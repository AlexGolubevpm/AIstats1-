// Formatting, alignment and colour derived from a column's kind (design system §3 DataTable).
// Pure and server-safe: used by DataTable, CSV export and tests.
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { DASH, fmtCompact, fmtCpm, fmtDelta, fmtInt, fmtMoney, fmtMultiplier, fmtPercent } from "@/lib/format";
import { discrepancyLevel } from "@/lib/metrics";
import { cn } from "@/lib/cn";

export type ColumnKind =
  | "text" | "mono" | "int" | "compact" | "money" | "cpm" | "percent" | "romi" | "delta" | "deltaPp"
  | "share" | "country" | "site" | "status" | "multiplier" | "discrepancy" | "decimal";

export interface Column {
  id: string;
  header: string;
  kind: ColumnKind;
  /** Heat fill: vsMean = only when > 20% off the slice mean; sign = red below zero. */
  heat?: "vsMean" | "sign";
  tooltip?: string;
  sortable?: boolean;
  width?: number;
}

export type Row = Record<string, unknown> & {
  _key?: string;
  _href?: string;
  _warn?: boolean;
  _children?: Row[];
  _dashed?: Record<string, boolean>; // forecast money cells (dashed border)
  _badges?: Record<string, { label: string; tone: "neutral" | "accent" | "positive" | "negative" | "warning" }[]>;
};

export const isNumeric = (k: ColumnKind) => !["text", "mono", "country", "site", "status"].includes(k);

const flag = (cc: string) => (/^[A-Z]{2}$/.test(cc) && cc !== "XX" && cc !== "ZZ" ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : "🏳");

const unit = (s: string, u: string, pos: "pre" | "post") => {
  const i = pos === "pre" ? s.indexOf(u) : s.lastIndexOf(u);
  if (i < 0 || s === DASH) return s;
  return pos === "pre"
    ? <>{s.slice(0, i)}<span className="text-[0.92em] text-muted">{u}</span>{s.slice(i + u.length)}</>
    : <>{s.slice(0, i)}<span className="text-[0.92em] text-muted">{u}</span></>;
};

export function formatText(kind: ColumnKind, v: unknown): string {
  const n = typeof v === "number" ? v : v == null ? null : Number(v);
  switch (kind) {
    case "int": return fmtInt(n);
    case "compact": return fmtCompact(n);
    case "money": return fmtMoney(n);
    case "cpm": return fmtCpm(n);
    case "percent": case "discrepancy": return fmtPercent(n);
    case "romi": return fmtPercent(n, true);
    case "share": return n == null ? DASH : fmtPercent(n);
    case "delta": return fmtDelta(n, "percent");
    case "deltaPp": return fmtDelta(n, "pp");
    case "multiplier": return fmtMultiplier(n);
    case "decimal": return n == null || !Number.isFinite(n) || n === 0 ? DASH : n.toFixed(2);
    default: return v == null || v === "" ? DASH : String(v);
  }
}

export function renderCell(col: Column, row: Row, ctx: { mean?: number | null } = {}): ReactNode {
  const v = row[col.id];
  const text = formatText(col.kind, v);
  const n = typeof v === "number" ? v : null;
  const badges = row._badges?.[col.id];
  let content: ReactNode = text;
  if (col.kind === "money") content = unit(text, "$", "pre");
  else if (["percent", "romi", "share", "discrepancy", "delta"].includes(col.kind)) content = unit(text, "%", "post");
  if (col.kind === "country") {
    const name = (row[`${col.id}__name`] as string) ?? String(v ?? "");
    content = <span className="inline-flex items-center gap-2"><span aria-hidden>{flag(String(v ?? ""))}</span><span>{name}</span><span className="font-mono text-[11px] text-faint">{String(v ?? "")}</span></span>;
  }
  if (col.kind === "site") content = <span className="font-mono text-[12px] text-text">{text}</span>;
  if (col.kind === "mono") content = <span className="font-mono text-[12px]">{text}</span>;
  if (text === DASH) content = <span className="text-faint">{DASH}</span>;
  let cls = "";
  if ((col.kind === "delta" || col.kind === "deltaPp") && n) cls = n > 0 ? "text-positive" : "text-negative";
  if (col.kind === "discrepancy") {
    const lvl = discrepancyLevel(n);
    cls = lvl === "warning" ? "text-warning" : lvl === "negative" ? "text-negative" : "";
  }
  if (col.kind === "multiplier" && n != null && n > 1.5) cls = "text-warning font-medium";
  if (col.heat && n != null) {
    if (n < 0) cls = cn(cls, "text-negative");
    else if (col.heat === "vsMean" && ctx.mean != null && ctx.mean > 0 && n > ctx.mean * 1.2) cls = cn(cls, "text-positive");
  }
  return (
    <span className={cn("inline-flex items-center gap-1.5", cls, row._dashed?.[col.id] && "rounded border border-dashed border-border-strong px-1 text-muted")}>
      <span>{content}</span>
      {badges?.map((b) => <Badge key={b.label} tone={b.tone}>{b.label}</Badge>)}
    </span>
  );
}

/** Background for heat cells and share bars. */
export function cellBackground(col: Column, row: Row, mean: number | null): string | undefined {
  const n = typeof row[col.id] === "number" ? (row[col.id] as number) : null;
  if (n == null) return undefined;
  if (col.kind === "share") {
    const p = Math.max(0, Math.min(1, n)) * 100;
    return `linear-gradient(90deg, var(--accent-soft) ${p}%, transparent ${p}%)`;
  }
  if (!col.heat) return undefined;
  if (n < 0) return "var(--heat-neg)";
  if (col.heat === "vsMean" && mean != null && mean > 0 && Math.abs(n - mean) / mean > 0.2) return n > mean ? "var(--heat-pos)" : undefined;
  return undefined;
}

export function toCsv(columns: Column[], rows: Row[]): string {
  const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = columns.map((c) => esc(c.header)).join(",");
  const body = rows.map((r) => columns.map((c) => {
    const v = r[c.id];
    if (v == null) return "";
    return esc(typeof v === "number" ? String(v) : String(v));
  }).join(","));
  return [head, ...body].join("\n");
}
