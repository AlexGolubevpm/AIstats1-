// Cost of bought traffic. Default rates (CostRate) are applied nightly to Metrika uniques;
// imported rows (CSV / Sheets) always win and are never overwritten by the calculation.
// Resolution goes from specific to general: site+country > site > country > global.
import Decimal from "decimal.js";

export type RateModel = "CPM" | "CPC" | "CPU" | "FLAT";

export interface Rate {
  id: string;
  siteId: string | null;
  countryCode: string | null;
  sourceSlug: string;
  rateModel: RateModel;
  rate: Decimal.Value;
  validFrom: string; // ISO day
  validTo: string | null;
}

export interface TrafficCell { date: string; siteId: string; countryCode: string; uniques: number }

export interface CostRow {
  date: string; siteId: string; countryCode: string; sourceSlug: string;
  uniquesBought: number; rateModel: RateModel; rate: Decimal; cost: Decimal;
}

const specificity = (r: Rate) => (r.siteId ? 2 : 0) + (r.countryCode ? 1 : 0);

/** Most specific rate for a cell on a date, or null. Ties break on the latest validFrom. */
export function pickRate(rates: Rate[], cell: { date: string; siteId: string; countryCode: string }, source: string): Rate | null {
  let best: Rate | null = null;
  for (const r of rates) {
    if (r.sourceSlug !== source) continue;
    if (r.validFrom > cell.date || (r.validTo && r.validTo < cell.date)) continue;
    if (r.siteId && r.siteId !== cell.siteId) continue;
    if (r.countryCode && r.countryCode !== cell.countryCode) continue;
    if (!best || specificity(r) > specificity(best) || (specificity(r) === specificity(best) && r.validFrom > best.validFrom)) best = r;
  }
  return best;
}

/**
 * Cost rows for one source. CPU/CPC: uniques × rate; CPM: uniques / 1000 × rate.
 * FLAT is a daily amount per scope, spread over the scope's countries by uniques share
 * (so ROMI by geo stays defined); the rounding remainder goes to the largest cell.
 */
export function computeCosts(cells: TrafficCell[], rates: Rate[], source: string): CostRow[] {
  const out: CostRow[] = [];
  const flatGroups = new Map<string, { rate: Rate; cells: TrafficCell[] }>();
  for (const c of cells) {
    const r = pickRate(rates, c, source);
    if (!r) continue;
    if (r.rateModel === "FLAT") {
      const k = `${r.id}|${c.date}|${r.siteId ? c.siteId : "*"}`;
      const g = flatGroups.get(k) ?? { rate: r, cells: [] };
      g.cells.push(c);
      flatGroups.set(k, g);
      continue;
    }
    const rate = new Decimal(r.rate);
    const base = new Decimal(c.uniques);
    const cost = r.rateModel === "CPM" ? base.div(1000).mul(rate) : base.mul(rate);
    out.push({ ...c, sourceSlug: source, uniquesBought: c.uniques, rateModel: r.rateModel, rate, cost: cost.toDecimalPlaces(4) });
  }
  for (const { rate: r, cells: group } of flatGroups.values()) {
    const amount = new Decimal(r.rate);
    const total = group.reduce((a, c) => a + c.uniques, 0);
    let assigned = new Decimal(0);
    const rows = group.map((c) => {
      const part = total > 0 ? amount.mul(c.uniques).div(total) : amount.div(group.length);
      const cost = part.toDecimalPlaces(4, Decimal.ROUND_DOWN);
      assigned = assigned.add(cost);
      return { ...c, sourceSlug: source, uniquesBought: c.uniques, rateModel: "FLAT" as const, rate: amount, cost };
    });
    const rest = amount.sub(assigned);
    if (!rest.isZero() && rows.length) {
      const top = rows.reduce((a, b) => (b.uniques > a.uniques ? b : a));
      top.cost = top.cost.add(rest);
    }
    out.push(...rows);
  }
  return out;
}

/** New rate with the same scope closes the previous one the day before it starts. */
export function closePreviousRate(existing: Rate[], next: Pick<Rate, "siteId" | "countryCode" | "sourceSlug" | "validFrom">): { id: string; validTo: string }[] {
  const dayBefore = new Date(Date.parse(`${next.validFrom}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  return existing
    .filter((r) => r.sourceSlug === next.sourceSlug && r.siteId === next.siteId && r.countryCode === next.countryCode)
    .filter((r) => r.validFrom < next.validFrom && (!r.validTo || r.validTo >= next.validFrom))
    .map((r) => ({ id: r.id, validTo: dayBefore }));
}

export interface CsvCostRow { date: string; domain: string; country: string; source: string; uniques: number; cost: number }

/** Parses a cost CSV (date, domain, country, source, uniques, cost); header required, `,` or `;`. */
export function parseCostCsv(text: string): { rows: CsvCostRow[]; errors: { line: number; reason: string }[] } {
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim());
  const errors: { line: number; reason: string }[] = [];
  if (!lines.length) return { rows: [], errors: [{ line: 0, reason: "Пустой файл" }] };
  const sep = lines[0].includes(";") ? ";" : ",";
  const head = lines[0].split(sep).map((h) => h.trim().toLowerCase());
  const need = ["date", "domain", "country", "source", "uniques", "cost"];
  const idx = need.map((n) => head.indexOf(n === "domain" && !head.includes("domain") ? "site" : n));
  const missing = need.filter((_, i) => idx[i] < 0);
  if (missing.length) return { rows: [], errors: [{ line: 1, reason: `Нет колонок: ${missing.join(", ")}` }] };
  const rows: CsvCostRow[] = [];
  lines.slice(1).forEach((l, i) => {
    const c = l.split(sep).map((x) => x.trim());
    const [date, domain, country, source, uniques, cost] = idx.map((j) => c[j] ?? "");
    const n = i + 2;
    const d = normalizeCsvDate(date);
    if (!d) return errors.push({ line: n, reason: `Неверная дата «${date}»` });
    const u = Number(uniques.replace(/\s/g, "")), k = Number(cost.replace(/[\s$]/g, "").replace(",", "."));
    if (!Number.isFinite(u) || !Number.isFinite(k)) return errors.push({ line: n, reason: "Уники или сумма — не число" });
    if (!domain) return errors.push({ line: n, reason: "Пустой домен" });
    rows.push({ date: d, domain: domain.toLowerCase().replace(/^www\./, ""), country, source: source.toLowerCase(), uniques: u, cost: k });
  });
  return { rows, errors };
}

/** ISO, DD.MM.YYYY and DD/MM/YYYY → ISO day. */
export function normalizeCsvDate(s: string): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  return m ? `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}` : null;
}
