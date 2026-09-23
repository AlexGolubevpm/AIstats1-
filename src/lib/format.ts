// Number formatting for the UI. Zero and missing values render as "—" (design system rule).
// All functions are locale-stable (ru-RU grouping with a thin space, dot decimals avoided).

const nf = (min: number, max: number) =>
  new Intl.NumberFormat("en-US", { minimumFractionDigits: min, maximumFractionDigits: max });
const int = nf(0, 0);
const money2 = nf(2, 2);
const cpm4 = nf(4, 4);
const pct1 = nf(1, 1);

export const DASH = "—";

const empty = (v: number | null | undefined) => v == null || !Number.isFinite(v) || v === 0;

export function fmtInt(v: number | null | undefined): string {
  return empty(v) ? DASH : int.format(v!).replace(/,/g, " ");
}

export function fmtMoney(v: number | null | undefined): string {
  if (empty(v)) return DASH;
  const s = money2.format(Math.abs(v!)).replace(/,/g, " ");
  return (v! < 0 ? "−$" : "$") + s;
}

export function fmtCpm(v: number | null | undefined): string {
  return empty(v) ? DASH : "$" + cpm4.format(v!);
}

/** v is a fraction (0.123 → 12.3%) unless asPercent is set (12.3 → 12.3%). */
export function fmtPercent(v: number | null | undefined, asPercent = false): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const p = asPercent ? v : v * 100;
  if (p === 0) return DASH;
  return pct1.format(p).replace("-", "−") + "%";
}

export function fmtDelta(v: number | null | undefined, mode: "percent" | "pp" | "abs" = "percent"): string {
  if (v == null || !Number.isFinite(v)) return DASH;
  const sign = v > 0 ? "+" : v < 0 ? "−" : "";
  const a = pct1.format(Math.abs(v));
  return mode === "pp" ? `${sign}${a} пп` : mode === "abs" ? `${sign}${a}` : `${sign}${a}%`;
}

/** Compact form for KPI values: 2.4M, 612.4K. */
export function fmtCompact(v: number | null | undefined): string {
  if (empty(v)) return DASH;
  const a = Math.abs(v!);
  const s = a >= 1e9 ? `${(a / 1e9).toFixed(1)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e4 ? `${(a / 1e3).toFixed(1)}K` : int.format(a).replace(/,/g, " ");
  return (v! < 0 ? "−" : "") + s;
}

export function fmtMultiplier(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? DASH : `×${nf(2, 2).format(v)}`;
}

const dateFmt = new Intl.DateTimeFormat("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", timeZone: "UTC" });
export function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return DASH;
  return dateFmt.format(typeof d === "string" ? new Date(d) : d);
}

/** "14 мин назад", "3 ч назад", "2 дн назад". */
export function fmtAgo(d: Date | string | null | undefined, now = new Date()): string {
  if (!d) return "никогда";
  const ms = now.getTime() - new Date(d).getTime();
  const min = Math.max(0, Math.round(ms / 60000));
  if (min < 60) return `${min} мин назад`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
}
