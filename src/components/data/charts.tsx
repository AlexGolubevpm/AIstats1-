"use client";
// Charts: no 3D, gradients or shadows; Y from zero; horizontal grid only; tooltip lists all
// series sorted by value; clickable legend on top; gaps are gaps (null), never zeros.
import { useState } from "react";
import { cn } from "@/lib/cn";
import { Area, Bar, CartesianGrid, ComposedChart, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatText, type ColumnKind } from "./format-cell";

export interface Series { key: string; label: string; color: string; type: "bar" | "line" | "area"; stack?: string; dashed?: boolean }

const tick = { fontSize: 11, fill: "var(--text-muted)" };
const shortDate = (s: string) => (/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s.slice(8, 10)}.${s.slice(5, 7)}` : s);

function ChartTooltip({ active, payload, label, kind }: { active?: boolean; payload?: { dataKey: string; name: string; value: number; color: string }[]; label?: string; kind: ColumnKind }) {
  if (!active || !payload?.length) return null;
  const items = [...payload].filter((p) => p.value != null).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
  return (
    <div className="card min-w-44 px-3 py-2 text-xs">
      <div className="mb-1 font-medium">{label}</div>
      {items.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted"><span className="size-2 rounded-full" style={{ background: p.color }} />{p.name}</span>
          <span className="num">{formatText(kind, p.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function TrendChart({ data, series, kind = "money", height = 280, xKey = "date" }: { data: Record<string, unknown>[]; series: Series[]; kind?: ColumnKind; height?: number; xKey?: string }) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  if (!data.length) return <div className="flex items-center justify-center text-sm text-muted" style={{ height }}>Нет данных за период</div>;
  return (
    <div className="flex min-w-0 flex-col" style={{ height }}>
      <ul className="mb-1 flex flex-wrap justify-end gap-x-3 gap-y-1 px-1 text-xs" aria-label="Легенда">
        {series.map((s) => {
          const off = hidden.has(s.key);
          return (
            <li key={s.key}>
              <button type="button" onClick={() => { const n = new Set(hidden); off ? n.delete(s.key) : n.add(s.key); setHidden(n); }} aria-pressed={!off}
                className={cn("inline-flex items-center gap-1.5 rounded px-1 py-0.5 transition-colors hover:bg-surface-hover", off ? "text-faint line-through" : "text-muted")}>
                <span className="size-2 rounded-full" style={{ background: s.color, opacity: off ? 0.4 : 1 }} />{s.label}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
      <ResponsiveContainer width="100%" height="100%" debounce={50}>
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={16} />
          <YAxis tick={tick} tickLine={false} axisLine={false} width={56} domain={[0, "auto"]} tickFormatter={(v) => formatText(kind === "money" ? "compact" : kind, v).replace("—", "0")} />
          <Tooltip content={<ChartTooltip kind={kind} />} cursor={{ fill: "var(--surface-hover)" }} labelFormatter={(l) => String(l)} />
          {series.map((s) => {
            const common = { key: s.key, dataKey: s.key, name: s.label, hide: hidden.has(s.key), isAnimationActive: false };
            if (s.type === "bar") return <Bar {...common} stackId={s.stack} fill={s.color} radius={s.stack ? 0 : [3, 3, 0, 0]} maxBarSize={28} />;
            if (s.type === "area") return <Area {...common} type="monotone" stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} connectNulls={false} />;
            return <Line {...common} type="monotone" stroke={s.color} strokeWidth={2} dot={false} connectNulls={false} strokeDasharray={s.dashed ? "4 3" : undefined} />;
          })}
        </ComposedChart>
      </ResponsiveContainer>
      </div>
    </div>
  );
}

export function Sparkline({ values, color }: { values: (number | null)[]; color: string }) {
  if (values.filter((v) => v != null).length < 2) return null;
  const data = values.map((v, i) => ({ i, v }));
  return (
    <div className="h-10 w-28" aria-hidden>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}><Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.75} dot={false} isAnimationActive={false} connectNulls={false} /></LineChart>
      </ResponsiveContainer>
    </div>
  );
}
