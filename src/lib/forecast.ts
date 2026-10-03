// Month projection from the days seen so far (docs/product/06-metrics.md#forecast, ADR 0008).
// Pure: the page feeds it daily totals, it returns every day of the month — actual or projected —
// and the month's expected result "at the current pace of the last N complete days".
import { daysInMonth } from "@/server/domain/deals";

export interface DayInput { date: string; revenue: number | null; cost: number | null; opex?: number }
export type DayKind = "actual" | "today" | "forecast";
export interface DayOut { date: string; kind: DayKind; revenue: number | null; cost: number | null; opex: number; margin: number | null; cumRevenue: number; cumMargin: number }
export interface Projection {
  month: string;
  days: DayOut[];
  /** Per-day pace from the last `lookback` complete days (yesterday and back), and how many days were actually available. */
  rate: { revenue: number; cost: number; daysUsed: number };
  actual: { revenue: number; cost: number; opex: number; margin: number; days: number };
  projected: { revenue: number; cost: number; opex: number; margin: number; romi: number | null } | null;
  daysLeft: number;
}

const DAY = 86_400_000;
const addDays = (s: string, n: number) => new Date(Date.parse(`${s}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * `days` may include days before the month (they only feed the pace). A day counts as complete
 * when it is before `today` and has revenue; today itself is partial and is projected like the
 * days after it. A month that is over has no forecast part.
 */
export function projectMonth(i: { month: string; today: string; days: DayInput[]; lookback: number; opexByDay?: Record<string, number> }): Projection {
  const first = `${i.month}-01`, count = daysInMonth(first), last = addDays(first, count - 1);
  const byDate = new Map(i.days.map((d) => [d.date, d]));
  const complete = i.days.filter((d) => d.date < i.today && d.revenue != null && !Number.isNaN(d.revenue)).sort((a, b) => a.date.localeCompare(b.date));
  const used = complete.slice(-Math.max(1, i.lookback));
  const rate = used.length
    ? { revenue: used.reduce((a, d) => a + (d.revenue ?? 0), 0) / used.length, cost: used.reduce((a, d) => a + (d.cost ?? 0), 0) / used.length, daysUsed: used.length }
    : { revenue: 0, cost: 0, daysUsed: 0 };
  const days: DayOut[] = [];
  let cumRevenue = 0, cumMargin = 0;
  const actual = { revenue: 0, cost: 0, opex: 0, margin: 0, days: 0 };
  let daysLeft = 0;
  for (let k = 0; k < count; k++) {
    const date = addDays(first, k), src = byDate.get(date), opex = i.opexByDay?.[date] ?? src?.opex ?? 0;
    const isPast = date < i.today, has = src?.revenue != null && !Number.isNaN(src.revenue);
    let kind: DayKind, revenue: number | null, cost: number | null;
    if (isPast) { kind = "actual"; revenue = has ? src!.revenue : null; cost = has ? src!.cost ?? 0 : null; }
    else { kind = date === i.today ? "today" : "forecast"; daysLeft++; revenue = rate.daysUsed ? rate.revenue : null; cost = rate.daysUsed ? rate.cost : null; }
    const margin = revenue == null ? null : revenue - (cost ?? 0) - opex;
    cumRevenue += revenue ?? 0; cumMargin += margin ?? 0;
    if (kind === "actual" && has) { actual.revenue += revenue!; actual.cost += cost!; actual.margin += margin!; actual.days++; }
    if (kind === "actual") actual.opex += opex;
    days.push({ date, kind, revenue, cost, opex, margin, cumRevenue, cumMargin });
  }
  const opexTotal = days.reduce((a, d) => a + d.opex, 0);
  const projected = daysLeft === 0
    ? { revenue: actual.revenue, cost: actual.cost, opex: opexTotal, margin: actual.revenue - actual.cost - opexTotal, romi: actual.cost ? ((actual.revenue - actual.cost) / actual.cost) * 100 : null }
    : rate.daysUsed
      ? (() => { const revenue = actual.revenue + rate.revenue * daysLeft, cost = actual.cost + rate.cost * daysLeft;
          return { revenue, cost, opex: opexTotal, margin: revenue - cost - opexTotal, romi: cost ? ((revenue - cost) / cost) * 100 : null }; })()
      : null;
  return { month: i.month, days, rate, actual: { ...actual }, projected, daysLeft: last >= i.today ? daysLeft : 0 };
}

export const LOOKBACKS = [3, 7, 14] as const;
export type Lookback = (typeof LOOKBACKS)[number];
export const parseLookback = (v: string | undefined, fallback: Lookback = 7): Lookback => (LOOKBACKS.includes(Number(v) as Lookback) ? (Number(v) as Lookback) : fallback);
