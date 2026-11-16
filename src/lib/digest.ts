// The morning Telegram digest (ADR 0022): yesterday on one phone screen. Pure text building — what
// gets a line, in which order, and what is cut when it does not fit. Numbers come ready from SQL
// (src/server/queries/digest.ts); nothing here adds money up, it only compares and formats.
import { delta, romi } from "@/lib/metrics";

export interface DigestLine { name: string; revenue: number; margin: number; avgRevenue: number }
export interface DigestSite extends DigestLine { pageLoads: number; avgLoads: number }
/** Active alerts of one rule and level as one line: the costliest one's title, how many there are, how many appeared since the last digest. */
export interface DigestAlert { level: "CRITICAL" | "WARNING"; rule: string; title: string; count: number; newCount: number; moneyAtRisk: number }
export interface DigestData {
  day: string;
  /** Days with data among the 7 before `day`: the comparison base. 0 — nothing to compare with. */
  baseDays: number;
  total: { revenue: number; mediated: number; direct: number; cost: number; margin: number };
  avg: { revenue: number; cost: number; margin: number };
  bundles: DigestLine[];
  /** A site sits in several bundles: bundle lines do not add up to the network total. */
  bundlesOverlap: boolean;
  sites: DigestSite[];
  costs: { title: string; cost: number }[];
  alerts: DigestAlert[];
  /** Loading problems in words: a failed run, a paused queue, cost not loaded. */
  health: string[];
  /** Yesterday's per-site cut or the derive run is missing: the numbers are not final. */
  incomplete: boolean;
}
export interface DigestOptions {
  /** Public address of the app for the links; no links without it. */
  appUrl?: string;
  /** A change or a drop smaller than this many dollars is noise. */
  minAmount?: number;
  maxChars?: number;
}

export const DIGEST_DEFAULTS = { minAmount: 30, maxChars: 1500 } as const;
/** Notable change of a site against its 7-day average, in percent. */
export const CHANGE_PCT = 20;
/** A drop that is a problem, in percent. */
export const DROP_PCT = 30;

const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const group = (n: number) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
/** Whole dollars: "$4 210", "−$140". Zero is "$0" — in a message a dash reads as "no data". */
export const usd = (v: number) => `${v < 0 && Math.round(v) !== 0 ? "−" : ""}$${group(v)}`;
const signedUsd = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}$${group(v)}`;
const pct = (v: number | null) => (v == null ? "" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.round(Math.abs(v))}%`);
const dayLabel = (day: string) => `${WEEKDAY[new Date(`${day}T00:00:00Z`).getUTCDay()]} ${day.slice(8, 10)}.${day.slice(5, 7)}`;

interface Caps { bundles: number; costs: number; changes: number; problems: number }
const STEPS: Caps[] = [
  { bundles: 5, costs: 3, changes: 2, problems: 5 },
  { bundles: 4, costs: 3, changes: 2, problems: 4 },
  { bundles: 3, costs: 2, changes: 1, problems: 3 },
  { bundles: 2, costs: 2, changes: 1, problems: 2 },
];

/** "Убыточное гео FR на x.com и ещё 11 таких · новых 3 · под риском $340": many alerts of one rule take one line. */
function alertLine(a: DigestAlert, count: number, fresh: number): string {
  const more = count > 1 ? ` и ещё ${count - 1} ${count - 1 === 1 ? "такой" : "таких"}` : "";
  const news = fresh === 0 ? "" : count === 1 ? " · новый" : fresh === count ? " · все новые" : ` · новых ${fresh}`;
  return `${esc(a.title)}${more}${news}${Math.round(a.moneyAtRisk) > 0 ? ` · под риском ${usd(a.moneyAtRisk)}` : ""}`;
}

/** Problems in the order they matter: loading, a dead site, the network, critical alerts, drops, new warnings. */
export function digestProblems(d: DigestData, minAmount: number = DIGEST_DEFAULTS.minAmount): { text: string; site?: string }[] {
  const out: { text: string; site?: string }[] = d.health.map((text) => ({ text: esc(text) }));
  const cmp = d.baseDays > 0;
  if (cmp) {
    for (const s of d.sites) {
      if (s.pageLoads === 0 && s.avgLoads > 0 && s.avgRevenue >= minAmount) out.push({ site: s.name, text: `${esc(s.name)}: нет загрузок (обычно ${group(s.avgLoads)} в день, ${usd(s.avgRevenue)})` });
    }
    const net = delta(d.total.revenue, d.avg.revenue, "percent");
    if (net != null && net <= -DROP_PCT) out.push({ text: `Сеть: выручка ${pct(net)} к ср. 7 дн. (${signedUsd(d.total.revenue - d.avg.revenue)})` });
  }
  for (const a of d.alerts.filter((x) => x.level === "CRITICAL")) out.push({ text: alertLine(a, a.count, a.newCount) });
  if (cmp) {
    const drops = [
      ...d.bundles.map((b) => ({ ...b, label: `Бандл ${b.name}`, site: undefined as string | undefined })),
      ...d.sites.filter((s) => !(s.pageLoads === 0 && s.avgLoads > 0)).map((s) => ({ ...s, label: s.name, site: s.name as string | undefined })),
    ].map((x) => ({ ...x, diff: x.revenue - x.avgRevenue, p: delta(x.revenue, x.avgRevenue, "percent") }))
      .filter((x) => x.p != null && x.p <= -DROP_PCT && -x.diff >= minAmount)
      .sort((a, b) => a.diff - b.diff);
    for (const x of drops) out.push({ site: x.site, text: `${esc(x.label)}: выручка ${pct(x.p)} к ср. 7 дн. (${signedUsd(x.diff)})` });
  }
  // A warning is news only on the day it appeared; old ones live on the alerts page.
  for (const a of d.alerts.filter((x) => x.level === "WARNING" && x.newCount > 0)) out.push({ text: alertLine(a, a.newCount, a.newCount) });
  return out;
}

/** Sites that moved notably against their 7-day average and are not already listed as a problem. */
export function digestChanges(d: DigestData, minAmount: number = DIGEST_DEFAULTS.minAmount, skip: Set<string> = new Set()) {
  if (d.baseDays === 0) return { up: [], down: [] };
  const moved = d.sites.filter((s) => !skip.has(s.name))
    .map((s) => ({ name: s.name, diff: s.revenue - s.avgRevenue, p: delta(s.revenue, s.avgRevenue, "percent") }))
    .filter((x) => Math.abs(x.diff) >= minAmount && (x.p == null ? x.diff > 0 : Math.abs(x.p) >= CHANGE_PCT));
  return { up: moved.filter((x) => x.diff > 0).sort((a, b) => b.diff - a.diff), down: moved.filter((x) => x.diff < 0).sort((a, b) => a.diff - b.diff) };
}

function render(d: DigestData, o: Required<Pick<DigestOptions, "minAmount">> & DigestOptions, caps: Caps): string {
  const L: string[] = [];
  const cmp = d.baseDays > 0;
  const share = (part: number) => (d.total.revenue > 0 ? ` (${Math.round((part / d.total.revenue) * 100)}%)` : "");
  const vsAvg = cmp ? pct(delta(d.total.revenue, d.avg.revenue, "percent")) : "";
  const r = romi(d.total.revenue, d.total.cost);

  L.push(`📊 <b>TubeStat · ${dayLabel(d.day)}</b>`);
  if (d.incomplete) L.push("⚠️ Данные за вчера загружены не полностью — цифры ещё изменятся");
  L.push(`Выручка <b>${usd(d.total.revenue)}</b>${vsAvg ? ` (${vsAvg} к ср. 7 дн.)` : ""} · расход ${usd(d.total.cost)} · маржа <b>${usd(d.total.margin)}</b>${r == null ? "" : ` · ROMI ${Math.round(r)}%`}`);
  L.push(`AdSpyglass ${usd(d.total.mediated)}${share(d.total.mediated)} · фикс-дилы ${usd(d.total.direct)}${share(d.total.direct)}`);

  const bundles = [...d.bundles].sort((a, b) => b.revenue - a.revenue);
  if (bundles.length) {
    L.push("", `<b>Бандлы</b> · выручка · маржа${cmp ? " · к ср. 7 дн." : ""}${d.bundlesOverlap ? " · пересекаются" : ""}`);
    for (const b of bundles.slice(0, caps.bundles)) {
      const p = cmp ? pct(delta(b.revenue, b.avgRevenue, "percent")) : "";
      L.push(`• ${esc(b.name)} — ${usd(b.revenue)} · ${usd(b.margin)}${p ? ` · ${p}` : ""}`);
    }
    if (bundles.length > caps.bundles) L.push(`…и ещё ${bundles.length - caps.bundles}`);
  }

  const costs = d.costs.filter((c) => Math.round(c.cost) !== 0).sort((a, b) => b.cost - a.cost);
  if (costs.length) {
    const rest = costs.slice(caps.costs).reduce((a, c) => a + c.cost, 0); // display only: the total above comes from SQL
    L.push("", `<b>Расход на трафик</b>: ${[...costs.slice(0, caps.costs).map((c) => `${esc(c.title)} ${usd(c.cost)}`), ...(costs.length > caps.costs ? [`прочее ${usd(rest)}`] : [])].join(" · ")}`);
  }

  const problems = digestProblems(d, o.minAmount);
  const shown = problems.slice(0, caps.problems);
  const ch = digestChanges(d, o.minAmount, new Set(shown.map((p) => p.site).filter((s): s is string => Boolean(s))));
  const moves = [...ch.up.slice(0, caps.changes).map((x) => `▲ ${esc(x.name)} ${signedUsd(x.diff)}${x.p == null ? "" : ` (${pct(x.p)})`}`),
    ...ch.down.slice(0, caps.changes).map((x) => `▼ ${esc(x.name)} ${signedUsd(x.diff)}${x.p == null ? "" : ` (${pct(x.p)})`}`)];
  if (moves.length) L.push("", "<b>Изменения</b> · к ср. 7 дн.", ...moves);

  if (shown.length) {
    L.push("", "⚠️ <b>Проблемы</b>", ...shown.map((p) => `• ${p.text}`));
    if (problems.length > shown.length) L.push(o.appUrl ? `…и ещё ${problems.length - shown.length} — <a href="${o.appUrl}/alerts">все алерты</a>` : `…и ещё ${problems.length - shown.length}`);
  } else L.push("", "✅ Без просадок и сбоев");

  if (o.appUrl) L.push("", `<a href="${o.appUrl}/?preset=yesterday">Открыть сводку</a>`);
  return L.join("\n");
}

/** The message in Telegram HTML. Sections shrink step by step until it fits `maxChars`. */
export function buildDigest(d: DigestData, opts: DigestOptions = {}): string {
  const o = { ...opts, minAmount: opts.minAmount ?? DIGEST_DEFAULTS.minAmount };
  const max = opts.maxChars ?? DIGEST_DEFAULTS.maxChars;
  let text = "";
  for (const caps of STEPS) {
    text = render(d, o, caps);
    if (text.length <= max) return text;
  }
  // Still too long (very long names): cut at a line end so no tag is left open.
  const lines = text.split("\n");
  while (lines.length > 4 && lines.join("\n").length > max - 2) lines.pop();
  return [...lines, "…"].join("\n");
}

/** The same text without markup: the preview on the settings page. */
export const digestPlain = (html: string) => html.replace(/<a href="[^"]*">([^<]*)<\/a>/g, "$1 →").replace(/<\/?b>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
