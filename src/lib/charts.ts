// Pivot helpers for stacked charts: long rows → one object per date, top-N series + "Прочее".
export const OTHER = "Прочее";
export const OTHER_COLOR = "#94A3B8";

export function pivot(rows: { date: string; key: string; value: number }[], dates: string[], maxSeries = 6) {
  const totals = new Map<string, number>();
  for (const r of rows) totals.set(r.key, (totals.get(r.key) ?? 0) + r.value);
  const keys = [...totals].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const keep = new Set(keys.length > maxSeries ? keys.slice(0, maxSeries - 1) : keys);
  const out = new Map(dates.map((d) => [d, { date: d } as Record<string, number | string>]));
  for (const r of rows) {
    const o = out.get(r.date);
    if (!o) continue;
    const k = keep.has(r.key) ? r.key : OTHER;
    o[k] = ((o[k] as number) ?? 0) + r.value;
  }
  const series = [...keep];
  if (keys.length > keep.size) series.push(OTHER);
  return { data: [...out.values()], series };
}

const PALETTE = ["#4F8DF7", "#A78BFA", "#F472B6", "#FBBF24", "#2DD4BF", "#22C55E"];
export function colorFor(key: string, i: number, known: Record<string, string> = {}): string {
  if (key === OTHER) return OTHER_COLOR;
  return known[key] ?? PALETTE[i % PALETTE.length];
}
