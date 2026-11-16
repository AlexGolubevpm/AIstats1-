import { describe, expect, it } from "vitest";
import { RISK_DAYS, RULE_LABEL, TABLE_WIDTH, perDay, planBlock, prevLabel, reportWords, shortTitle, buildDigest, dayLabel, digestChanges, digestPlain, digestProblems, plural, usd, type DigestAlert, type DigestData } from "@/lib/digest";

const base = (over: Partial<DigestData> = {}): DigestData => ({
  day: "2026-11-15", baseDays: 7,
  total: { revenue: 4210, mediated: 3650, direct: 560, cost: 1380, margin: 2830 },
  prev: { revenue: 3970, cost: 1300, margin: 2670 },
  bundles: [
    { name: "Gay", revenue: 1420, margin: 980, prevRevenue: 1200 },
    { name: "Asian", revenue: 1105, margin: 640, prevRevenue: 1140 },
  ],
  bundlesOverlap: false,
  formats: [{ format: "POPUNDER", revenue: 2100, prevRevenue: 1980 }, { format: "BANNER", revenue: 900, prevRevenue: 940 }, { format: "OTHER", revenue: 0, prevRevenue: 0 }],
  sites: [
    { name: "gay-tube.com", revenue: 830, margin: 600, prevRevenue: 620, pageLoads: 90_000, prevLoads: 80_000 },
    { name: "japan-tube.com", revenue: 500, margin: 300, prevRevenue: 640, pageLoads: 50_000, prevLoads: 60_000 },
    { name: "quiet.com", revenue: 100, margin: 60, prevRevenue: 98, pageLoads: 10_000, prevLoads: 10_000 },
  ],
  costs: [{ title: "TubeCrown", cost: 820 }, { title: "TrafficX", cost: 410 }, { title: "A", cost: 100 }, { title: "B", cost: 50 }],
  alerts: [], health: [], incomplete: false, ...over,
});
const item = (title: string, money = 0, isNew = true, message = `Подробности: ${title}`) => ({ title, message, moneyAtRisk: money, isNew });
const alert = (over: Partial<DigestAlert>): DigestAlert => ({ level: "WARNING", rule: "discrepancy", count: 1, newCount: 1, moneyAtRisk: 0, action: "Сверить счётчики.", items: [], ...over });
const tags = (html: string) => ["b", "i", "pre", "blockquote"].every((t) => (html.match(new RegExp(`<${t}[ >]`, "g")) ?? []).length === (html.match(new RegExp(`</${t}>`, "g")) ?? []).length);

describe("digest text", () => {
  it("one message: the date in words, KPIs, the AdSpyglass / fix-deal split with bars, every bundle and cost source in tables, changes, no problems", () => {
    const msgs = buildDigest(base(), { appUrl: "https://stat.test" });
    expect(msgs).toHaveLength(1);
    expect(digestPlain(msgs).split("\n")).toEqual([
      "📊 TubeStat · воскресенье, 15 ноября",
      "",
      "💰 Выручка $4 210  ▲ 6% к 14.11",
      "💸 Расход $1 380",
      "📈 Маржа $2 830  ROMI 205%",
      "",
      "AdSpyglass $3 650 ▓▓▓▓▓▓▓▓▓░  87%",
      "Фикс-дилы    $560 ▓░░░░░░░░░  13%",
      "",
      "🗂 Бандлы",
      "             выруч.  маржа 14.11",
      "Gay          $1 420   $980  +18%",
      "Asian        $1 105   $640   −3%",
      "",
      "🧩 Форматы (AdSpyglass, без фикс-дилов)",
      "             выруч.  доля 14.11",
      "Popunder     $2 100   70%   +6%",
      "Баннер         $900   30%   −4%",
      "",
      "🚦 Расход на трафик",
      "TubeCrown              $820  59%",
      "TrafficX               $410  30%",
      "A                      $100   7%",
      "B                       $50   4%",
      "",
      "🔀 Изменения к 14.11",
      "▲ gay-tube.com +$210 (+34%)",
      "▼ japan-tube.com −$140 (−22%)",
      "",
      "✅ Крупных проблем нет",
      "",
      "Открыть сводку →",
    ]);
    expect(msgs[0]).toContain("<pre>             выруч.  маржа 14.11\nGay          $1 420   $980  +18%"); // tables are monospace blocks
    expect(msgs[0]).toContain('<a href="https://stat.test/?preset=yesterday">Открыть сводку</a>');
    expect(buildDigest(base())[0]).not.toContain("<a "); // no public address — no links
  });

  it("no «…и ещё N»: all bundles are listed; tables stay within the phone width; long names are shortened; names are escaped", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `B<${i}> & a very long bundle name`, revenue: 1000 - i * 10, margin: 500, prevRevenue: 1000 }));
    const [msg] = buildDigest(base({ bundles: many, bundlesOverlap: true }));
    expect(msg).not.toMatch(/ещё \d/);
    expect(msg).toContain("(сайт может быть в нескольких)");
    const table = digestPlain(msg).split("🗂")[1].split("\n\n")[0].split("\n").slice(2);
    expect(table).toHaveLength(9);
    expect(table[0]).toBe("B<0> & a ve… $1 000   $500    0%");
    for (const block of msg.match(/<pre>[\s\S]*?<\/pre>/g)!) for (const line of digestPlain(block).split("\n")) expect(line.length).toBeLessThanOrEqual(TABLE_WIDTH);
    expect(msg).toContain("B&lt;0&gt; &amp; a ve…");
  });

  it("changes need both 20% and the dollar threshold; a higher threshold silences them", () => {
    expect(digestChanges(base()).up.map((x) => x.name)).toEqual(["gay-tube.com"]); // quiet.com: +$2 is noise
    expect(digestChanges(base(), 500)).toEqual({ up: [], down: [] });
    expect(digestChanges(base({ baseDays: 0 }))).toEqual({ up: [], down: [] }); // nothing to compare with
  });

  it("own problems explain themselves: the load, a site that stopped, the network drop, bundle and site drops — and the site is not repeated as a change", () => {
    const d = base({
      total: { revenue: 2000, mediated: 1800, direct: 200, cost: 900, margin: 1100 },
      health: ["AdSpyglass на паузе до 07:00 UTC: 429"],
      sites: [
        { name: "dead.com", revenue: 0, margin: 0, prevRevenue: 300, pageLoads: 0, prevLoads: 40_000 },
        { name: "japan-tube.com", revenue: 300, margin: 100, prevRevenue: 640, pageLoads: 30_000, prevLoads: 60_000 },
        { name: "small.com", revenue: 5, margin: 5, prevRevenue: 12, pageLoads: 100, prevLoads: 400 }, // −58% but $7 a day: below $10
      ],
      bundles: [{ name: "Asian", revenue: 500, margin: 200, prevRevenue: 1100 }],
    });
    expect(digestProblems(d, 400).map((p) => p.text)).toEqual([ // a high bar: only the load (always) and what loses $400+ a day
      "AdSpyglass на паузе до 07:00 UTC: 429",
      "<b>Выручка сети упала на 50%</b>: $2 000 против $3 970 14.11.",
      "<b>бандл Asian</b>: выручка $500 против $1 100 14.11 (−55%, −$600).",
    ]);
    expect(digestProblems(d).map((p) => `${p.icon} ${p.text}`)).toEqual([
      "🔴 AdSpyglass на паузе до 07:00 UTC: 429",
      "🔴 <b>dead.com</b> не отдал ни одной загрузки. 14.11 было 40 000 загрузок и $300 — проверьте сайт и код ADOK.",
      "🔴 <b>Выручка сети упала на 50%</b>: $2 000 против $3 970 14.11.",
      "🟡 <b>бандл Asian</b>: выручка $500 против $1 100 14.11 (−55%, −$600).",
      "🟡 <b>japan-tube.com</b>: выручка $300 против $640 14.11 (−53%, −$340).",
    ]);
    const t = digestPlain(buildDigest(d));
    expect(t).toContain("⚠️ Проблемы от $10/день — 3 критичные, 2 предупреждения");
    expect(t).not.toContain("▼ japan-tube.com"); // listed as a problem — not again as a change
    expect(t).not.toContain("✅");
    expect(t).not.toContain("small.com");
  });

  it("alerts: only what costs $10+ a day, in $ a day; the rest is one link; the rule in words, two in full, the rest folded, what to do", () => {
    const d = base({ alerts: [
      alert({ level: "CRITICAL", rule: "deal_ending", count: 2, newCount: 1, moneyAtRisk: 375, action: "Продлить дил.", items: [
        item("Фикс-дил «Banner» закончился 7 дн. назад", 300, true, "Flat $10/день · hentaismile.com · до 2026-11-08."), // $300 / 30 days = $10 a day
        item("Фикс-дил «Small» закончился", 75, false)] }), // $2.5 a day — below the bar
      alert({ rule: "discrepancy", count: 6, newCount: 4, moneyAtRisk: 200, items: [ // window 2 days
        item("Дискрепанси -132.2%: TrafficStars на pride.com", 90), item("Дискрепанси -35.5%: TrafficStars на adult.com", 40, false),
        item("Дискрепанси -30.0%: TrafficStars на a<b>.com", 30), item("Дискрепанси -21.0%: TrafficStars на c.com", 20),
        item("Дискрепанси -40.0%: TrafficStars на d.com", 10), item("Дискрепанси -41.0%: TrafficStars на e.com", 10, false)] }),
      alert({ rule: "low_fill", count: 3, newCount: 0, items: [item("Низкий фил на x.com", 60, false)] }), // $60 over 7 days — below
      alert({ level: "CRITICAL", rule: "ingest_down", count: 1, newCount: 0, action: "Проверить ключи.", items: [item("Ингест metrika не работает", 0, false, "Последний запуск упал.")] }),
    ] });
    const [msg] = buildDigest(d, { appUrl: "https://stat.test" });
    const t = digestPlain(msg);
    expect(t).toContain(`🔴 ${RULE_LABEL.deal_ending} · ≈$10/день · новое\n▪️ Фикс-дил «Banner» закончился 7 дн. назад · ≈$10/день\nFlat $10/день · hentaismile.com · до 2026-11-08.\n👉 Продлить дил.`);
    expect(t).not.toContain("«Small»");
    expect(t).toContain(`🟡 ${RULE_LABEL.discrepancy} · 4 случая · ≈$90/день · новых 3\n▪️ TrafficStars на pride.com (−132.2%) · ≈$45/день`);
    expect(msg).toContain("<blockquote expandable>▪️ TrafficStars на a&lt;b&gt;.com (−30.0%) · ≈$15/день\n▪️ TrafficStars на c.com (−21.0%) · ≈$10/день</blockquote>\n👉 Сверить счётчики.");
    expect(t).not.toContain("d.com");
    expect(t).not.toContain(RULE_LABEL.low_fill);
    expect(t).toContain(`🔴 ${RULE_LABEL.ingest_down}\n▪️ Ингест metrika не работает`); // shown whatever the money
    expect(t).toContain("⚠️ Проблемы от $10/день — 2 критичные, 1 предупреждение");
    expect(t).toContain("ℹ️ Ещё 6 алертов меньше $10/день — все алерты →"); // 12 active − 6 shown
    expect(msg).toContain('<a href="https://stat.test/alerts">все алерты</a>');
    expect(tags(msg)).toBe(true);
    // A higher bar from the settings: nothing passes but the always-shown rule.
    expect(digestPlain(buildDigest(d, { problemMin: 1000 }))).toContain("ℹ️ Ещё 11 алертов меньше $1 000/день — все алерты");
    // Nothing big at all.
    expect(digestPlain(buildDigest(base({ alerts: [alert({ rule: "low_fill", count: 3, items: [item("x", 7)] })] }), { appUrl: "https://stat.test" })))
      .toContain("✅ Крупных проблем нет · 3 алерта меньше $10/день — все алерты →");
    expect([perDay("loss_geo", 70), perDay("discrepancy", 20), perDay("dead_zone", 300), perDay("overdue_payment", 50), perDay("new_rule", 70)]).toEqual([10, 10, 10, 50, 10]);
    expect(RISK_DAYS.deal_ending).toBe(30);
  });

  it("a long day: alert details fold first; still too long — the numbers and the problems go as separate messages, each within the limit, tags closed", () => {
    const long = (i: number) => item(`Убыточное гео ${i} на site-${i}.com`, 500 - i, true, "За 7 дней выручка $120.00 при расходе $180.00 (ROMI −33.3%, 40 000 загрузок). ".repeat(3));
    const groups = ["loss_geo", "waterfall_inversion", "dead_zone", "invisible_zone", "overdue_payment"].map((rule) =>
      alert({ level: "CRITICAL", rule, count: 20, newCount: 20, moneyAtRisk: 500, items: Array.from({ length: 20 }, (_, i) => long(i)) }));
    const msgs = buildDigest(base({ alerts: groups, bundles: Array.from({ length: 30 }, (_, i) => ({ name: `Bundle ${i}`, revenue: 100, margin: 50, prevRevenue: 100 })) }));
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) { expect(m.length).toBeLessThanOrEqual(4000); expect(tags(m)).toBe(true); }
    expect(msgs[0]).toContain("📊 <b>TubeStat");
    expect(msgs.slice(1).join("")).toContain("⚠️ <b>Проблемы от $10/день</b>");
    const all = msgs.join("\n");
    for (const rule of ["loss_geo", "waterfall_inversion", "dead_zone", "invisible_zone", "overdue_payment"]) expect(all).toContain(RULE_LABEL[rule]); // nothing dropped
    expect(all).toContain("19 на site-19.com"); // the 20th alert of a group is there, folded
  });

  it("incomplete data is said under the date; without a comparison base there are no deltas and no changes", () => {
    const t = digestPlain(buildDigest(base({ incomplete: true, baseDays: 0 })));
    expect(t).toContain("Popunder     $2 100   70%"); // formats still listed, without the 7-day column
    expect(t.split("\n")[1]).toBe("⚠️ Данные за вчера загружены не полностью — цифры ещё изменятся");
    expect(t).not.toContain("к 14.11");
    expect(t).not.toContain("Изменения");
  });

  it("short titles drop what the group heading already says", () => {
    expect(shortTitle("discrepancy", "Дискрепанси -132.2%: TrafficStars на x.com")).toBe("TrafficStars на x.com (−132.2%)");
    expect(shortTitle("waterfall_inversion", "Инверсия waterfall: ExoClick на x.com")).toBe("ExoClick на x.com");
    expect(shortTitle("loss_geo", "Убыточное гео FR на x.com")).toBe("FR на x.com");
    expect(shortTitle("invisible_zone", "Зона не видна: DM_Footer_A на x.com")).toBe("DM_Footer_A на x.com");
    expect(shortTitle("overdue_payment", "Просрочена оплата: VidPromo, «Tier-1»")).toBe("VidPromo, «Tier-1»");
    expect(shortTitle("ingest_down", "Метрика: ингест упал")).toBe("Метрика: ингест упал"); // the heading does not say it — kept
    expect(shortTitle("low_fill", "Низкий фил слайдера на x.com")).toBe("Низкий фил слайдера на x.com");
    expect(shortTitle("unknown_rule", "Что-то: где-то")).toBe("Что-то: где-то");
  });

  it("the margin plan: a bar, how much of the month's operating expenses is covered, ahead of or behind the straight-line schedule, the result at the month end", () => {
    const plan = (over = {}) => ({ month: "2026-11-01", target: 12_000, margin: 9_800, asOf: "2026-11-16", copiedFrom: null, ...over });
    expect(digestPlain(planBlock(plan())).split("\n")).toEqual([
      "🎯 План по марже · ноябрь (опер. расходы: сервера, зарплаты)",
      "▓▓▓▓▓▓▓▓░░  82%",
      "Закрыто $9 800 из $12 000 на 16.11",
      "По графику к 16.11 — $6 400: опережаем на $3 400", // 12 000 × 16 / 30
    ]);
    expect(digestPlain(planBlock(plan({ margin: 5_000 })))).toContain("По графику к 16.11 — $6 400: отстаём на $1 400");
    expect(digestPlain(planBlock(plan({ asOf: "2026-11-30", margin: 12_480 })))).toContain("▓▓▓▓▓▓▓▓▓▓ 104%\nЗакрыто $12 480 из $12 000 на 30.11\n✅ План месяца выполнен: +$480 сверх расходов");
    expect(digestPlain(planBlock(plan({ asOf: "2026-11-30", margin: 11_000 })))).toContain("❌ Не хватило $1 000 до покрытия расходов");
    expect(digestPlain(planBlock(plan({ copiedFrom: "2026-10-01" })))).toContain("План — как в октябре: опер. расходы на ноябрь не внесены");
    // In the daily digest: right after the AdSpyglass / fix-deal split.
    const t = digestPlain(buildDigest(base({ plan: plan({ asOf: "2026-11-15" }) })));
    expect(t).toMatch(/Фикс-дилы .*\n\n🎯 План по марже · ноябрь/);
    expect(digestPlain(buildDigest(base({ plan: plan({ target: 0 }) })))).not.toContain("🎯"); // nothing entered anywhere — no plan line
  });

  it("week and month reports: their own title and comparison, money columns widen, no problem list — one line about the alerts; changes need a bar × days", () => {
    expect(reportWords({ day: "2026-11-15", kind: "week", from: "2026-11-09" })).toMatchObject({ title: "📅 <b>TubeStat · неделя 9–15 ноября</b>", col: "пр.нед", to: "к прошлой неделе" });
    expect(reportWords({ day: "2026-11-01", kind: "week", from: "2026-10-26" }).title).toBe("📅 <b>TubeStat · неделя 26 октября – 1 ноября</b>");
    expect(reportWords({ day: "2026-10-31", kind: "month", from: "2026-10-01" })).toMatchObject({ title: "🗓 <b>TubeStat · октябрь 2026</b>", col: "сен.", to: "к сентябрю" });
    expect(reportWords({ day: "2026-01-31", kind: "month" }).to).toBe("к декабрю");
    const week = base({ kind: "week", from: "2026-11-09", day: "2026-11-15",
      total: { revenue: 123_456, mediated: 120_000, direct: 3_456, cost: 50_000, margin: 73_456 }, prev: { revenue: 100_000, cost: 40_000, margin: 60_000 },
      bundles: [{ name: "Gay", revenue: 104_567, margin: 51_234, prevRevenue: 99_000 }],
      alerts: [{ level: "CRITICAL", rule: "loss_geo", count: 3, newCount: 1, moneyAtRisk: 900, action: "a", items: [item("Убыточное гео FR на x.com", 700)] }] });
    const [msg] = buildDigest(week, { appUrl: "https://stat.test", minAmount: 31 });
    const t = digestPlain(msg);
    expect(t).toContain("💰 Выручка $123 456  ▲ 23% к прошлой неделе");
    expect(t).toContain("            выруч.    маржа пр.нед\nGay       $104 567  $51 234    +6%"); // wider money, a narrower name column
    for (const block of msg.match(/<pre>[\s\S]*?<\/pre>/g)!) for (const line of digestPlain(block).split("\n")) expect(line.length).toBeLessThanOrEqual(TABLE_WIDTH);
    expect(t).toContain("⚠️ Сейчас 3 активных алерта, от $10/день — 1 — все алерты →");
    expect(t).not.toContain("👉");
    expect(t).not.toContain("▲ gay-tube.com"); // +$210 over a week is below $31 × 7
    expect(digestPlain(buildDigest(week, { minAmount: 30 }))).toContain("▲ gay-tube.com +$210"); // $30 × 7 = $210: just enough
    expect(msg).toContain('<a href="https://stat.test/?from=2026-11-09&to=2026-11-15">Открыть сводку</a>');
  });

  it("words and money: date, plurals, whole dollars with a real minus", () => {
    expect([dayLabel("2026-11-15"), dayLabel("2026-01-01")]).toEqual(["воскресенье, 15 ноября", "четверг, 1 января"]);
    expect([prevLabel("2026-11-16"), prevLabel("2026-01-01"), prevLabel("2026-03-01")]).toEqual(["15.11", "31.12", "28.02"]); // the comparison day
    expect([1, 2, 5, 11, 21, 104].map((n) => plural(n, "случай", "случая", "случаев"))).toEqual(["1 случай", "2 случая", "5 случаев", "11 случаев", "21 случай", "104 случая"]);
    expect([usd(4210.4), usd(-140.2), usd(0), usd(-0.3), usd(1234567)]).toEqual(["$4 210", "−$140", "$0", "$0", "$1 234 567"]);
  });
});
