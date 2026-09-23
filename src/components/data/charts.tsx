"use client";
// Charts: no 3D, gradients or shadows; Y from zero; horizontal grid only; tooltip lists all
// series sorted by value; clickable legend on top; gaps are gaps (null), never zeros.
import { useState } from "react";
import { Area, Bar, CartesianGrid, ComposedChart, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
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
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--border)" />
          <XAxis dataKey={xKey} tick={tick} tickLine={false} axisLine={false} tickFormatter={shortDate} minTickGap={16} />
          <YAxis tick={tick} tickLine={false} axisLine={false} width={56} domain={[0, "auto"]} tickFormatter={(v) => formatText(kind === "money" ? "compact" : kind, v).replace("—", "0")} />
          <Tooltip content={<ChartTooltip kind={kind} />} cursor={{ fill: "var(--surface-hover)" }} labelFormatter={(l) => String(l)} />
          <Legend verticalAlign="top" align="right" height={28} iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 12, cursor: "pointer" }}
            onClick={(e) => { const k = String((e as { dataKey?: unknown }).dataKey); const n = new Set(hidden); n.has(k) ? n.delete(k) : n.add(k); setHidden(n); }}
            formatter={(v, e) => <span style={{ color: hidden.has(String((e as { dataKey?: unknown }).dataKey)) ? "var(--text-faint)" : "var(--text-muted)" }}>{v}</span>} />
          {series.map((s) => {
            const common = { key: s.key, dataKey: s.key, name: s.label, hide: hidden.has(s.key), isAnimationActive: false };
            if (s.type === "bar") return <Bar {...common} stackId={s.stack} fill={s.color} radius={s.stack ? 0 : [3, 3, 0, 0]} maxBarSize={28} />;
            if (s.type === "area") return <Area {...common} type="monotone" stroke={s.color} fill={s.color} fillOpacity={0.12} strokeWidth={2} connectNulls={false} />;
            return <Line {...common} type="monotone" stroke={s.color} strokeWidth={2} dot={false} connectNulls={false} strokeDasharray={s.dashed ? "4 3" : undefined} />;
          })}
        </ComposedChart>
      </ResponsiveContainer>
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
