"use client";
// Main UI element. Columns are described by kind; format, alignment and colour follow from it.
// Sort and page live in the URL (?{id}.sort=revenue.desc&{id}.page=2) so a slice is shareable.
import { ChevronDown, ChevronRight, ChevronUp, Download } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import { cn } from "@/lib/cn";
import { cellBackground, isNumeric, renderCell, toCsv, type Column, type Row } from "./format-cell";

export interface Filter { id: string; label: string; column: string; op: "lt" | "gt" | "truthy"; value?: number }

export interface DataTableProps {
  id: string;
  columns: Column[];
  rows: Row[];
  totals?: Row;
  defaultSort?: { id: string; dir: "asc" | "desc" };
  pageSize?: number;
  density?: "default" | "compact";
  nestedColumns?: Column[];
  filters?: Filter[];
  exportName?: string;
  empty?: React.ReactNode;
  caption?: string;
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "ru");
}

const passes = (f: Filter, r: Row) => {
  const v = r[f.column];
  if (f.op === "truthy") return Boolean(v);
  if (typeof v !== "number") return false;
  return f.op === "lt" ? v < (f.value ?? 0) : v > (f.value ?? 0);
};

export function DataTable({ id, columns, rows, totals, defaultSort, pageSize = 25, density = "default", nestedColumns, filters, exportName, empty, caption }: DataTableProps) {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState<Set<string>>(new Set());

  const sortParam = sp.get(`${id}.sort`);
  const [sortId, sortDir] = sortParam ? (sortParam.split(".") as [string, "asc" | "desc"]) : [defaultSort?.id, defaultSort?.dir ?? "desc"];
  const page = Math.max(1, Number(sp.get(`${id}.page`) ?? 1));
  const active = new Set((sp.get(`${id}.f`) ?? "").split(",").filter(Boolean));

  const setParams = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) (v == null ? next.delete(k) : next.set(k, v));
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  const filtered = useMemo(() => rows.filter((r) => [...active].every((fid) => {
    const f = filters?.find((x) => x.id === fid);
    return !f || passes(f, r);
  })), [rows, filters, sp]); // eslint-disable-line react-hooks/exhaustive-deps
  const sorted = useMemo(() => {
    if (!sortId) return filtered;
    const s = [...filtered].sort((a, b) => cmp(a[sortId], b[sortId]));
    return sortDir === "desc" ? s.reverse() : s;
  }, [filtered, sortId, sortDir]);

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const cur = Math.min(page, pages);
  const visible = sorted.slice((cur - 1) * pageSize, cur * pageSize);
  const means = useMemo(() => Object.fromEntries(columns.filter((c) => c.heat === "vsMean").map((c) => {
    const vals = filtered.map((r) => r[c.id]).filter((v): v is number => typeof v === "number");
    return [c.id, vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null];
  })), [columns, filtered]);

  const rowH = density === "compact" ? "h-[30px]" : "h-9";
  const toggleSort = (c: Column) => {
    if (c.sortable === false) return;
    const dir = sortId === c.id && sortDir === "desc" ? "asc" : "desc";
    setParams({ [`${id}.sort`]: `${c.id}.${dir}`, [`${id}.page`]: null });
  };
  const exportCsv = () => {
    const blob = new Blob(["﻿" + toCsv(columns, sorted)], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${exportName ?? id}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const hasNested = Boolean(nestedColumns && rows.some((r) => r._children?.length));

  return (
    <div className="flex flex-col gap-2">
      {(filters?.length || exportName) && (
        <div className="flex flex-wrap items-center gap-2">
          {filters?.map((f) => {
            const on = active.has(f.id);
            return (
              <button key={f.id} onClick={() => {
                const next = new Set(active); on ? next.delete(f.id) : next.add(f.id);
                setParams({ [`${id}.f`]: [...next].join(",") || null, [`${id}.page`]: null });
              }} className={cn("h-7 rounded-full border px-3 text-xs", on ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover")}>
                {f.label}
              </button>
            );
          })}
          <span className="flex-1" />
          {exportName && <button onClick={exportCsv} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-surface-hover"><Download className="size-3.5" />CSV</button>}
        </div>
      )}
      <div className="-mx-5 overflow-x-auto">
        <table className="num w-full border-collapse text-[13px] leading-[18px]">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className="sticky top-0 z-10 bg-surface">
            <tr className="border-b border-border">
              {hasNested && <th className="w-8" />}
              {columns.map((c, i) => (
                <th key={c.id} scope="col" title={c.tooltip}
                  className={cn("h-8 px-3 text-xs font-medium tracking-[0.01em] whitespace-nowrap text-muted select-none", isNumeric(c.kind) ? "text-right" : "text-left",
                    i === 0 && !hasNested && "pl-5", i === columns.length - 1 && "pr-5", c.sortable !== false && "cursor-pointer hover:text-text")}
                  onClick={() => toggleSort(c)} aria-sort={sortId === c.id ? (sortDir === "asc" ? "ascending" : "descending") : undefined}>
                  <span className={cn("inline-flex items-center gap-0.5", isNumeric(c.kind) && "flex-row-reverse")}>
                    {c.header}
                    {sortId === c.id && (sortDir === "asc" ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={columns.length + (hasNested ? 1 : 0)} className="px-5 py-10 text-center text-sm text-muted">{empty ?? "Нет данных"}</td></tr>
            )}
            {visible.map((r, ri) => {
              const key = r._key ?? String(ri);
              const isOpen = open.has(key);
              return (
                <Fragment key={key}>
                  <tr className={cn("border-b border-border/70 transition-colors hover:bg-surface-hover", r._warn && "bg-warning-soft/60", rowH)}>
                    {hasNested && (
                      <td className="pl-3">
                        {r._children?.length ? (
                          <button aria-label={isOpen ? "Свернуть" : "Развернуть"} onClick={() => { const n = new Set(open); isOpen ? n.delete(key) : n.add(key); setOpen(n); }}
                            className="rounded p-0.5 text-muted hover:bg-surface-hover">{isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}</button>
                        ) : null}
                      </td>
                    )}
                    {columns.map((c, i) => {
                      const inner = renderCell(c, r, { mean: means[c.id] ?? null });
                      return (
                        <td key={c.id} style={{ background: cellBackground(c, r, means[c.id] ?? null) }}
                          className={cn("px-3 whitespace-nowrap", isNumeric(c.kind) ? "text-right" : "text-left", i === 0 && !hasNested && "pl-5", i === columns.length - 1 && "pr-5")}>
                          {i === 0 && r._href ? <Link href={r._href} className="hover:text-accent hover:underline">{inner}</Link> : inner}
                        </td>
                      );
                    })}
                  </tr>
                  {isOpen && nestedColumns && (
                    <tr className="border-b border-border bg-surface-2">
                      <td />
                      <td colSpan={columns.length} className="px-3 py-2">
                        <table className="num w-full text-[12px]">
                          <thead><tr>{nestedColumns.map((c) => <th key={c.id} className={cn("px-2 py-1 text-[11px] font-medium text-muted", isNumeric(c.kind) ? "text-right" : "text-left")}>{c.header}</th>)}</tr></thead>
                          <tbody>{r._children!.map((ch, ci) => (
                            <tr key={ci} className={cn("border-t border-border/60", ch._warn && "bg-warning-soft/60")}>
                              {nestedColumns.map((c) => <td key={c.id} className={cn("px-2 py-1", isNumeric(c.kind) ? "text-right" : "text-left")} style={{ background: cellBackground(c, ch, null) }}>{renderCell(c, ch)}</td>)}
                            </tr>
                          ))}</tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
          {totals && (
            <tfoot className="sticky bottom-0 bg-surface">
              <tr className="h-9 border-t border-border-strong font-medium">
                {hasNested && <td />}
                {columns.map((c, i) => (
                  <td key={c.id} className={cn("px-3 whitespace-nowrap", isNumeric(c.kind) ? "text-right" : "text-left", i === 0 && !hasNested && "pl-5", i === columns.length - 1 && "pr-5")}>
                    {c.id in totals ? renderCell(c, totals) : ""}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {pages > 1 && (
        <div className="flex items-center justify-between pt-1 text-xs text-muted">
          <span>{(cur - 1) * pageSize + 1}–{Math.min(cur * pageSize, sorted.length)} из {sorted.length}</span>
          <div className="flex gap-1">
            {Array.from({ length: pages }, (_, i) => i + 1).filter((p) => p === 1 || p === pages || Math.abs(p - cur) <= 2).map((p, i, arr) => (
              <Fragment key={p}>
                {i > 0 && p - arr[i - 1] > 1 && <span className="px-1">…</span>}
                <button onClick={() => setParams({ [`${id}.page`]: p === 1 ? null : String(p) })}
                  className={cn("h-7 min-w-7 rounded-md px-2", p === cur ? "bg-accent-soft text-accent" : "hover:bg-surface-hover")}>{p}</button>
              </Fragment>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
