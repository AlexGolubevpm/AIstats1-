// The morning Telegram digest (ADR 0022): yesterday in Telegram HTML. Pure text building — what gets
// a line and in which order. Numbers come ready from SQL (src/server/queries/digest.ts); nothing here
// adds money up, it only compares and formats. Nothing is cut to "…and N more": long lists fold into
// an expandable quote, and a digest longer than one Telegram message goes out as several.
import { delta, romi } from "@/lib/metrics";

export interface DigestLine { name: string; revenue: number; margin: number; avgRevenue: number }
export interface DigestSite extends DigestLine { pageLoads: number; avgLoads: number }
export interface DigestAlertItem { title: string; message: string; moneyAtRisk: number; isNew: boolean }
/** Active alerts of one rule and level: how many, how many new, the money at risk, what to do, the alerts themselves (new and costly first). */
export interface DigestAlert { level: "CRITICAL" | "WARNING"; rule: string; count: number; newCount: number; moneyAtRisk: number; action: string; items: DigestAlertItem[] }
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
  /** One Telegram message holds 4 096 characters; a margin for entities. */
  maxChars?: number;
}

export const DIGEST_DEFAULTS = { minAmount: 30, maxChars: 4000 } as const;
/** Notable change of a site against its 7-day average, in percent. */
export const CHANGE_PCT = 20;
/** A drop that is a problem, in percent. */
export const DROP_PCT = 30;
/** Alerts of a group shown in full; the rest fold into an expandable quote. */
export const DETAILED = 2;
/** Width of the monospace tables: fits a phone screen without wrapping. */
export const TABLE_WIDTH = 34;

/** What each alert rule means, in the owner's words (src/server/domain/alerts/rules.ts). */
export const RULE_LABEL: Record<string, string> = {
  loss_geo: "Убыточное гео — расход больше выручки",
  waterfall_inversion: "Инверсия waterfall — дешёвая сетка держит объём",
  discrepancy: "Дискрепанси — наши показы и показы сетки расходятся",
  invisible_zone: "Зона не видна — показы есть, просмотров мало",
  dead_zone: "Мёртвая зона — показы есть, денег почти нет",
  low_fill: "Низкий fill — запросы остаются без рекламы",
  deal_no_numbers: "Нет цифр по фикс-дилу за закрытый период",
  overdue_payment: "Просрочена оплата по фикс-дилу",
  ingest_down: "Загрузка данных не работает",
  deal_ending: "Срок фикс-дила",
  source_unconfigured: "Доля расхода источника не подтверждена",
};

const WEEKDAY = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"];
const MONTH = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const group = (n: number) => String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
/** Whole dollars: "$4 210", "−$140". Zero is "$0" — in a message a dash reads as "no data". */
export const usd = (v: number) => `${v < 0 && Math.round(v) !== 0 ? "−" : ""}$${group(v)}`;
const signedUsd = (v: number) => `${Math.round(v) > 0 ? "+" : Math.round(v) < 0 ? "−" : ""}$${group(v)}`;
const pct = (v: number | null) => (v == null ? "" : `${Math.round(v) > 0 ? "+" : Math.round(v) < 0 ? "−" : ""}${Math.round(Math.abs(v))}%`);
const arrow = (v: number | null) => (v == null ? "" : Math.round(v) > 0 ? `▲ ${Math.round(v)}%` : Math.round(v) < 0 ? `▼ ${Math.round(-v)}%` : "= 0%");
export const dayLabel = (day: string) => { const d = new Date(`${day}T00:00:00Z`); return `${WEEKDAY[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTH[d.getUTCMonth()]}`; };
/** "1 случай / 2 случая / 5 случаев". */
export const plural = (n: number, one: string, few: string, many: string) => {
  const a = Math.abs(n) % 100, b = a % 10;
  return `${n} ${a > 10 && a < 20 ? many : b === 1 ? one : b >= 2 && b <= 4 ? few : many}`;
};
const cut = (s: string, w: number) => (s.length > w ? `${s.slice(0, w - 1)}…` : s);
/** A monospace row: the first cell left, the rest right-aligned. Escaped after padding so widths are counted on the text. */
const row = (cells: string[], widths: number[]) => cells.map((c, i) => (i === 0 ? cut(c, widths[0]).padEnd(widths[0]) : c.padStart(widths[i]))).join(" ").trimEnd();
const pre = (rows: string[]) => `<pre>${esc(rows.join("\n"))}</pre>`;
/** Ten cells; a share above zero always gets at least one, so 5% does not look like nothing. */
const bar = (share: number) => { const n = share <= 0 ? 0 : Math.max(1, Math.min(10, Math.round(share * 10))); return "▓".repeat(n) + "░".repeat(10 - n); };

export interface DigestProblem { icon: "🔴" | "🟡"; text: string; site?: string }

/** Problems the digest finds itself, before the alerts: loading, a site that stopped, the network, bundle and site drops. */
export function digestProblems(d: DigestData, minAmount: number = DIGEST_DEFAULTS.minAmount): DigestProblem[] {
  const out: DigestProblem[] = d.health.map((text) => ({ icon: "🔴" as const, text: esc(text) }));
  if (d.baseDays === 0) return out;
  for (const s of d.sites) {
    if (s.pageLoads === 0 && s.avgLoads > 0 && s.avgRevenue >= minAmount) {
      out.push({ icon: "🔴", site: s.name, text: `<b>${esc(s.name)}</b> не отдал ни одной загрузки. Обычно ${group(s.avgLoads)} загрузок и ${usd(s.avgRevenue)} в день — проверьте сайт и код ADOK.` });
    }
  }
  const net = delta(d.total.revenue, d.avg.revenue, "percent");
  if (net != null && net <= -DROP_PCT) out.push({ icon: "🔴", text: `<b>Выручка сети упала на ${Math.round(-net)}%</b>: ${usd(d.total.revenue)} вместо обычных ${usd(d.avg.revenue)} в день.` });
  const drops = [
    ...d.bundles.map((b) => ({ ...b, label: `бандл ${b.name}`, site: undefined as string | undefined })),
    ...d.sites.filter((s) => !(s.pageLoads === 0 && s.avgLoads > 0)).map((s) => ({ ...s, label: s.name, site: s.name as string | undefined })),
  ].map((x) => ({ ...x, diff: x.revenue - x.avgRevenue, p: delta(x.revenue, x.avgRevenue, "percent") }))
    .filter((x) => x.p != null && x.p <= -DROP_PCT && -x.diff >= minAmount)
    .sort((a, b) => a.diff - b.diff);
  for (const x of drops) out.push({ icon: "🟡", site: x.site, text: `<b>${esc(x.label)}</b>: выручка ${usd(x.revenue)} вместо обычных ${usd(x.avgRevenue)} (${pct(x.p)}, ${signedUsd(x.diff)}).` });
  return out;
}

/** Alert groups that go into the digest: every critical group; warnings only when something new appeared. */
export const digestAlertGroups = (d: DigestData) => [
  ...d.alerts.filter((a) => a.level === "CRITICAL"),
  ...d.alerts.filter((a) => a.level === "WARNING" && a.newCount > 0),
];

/** Sites that moved notably against their 7-day average and are not already listed as a problem. */
export function digestChanges(d: DigestData, minAmount: number = DIGEST_DEFAULTS.minAmount, skip: Set<string> = new Set()) {
  if (d.baseDays === 0) return { up: [], down: [] };
  const moved = d.sites.filter((s) => !skip.has(s.name))
    .map((s) => ({ name: s.name, diff: s.revenue - s.avgRevenue, p: delta(s.revenue, s.avgRevenue, "percent") }))
    .filter((x) => Math.abs(x.diff) >= minAmount && (x.p == null ? x.diff > 0 : Math.abs(x.p) >= CHANGE_PCT));
  return { up: moved.filter((x) => x.diff > 0).sort((a, b) => b.diff - a.diff), down: moved.filter((x) => x.diff < 0).sort((a, b) => a.diff - b.diff) };
}

/**
 * The alert title without the words the group heading already says:
 * "Дискрепанси -132.2%: TrafficStars на x.com" → "TrafficStars на x.com (−132.2%)", "Убыточное гео FR на x.com" → "FR на x.com".
 */
export function shortTitle(rule: string, t: string): string {
  const words = (RULE_LABEL[rule] ?? "").split(" — ")[0].toLowerCase().split(" ").filter(Boolean);
  if (!words.length) return t;
  const i = t.indexOf(": ");
  if (i > 0) {
    const prefix = t.slice(0, i).split(" ");
    if (prefix[0].toLowerCase() !== words[0]) return t;
    let k = 0;
    while (k < prefix.length && k < words.length && prefix[k].toLowerCase() === words[k]) k++;
    const extra = prefix.slice(k).join(" ").replace(/^-/, "−");
    return `${t.slice(i + 2)}${extra ? ` (${extra})` : ""}`;
  }
  const tw = t.split(" ");
  let k = 0;
  while (k < tw.length - 1 && k < words.length && tw[k].toLowerCase() === words[k]) k++;
  return k === words.length ? tw.slice(k).join(" ") : t;
}

/** One alert group: heading, the first alerts in full, the rest folded, what to do. `detailed` = how many in full. */
function alertBlock(a: DigestAlert, detailed: number): string {
  const items = a.level === "WARNING" ? a.items.filter((x) => x.isNew) : a.items;
  const total = a.level === "WARNING" ? a.newCount : a.count;
  const head = [`${a.level === "CRITICAL" ? "🔴" : "🟡"} <b>${esc(RULE_LABEL[a.rule] ?? a.rule)}</b>`,
    total > 1 ? plural(total, "случай", "случая", "случаев") : "",
    Math.round(a.moneyAtRisk) > 0 ? `под риском ${usd(a.moneyAtRisk)}` : "",
    a.level === "CRITICAL" && a.newCount > 0 ? (a.newCount === total ? "новое" : `новых ${a.newCount}`) : ""].filter(Boolean).join(" · ");
  const full = (x: DigestAlertItem) => `▪️ <b>${esc(shortTitle(a.rule, x.title))}</b>${Math.round(x.moneyAtRisk) > 0 ? ` · ${usd(x.moneyAtRisk)}` : ""}\n<i>${esc(x.message)}</i>`;
  const brief = (x: DigestAlertItem) => `▪️ ${esc(shortTitle(a.rule, x.title))}${Math.round(x.moneyAtRisk) > 0 ? ` · ${usd(x.moneyAtRisk)}` : ""}`;
  const L = [head, ...items.slice(0, detailed).map(full)];
  const rest = items.slice(detailed);
  const unseen = total - items.length; // beyond what the query brought: said in words, the list is on the alerts page
  if (rest.length || unseen > 0) {
    const lines = [...rest.map(brief), ...(unseen > 0 ? [`и ещё ${plural(unseen, "случай", "случая", "случаев")} — на странице алертов`] : [])];
    L.push(`<blockquote expandable>${lines.join("\n")}</blockquote>`);
  }
  if (a.action) L.push(`👉 ${esc(a.action)}`);
  return L.join("\n");
}

/** Blocks of the digest in order. Each block is whole: messages are split only between blocks. */
function blocks(d: DigestData, o: Required<Pick<DigestOptions, "minAmount">> & DigestOptions, detailed: number): { head: string[]; problems: string[]; tail: string[] } {
  const cmp = d.baseDays > 0;
  const head: string[] = [];
  const r = romi(d.total.revenue, d.total.cost);
  const vs = cmp ? arrow(delta(d.total.revenue, d.avg.revenue, "percent")) : "";
  head.push([`📊 <b>TubeStat · ${dayLabel(d.day)}</b>`,
    ...(d.incomplete ? ["⚠️ <i>Данные за вчера загружены не полностью — цифры ещё изменятся</i>"] : []),
    "",
    `💰 Выручка <b>${usd(d.total.revenue)}</b>${vs ? `  ${vs} к ср. 7 дн.` : ""}`,
    `💸 Расход <b>${usd(d.total.cost)}</b>`,
    `📈 Маржа <b>${usd(d.total.margin)}</b>${r == null ? "" : `  ROMI ${Math.round(r)}%`}`].join("\n"));
  if (d.total.revenue > 0) {
    const sh = (v: number) => v / d.total.revenue;
    head.push(pre([
      row(["AdSpyglass", usd(d.total.mediated), bar(sh(d.total.mediated)), `${Math.round(sh(d.total.mediated) * 100)}%`], [10, 6, 10, 4]),
      row(["Фикс-дилы", usd(d.total.direct), bar(sh(d.total.direct)), `${Math.round(sh(d.total.direct) * 100)}%`], [10, 6, 10, 4]),
    ]));
  }

  const bundles = [...d.bundles].sort((a, b) => b.revenue - a.revenue);
  if (bundles.length) {
    const w = [12, 6, 6, 5];
    head.push(`🗂 <b>Бандлы</b>${d.bundlesOverlap ? " <i>(сайт может быть в нескольких)</i>" : ""}\n` + pre([
      row(["", "выруч.", "маржа", cmp ? "7 дн." : ""], w),
      ...bundles.map((b) => row([b.name, usd(b.revenue), usd(b.margin), cmp ? pct(delta(b.revenue, b.avgRevenue, "percent")) || "—" : ""], w)),
    ]));
  }

  const costs = d.costs.filter((c) => Math.round(c.cost) !== 0).sort((a, b) => b.cost - a.cost);
  const costSum = costs.reduce((a, c) => a + c.cost, 0); // display only: shares of the rows shown
  if (costs.length) {
    head.push(`🚦 <b>Расход на трафик</b>\n` + pre(costs.map((c) => row([c.title, usd(c.cost), costSum ? `${Math.round((c.cost / costSum) * 100)}%` : ""], [19, 7, 4]))));
  }

  const own = digestProblems(d, o.minAmount);
  const ch = digestChanges(d, o.minAmount, new Set(own.map((p) => p.site).filter((s): s is string => Boolean(s))));
  const moves = [...ch.up.map((x) => `▲ ${esc(x.name)} ${signedUsd(x.diff)}${x.p == null ? "" : ` (${pct(x.p)})`}`),
    ...ch.down.map((x) => `▼ ${esc(x.name)} ${signedUsd(x.diff)}${x.p == null ? "" : ` (${pct(x.p)})`}`)];
  if (moves.length) head.push(["🔀 <b>Изменения</b> <i>к среднему за 7 дней</i>", ...moves].join("\n"));

  const groups = digestAlertGroups(d);
  const problems: string[] = [];
  const crit = own.filter((p) => p.icon === "🔴").length + groups.filter((g) => g.level === "CRITICAL").length;
  const warn = own.length + groups.length - crit;
  if (own.length || groups.length) {
    problems.push(`⚠️ <b>Проблемы</b> — ${[crit ? plural(crit, "критичная", "критичные", "критичных") : "", warn ? plural(warn, "предупреждение", "предупреждения", "предупреждений") : ""].filter(Boolean).join(", ")}`
      + (own.length ? `\n\n${own.map((p) => `${p.icon} ${p.text}`).join("\n")}` : ""));
    for (const g of groups) problems.push(alertBlock(g, detailed));
  } else problems.push("✅ <b>Без просадок и сбоев</b>");

  const tail = o.appUrl ? [`<a href="${o.appUrl}/?preset=yesterday">Открыть сводку</a>${groups.length ? ` · <a href="${o.appUrl}/alerts">Все алерты</a>` : ""}`] : [];
  return { head, problems, tail };
}

/** Packs blocks into messages of at most `max` characters, splitting only between blocks. */
function pack(parts: string[], max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const p of parts) {
    const next = cur ? `${cur}\n\n${p}` : p;
    if (next.length <= max || !cur) cur = next;
    else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The digest as Telegram HTML messages — usually one. Longer than one message: the numbers, then the
 * problems; alert details fold into expandable quotes before anything is split further.
 */
export function buildDigest(d: DigestData, opts: DigestOptions = {}): string[] {
  const o = { ...opts, minAmount: opts.minAmount ?? DIGEST_DEFAULTS.minAmount };
  const max = opts.maxChars ?? DIGEST_DEFAULTS.maxChars;
  for (const detailed of [DETAILED, 1, 0]) {
    const b = blocks(d, o, detailed);
    const all = [...b.head, ...b.problems, ...b.tail];
    const one = all.join("\n\n");
    if (one.length <= max) return [one];
    // Split: the numbers, then the problems (never a problem block glued to the tables of the first message).
    if (detailed === 0 || [...b.problems, ...b.tail].join("\n\n").length <= max) return [...pack(b.head, max), ...pack([...b.problems, ...b.tail], max)];
  }
  return []; // unreachable: the last step always returns
}

/** The same text without markup: the preview on the settings page (messages split by a rule). */
export const digestPlain = (html: string | string[]) => (Array.isArray(html) ? html : [html]).map((m) => m
  .replace(/<a href="[^"]*">([^<]*)<\/a>/g, "$1 →").replace(/<blockquote expandable>/g, "").replace(/<\/blockquote>/g, "")
  .replace(/<\/?(b|i|pre)>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")).join("\n\n— — —\n\n");
