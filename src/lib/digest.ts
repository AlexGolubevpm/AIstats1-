// The morning Telegram digest (ADR 0022): yesterday in Telegram HTML. Pure text building — what gets
// a line and in which order. Numbers come ready from SQL (src/server/queries/digest.ts); nothing here
// adds money up, it only compares and formats. Nothing is cut to "…and N more": long lists fold into
// an expandable quote, and a digest longer than one Telegram message goes out as several.
import { FORMAT_LABEL } from "@/lib/labels";
import { delta, romi } from "@/lib/metrics";

export interface DigestLine { name: string; revenue: number; margin: number; prevRevenue: number }
export interface DigestSite extends DigestLine { pageLoads: number; prevLoads: number }
export interface DigestAlertItem { title: string; message: string; moneyAtRisk: number; isNew: boolean }
/** Active alerts of one rule and level: how many, how many new, the money at risk, what to do, the alerts themselves (new and costly first). */
export interface DigestAlert { level: "CRITICAL" | "WARNING"; rule: string; count: number; newCount: number; moneyAtRisk: number; action: string; items: DigestAlertItem[] }
export interface DigestData {
  day: string;
  /** 1 when the day before `day` has data — the comparison base (the digest goes day after day); 0 — nothing to compare with. */
  baseDays: number;
  total: { revenue: number; mediated: number; direct: number; cost: number; margin: number };
  /** The day before: what every «▲ / ▼» compares with. */
  prev: { revenue: number; cost: number; margin: number };
  bundles: DigestLine[];
  /** AdSpyglass revenue by format (ADOK ad_type cut, zones where it is missing): fix deals are not in it. */
  formats: { format: string; revenue: number; prevRevenue: number }[];
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
  /** A change smaller than this many dollars is noise. */
  minAmount?: number;
  /** A problem shows only when it costs at least this many dollars a day; the rest is one link to the alerts. */
  problemMin?: number;
  /** One Telegram message holds 4 096 characters; a margin for entities. */
  maxChars?: number;
}

export const DIGEST_DEFAULTS = { minAmount: 30, problemMin: 10, maxChars: 4000 } as const;
/** Days each alert rule counts its money at risk over (src/server/domain/alerts/rules.ts): the digest speaks in $ a day. */
export const RISK_DAYS: Record<string, number> = {
  loss_geo: 7, waterfall_inversion: 7, invisible_zone: 7, low_fill: 7, source_unconfigured: 7, discrepancy: 2, dead_zone: 30, deal_ending: 30,
  overdue_payment: 1, // a debt is due at once: the whole sum counts
};
/** Rules shown whatever the money: while they are on, the numbers of the digest themselves are wrong. */
export const ALWAYS_SHOWN = new Set(["ingest_down"]);
export const perDay = (rule: string, money: number) => money / (RISK_DAYS[rule] ?? 7);
/** Notable change of a site against the day before, in percent. */
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
/** "15.11" — the day before `day`, the comparison base. */
export const prevLabel = (day: string) => { const d = new Date(new Date(`${day}T00:00:00Z`).getTime() - 86_400_000); return `${String(d.getUTCDate()).padStart(2, "0")}.${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
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
export function digestProblems(d: DigestData, problemMin: number = DIGEST_DEFAULTS.problemMin): DigestProblem[] {
  const out: DigestProblem[] = d.health.map((text) => ({ icon: "🔴" as const, text: esc(text) }));
  if (d.baseDays === 0) return out;
  for (const s of d.sites) {
    if (s.pageLoads === 0 && s.prevLoads > 0 && s.prevRevenue >= problemMin) {
      out.push({ icon: "🔴", site: s.name, text: `<b>${esc(s.name)}</b> не отдал ни одной загрузки. ${prevLabel(d.day)} было ${group(s.prevLoads)} загрузок и ${usd(s.prevRevenue)} — проверьте сайт и код ADOK.` });
    }
  }
  const net = delta(d.total.revenue, d.prev.revenue, "percent");
  if (net != null && net <= -DROP_PCT && d.prev.revenue - d.total.revenue >= problemMin) out.push({ icon: "🔴", text: `<b>Выручка сети упала на ${Math.round(-net)}%</b>: ${usd(d.total.revenue)} против ${usd(d.prev.revenue)} ${prevLabel(d.day)}.` });
  const drops = [
    ...d.bundles.map((b) => ({ ...b, label: `бандл ${b.name}`, site: undefined as string | undefined })),
    ...d.sites.filter((s) => !(s.pageLoads === 0 && s.prevLoads > 0)).map((s) => ({ ...s, label: s.name, site: s.name as string | undefined })),
  ].map((x) => ({ ...x, diff: x.revenue - x.prevRevenue, p: delta(x.revenue, x.prevRevenue, "percent") }))
    .filter((x) => x.p != null && x.p <= -DROP_PCT && -x.diff >= problemMin)
    .sort((a, b) => a.diff - b.diff);
  for (const x of drops) out.push({ icon: "🟡", site: x.site, text: `<b>${esc(x.label)}</b>: выручка ${usd(x.revenue)} против ${usd(x.prevRevenue)} ${prevLabel(d.day)} (${pct(x.p)}, ${signedUsd(x.diff)}).` });
  return out;
}

/**
 * Alerts that go into the digest: worth at least `problemMin` a day (or a rule shown whatever the money),
 * grouped as they come; `hidden` — active alerts below the bar, said as one link to the alerts page.
 */
export function digestAlertGroups(d: DigestData, problemMin: number = DIGEST_DEFAULTS.problemMin): { groups: (DigestAlert & { shown: DigestAlertItem[] })[]; hidden: number } {
  let total = 0, shown = 0;
  const groups = [];
  for (const a of d.alerts) {
    total += a.count;
    const items = a.items.filter((x) => ALWAYS_SHOWN.has(a.rule) || perDay(a.rule, x.moneyAtRisk) >= problemMin);
    shown += items.length;
    if (items.length) groups.push({ ...a, shown: items });
  }
  return { groups, hidden: total - shown };
}

/** Sites that moved notably against the day before and are not already listed as a problem. */
export function digestChanges(d: DigestData, minAmount: number = DIGEST_DEFAULTS.minAmount, skip: Set<string> = new Set()) {
  if (d.baseDays === 0) return { up: [], down: [] };
  const moved = d.sites.filter((s) => !skip.has(s.name))
    .map((s) => ({ name: s.name, diff: s.revenue - s.prevRevenue, p: delta(s.revenue, s.prevRevenue, "percent") }))
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

/** One alert group: heading, the first alerts in full, the rest folded, what to do. `detailed` = how many in full. Money in $ a day. */
function alertBlock(a: DigestAlert & { shown: DigestAlertItem[] }, detailed: number): string {
  const items = a.shown;
  const day = (m: number) => (a.rule === "overdue_payment" ? usd(m) : `≈${usd(perDay(a.rule, m))}/день`);
  const sum = items.reduce((t, x) => t + x.moneyAtRisk, 0); // display only: the alerts' own estimates
  const fresh = items.filter((x) => x.isNew).length;
  const head = [`${a.level === "CRITICAL" ? "🔴" : "🟡"} <b>${esc(RULE_LABEL[a.rule] ?? a.rule)}</b>`,
    items.length > 1 ? plural(items.length, "случай", "случая", "случаев") : "",
    Math.round(sum) > 0 ? day(sum) : "",
    fresh ? (fresh === items.length ? (items.length > 1 ? "все новые" : "новое") : `новых ${fresh}`) : ""].filter(Boolean).join(" · ");
  const money = (x: DigestAlertItem) => (Math.round(x.moneyAtRisk) > 0 ? ` · ${day(x.moneyAtRisk)}` : "");
  const full = (x: DigestAlertItem) => `▪️ <b>${esc(shortTitle(a.rule, x.title))}</b>${money(x)}\n<i>${esc(x.message)}</i>`;
  const brief = (x: DigestAlertItem) => `▪️ ${esc(shortTitle(a.rule, x.title))}${money(x)}`;
  const L = [head, ...items.slice(0, detailed).map(full)];
  const rest = items.slice(detailed);
  if (rest.length) L.push(`<blockquote expandable>${rest.map(brief).join("\n")}</blockquote>`);
  if (a.action) L.push(`👉 ${esc(a.action)}`);
  return L.join("\n");
}

/** Blocks of the digest in order. Each block is whole: messages are split only between blocks. */
function blocks(d: DigestData, o: Required<Pick<DigestOptions, "minAmount" | "problemMin">> & DigestOptions, detailed: number): { head: string[]; problems: string[]; tail: string[] } {
  const cmp = d.baseDays > 0;
  const head: string[] = [];
  const r = romi(d.total.revenue, d.total.cost);
  const vs = cmp ? arrow(delta(d.total.revenue, d.prev.revenue, "percent")) : "";
  head.push([`📊 <b>TubeStat · ${dayLabel(d.day)}</b>`,
    ...(d.incomplete ? ["⚠️ <i>Данные за вчера загружены не полностью — цифры ещё изменятся</i>"] : []),
    "",
    `💰 Выручка <b>${usd(d.total.revenue)}</b>${vs ? `  ${vs} к ${prevLabel(d.day)}` : ""}`,
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
      row(["", "выруч.", "маржа", cmp ? prevLabel(d.day) : ""], w),
      ...bundles.map((b) => row([b.name, usd(b.revenue), usd(b.margin), cmp ? pct(delta(b.revenue, b.prevRevenue, "percent")) || "—" : ""], w)),
    ]));
  }

  const formats = d.formats.filter((f) => Math.round(f.revenue) !== 0 || Math.round(f.prevRevenue) !== 0).sort((a, b) => b.revenue - a.revenue);
  const fmtSum = formats.reduce((t, f) => t + f.revenue, 0); // display only: shares of the rows shown
  if (formats.length) {
    const w = [12, 6, 5, 5];
    head.push(`🧩 <b>Форматы</b> <i>(AdSpyglass, без фикс-дилов)</i>\n` + pre([
      row(["", "выруч.", "доля", cmp ? prevLabel(d.day) : ""], w),
      ...formats.map((f) => row([FORMAT_LABEL[f.format] ?? f.format, usd(f.revenue), fmtSum > 0 ? `${Math.round((f.revenue / fmtSum) * 100)}%` : "",
        cmp ? pct(delta(f.revenue, f.prevRevenue, "percent")) || "—" : ""], w)),
    ]));
  }

  const costs = d.costs.filter((c) => Math.round(c.cost) !== 0).sort((a, b) => b.cost - a.cost);
  const costSum = costs.reduce((a, c) => a + c.cost, 0); // display only: shares of the rows shown
  if (costs.length) {
    head.push(`🚦 <b>Расход на трафик</b>\n` + pre(costs.map((c) => row([c.title, usd(c.cost), costSum ? `${Math.round((c.cost / costSum) * 100)}%` : ""], [19, 7, 4]))));
  }

  const own = digestProblems(d, o.problemMin);
  const ch = digestChanges(d, o.minAmount, new Set(own.map((p) => p.site).filter((s): s is string => Boolean(s))));
  const moves = [...ch.up.map((x) => `▲ ${esc(x.name)} ${signedUsd(x.diff)}${x.p == null ? "" : ` (${pct(x.p)})`}`),
    ...ch.down.map((x) => `▼ ${esc(x.name)} ${signedUsd(x.diff)}${x.p == null ? "" : ` (${pct(x.p)})`}`)];
  if (moves.length) head.push([`🔀 <b>Изменения</b> <i>к ${prevLabel(d.day)}</i>`, ...moves].join("\n"));

  const { groups, hidden } = digestAlertGroups(d, o.problemMin);
  const problems: string[] = [];
  const crit = own.filter((p) => p.icon === "🔴").length + groups.filter((g) => g.level === "CRITICAL").length;
  const warn = own.length + groups.length - crit;
  const alertsLink = (text: string) => (o.appUrl ? `<a href="${o.appUrl}/alerts">${text}</a>` : text);
  const small = hidden > 0 ? `${plural(hidden, "алерт", "алерта", "алертов")} меньше ${usd(o.problemMin)}/день` : "";
  if (own.length || groups.length) {
    problems.push(`⚠️ <b>Проблемы от ${usd(o.problemMin)}/день</b> — ${[crit ? plural(crit, "критичная", "критичные", "критичных") : "", warn ? plural(warn, "предупреждение", "предупреждения", "предупреждений") : ""].filter(Boolean).join(", ")}`
      + (own.length ? `\n\n${own.map((p) => `${p.icon} ${p.text}`).join("\n")}` : ""));
    for (const g of groups) problems.push(alertBlock(g, detailed));
    if (small) problems.push(`ℹ️ Ещё ${small} — ${alertsLink("все алерты")}`);
  } else problems.push(`✅ <b>Крупных проблем нет</b>${small ? ` · ${small} — ${alertsLink("все алерты")}` : ""}`);

  const tail = o.appUrl ? [`<a href="${o.appUrl}/?preset=yesterday">Открыть сводку</a>`] : [];
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
  const o = { ...opts, minAmount: opts.minAmount ?? DIGEST_DEFAULTS.minAmount, problemMin: opts.problemMin ?? DIGEST_DEFAULTS.problemMin };
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
