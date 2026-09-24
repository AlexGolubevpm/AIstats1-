// Period presets and comparison windows. Dates are ISO days (YYYY-MM-DD) in UTC.
// State lives in the URL: ?preset=7d or ?from=&to= (docs/product/02-information-architecture.md).

export type Preset = "yesterday" | "7d" | "30d" | "mtd" | "prev_month" | "quarter";
export const PRESETS: { id: Preset; label: string }[] = [
  { id: "yesterday", label: "Вчера" },
  { id: "7d", label: "7 дней" },
  { id: "30d", label: "30 дней" },
  { id: "mtd", label: "Этот месяц" },
  { id: "prev_month", label: "Прошлый месяц" },
];

export interface Period { from: string; to: string; preset?: Preset }

const DAY = 86_400_000;
export const iso = (d: Date) => d.toISOString().slice(0, 10);
export const parseIso = (s: string) => new Date(`${s}T00:00:00.000Z`);
const addDays = (s: string, n: number) => iso(new Date(parseIso(s).getTime() + n * DAY));
export const daysBetween = (from: string, to: string) => Math.round((parseIso(to).getTime() - parseIso(from).getTime()) / DAY) + 1;

export function presetPeriod(preset: Preset, today = iso(new Date())): Period {
  const yesterday = addDays(today, -1);
  const t = parseIso(today);
  const monthStart = iso(new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)));
  switch (preset) {
    case "yesterday": return { from: yesterday, to: yesterday, preset };
    case "7d": return { from: addDays(yesterday, -6), to: yesterday, preset };
    case "30d": return { from: addDays(yesterday, -29), to: yesterday, preset };
    case "mtd": return { from: monthStart, to: today === monthStart ? today : yesterday, preset };
    case "prev_month": {
      const end = addDays(monthStart, -1);
      const e = parseIso(end);
      return { from: iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 1))), to: end, preset };
    }
    case "quarter": {
      const q = Math.floor(t.getUTCMonth() / 3) * 3;
      return { from: iso(new Date(Date.UTC(t.getUTCFullYear(), q, 1))), to: yesterday, preset };
    }
  }
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reads a period from search params, falling back to `fallback` preset. Invalid input never throws. */
export function periodFromParams(
  params: Record<string, string | string[] | undefined>,
  fallback: Preset = "7d",
  today?: string,
): Period {
  const get = (k: string) => (Array.isArray(params[k]) ? params[k]![0] : (params[k] as string | undefined));
  const from = get("from"), to = get("to"), preset = get("preset") as Preset | undefined;
  if (from && to && ISO_RE.test(from) && ISO_RE.test(to) && from <= to) return { from, to };
  if (preset && [...PRESETS.map((p) => p.id), "quarter"].includes(preset)) return presetPeriod(preset, today);
  return presetPeriod(fallback, today);
}

/** The equal-length window right before `p`, used for deltas. */
export function previousPeriod(p: Period): Period {
  const len = daysBetween(p.from, p.to);
  return { from: addDays(p.from, -len), to: addDays(p.from, -1) };
}

/** Every ISO day in the period, inclusive. */
export function eachDay(p: Period): string[] {
  const out: string[] = [];
  for (let d = p.from; d <= p.to; d = addDays(d, 1)) out.push(d);
  return out;
}

export { addDays };
