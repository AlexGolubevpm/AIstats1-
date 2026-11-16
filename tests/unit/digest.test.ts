import { describe, expect, it } from "vitest";
import { RULE_LABEL, TABLE_WIDTH, shortTitle, buildDigest, dayLabel, digestChanges, digestPlain, digestProblems, plural, usd, type DigestAlert, type DigestData } from "@/lib/digest";

const base = (over: Partial<DigestData> = {}): DigestData => ({
  day: "2026-11-15", baseDays: 7,
  total: { revenue: 4210, mediated: 3650, direct: 560, cost: 1380, margin: 2830 },
  avg: { revenue: 3970, cost: 1300, margin: 2670 },
  bundles: [
    { name: "Gay", revenue: 1420, margin: 980, avgRevenue: 1200 },
    { name: "Asian", revenue: 1105, margin: 640, avgRevenue: 1140 },
  ],
  bundlesOverlap: false,
  sites: [
    { name: "gay-tube.com", revenue: 830, margin: 600, avgRevenue: 620, pageLoads: 90_000, avgLoads: 80_000 },
    { name: "japan-tube.com", revenue: 500, margin: 300, avgRevenue: 640, pageLoads: 50_000, avgLoads: 60_000 },
    { name: "quiet.com", revenue: 100, margin: 60, avgRevenue: 98, pageLoads: 10_000, avgLoads: 10_000 },
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
      "💰 Выручка $4 210  ▲ 6% к ср. 7 дн.",
      "💸 Расход $1 380",
      "📈 Маржа $2 830  ROMI 205%",
      "",
      "AdSpyglass $3 650 ▓▓▓▓▓▓▓▓▓░  87%",
      "Фикс-дилы    $560 ▓░░░░░░░░░  13%",
      "",
      "🗂 Бандлы",
      "             выруч.  маржа 7 дн.",
      "Gay          $1 420   $980  +18%",
      "Asian        $1 105   $640   −3%",
      "",
      "🚦 Расход на трафик",
      "TubeCrown              $820  59%",
      "TrafficX               $410  30%",
      "A                      $100   7%",
      "B                       $50   4%",
      "",
      "🔀 Изменения к среднему за 7 дней",
      "▲ gay-tube.com +$210 (+34%)",
      "▼ japan-tube.com −$140 (−22%)",
      "",
      "✅ Без просадок и сбоев",
      "",
      "Открыть сводку →",
    ]);
    expect(msgs[0]).toContain("<pre>             выруч.  маржа 7 дн.\nGay          $1 420   $980  +18%"); // tables are monospace blocks
    expect(msgs[0]).toContain('<a href="https://stat.test/?preset=yesterday">Открыть сводку</a>');
    expect(buildDigest(base())[0]).not.toContain("<a "); // no public address — no links
  });

  it("no «…и ещё N»: all bundles are listed; tables stay within the phone width; long names are shortened; names are escaped", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `B<${i}> & a very long bundle name`, revenue: 1000 - i * 10, margin: 500, avgRevenue: 1000 }));
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
        { name: "dead.com", revenue: 0, margin: 0, avgRevenue: 300, pageLoads: 0, avgLoads: 40_000 },
        { name: "japan-tube.com", revenue: 300, margin: 100, avgRevenue: 640, pageLoads: 30_000, avgLoads: 60_000 },
        { name: "small.com", revenue: 5, margin: 5, avgRevenue: 20, pageLoads: 100, avgLoads: 400 }, // −75% but $15: noise
      ],
      bundles: [{ name: "Asian", revenue: 500, margin: 200, avgRevenue: 1100 }],
    });
    expect(digestProblems(d).map((p) => `${p.icon} ${p.text}`)).toEqual([
      "🔴 AdSpyglass на паузе до 07:00 UTC: 429",
      "🔴 <b>dead.com</b> не отдал ни одной загрузки. Обычно 40 000 загрузок и $300 в день — проверьте сайт и код ADOK.",
      "🔴 <b>Выручка сети упала на 50%</b>: $2 000 вместо обычных $3 970 в день.",
      "🟡 <b>бандл Asian</b>: выручка $500 вместо обычных $1 100 (−55%, −$600).",
      "🟡 <b>japan-tube.com</b>: выручка $300 вместо обычных $640 (−53%, −$340).",
    ]);
    const t = digestPlain(buildDigest(d));
    expect(t).toContain("⚠️ Проблемы — 3 критичные, 2 предупреждения");
    expect(t).not.toContain("▼ japan-tube.com"); // listed as a problem — not again as a change
    expect(t).not.toContain("✅");
  });

  it("an alert group: the rule in words, how many, the money, the first two in full, the rest folded in an expandable quote, what to do", () => {
    const d = base({ alerts: [
      alert({ level: "CRITICAL", rule: "deal_ending", count: 1, newCount: 1, moneyAtRisk: 75, action: "Продлить дил.",
        items: [item("Фикс-дил «Banner» закончился 7 дн. назад", 75, true, "Flat $10/день · hentaismile.com · до 2026-11-08.")] }),
      alert({ rule: "discrepancy", count: 6, newCount: 4, moneyAtRisk: 13, items: [
        item("Дискрепанси -132.2%: TrafficStars на pride.com", 9), item("Дискрепанси -35.5%: TrafficStars на adult.com", 2),
        item("Дискрепанси -30.0%: TrafficStars на a<b>.com", 1), item("Дискрепанси -21.0%: TrafficStars на c.com", 1),
        item("Дискрепанси -40.0%: TrafficStars на old.com", 5, false), item("Дискрепанси -41.0%: TrafficStars на older.com", 5, false)] }),
      alert({ rule: "low_fill", count: 3, newCount: 0, items: [item("Низкий фил на x.com", 1, false)] }), // nothing new — stays on the alerts page
    ] });
    const [msg] = buildDigest(d, { appUrl: "https://stat.test" });
    const t = digestPlain(msg);
    expect(t).toContain(`🔴 ${RULE_LABEL.deal_ending} · под риском $75 · новое\n▪️ Фикс-дил «Banner» закончился 7 дн. назад · $75\nFlat $10/день · hentaismile.com · до 2026-11-08.\n👉 Продлить дил.`);
    expect(t).toContain(`🟡 ${RULE_LABEL.discrepancy} · 4 случая · под риском $13\n▪️ TrafficStars на pride.com (−132.2%) · $9\nПодробности: Дискрепанси -132.2%: TrafficStars на pride.com\n▪️ TrafficStars на adult.com (−35.5%) · $2`);
    expect(msg).toContain("<blockquote expandable>▪️ TrafficStars на a&lt;b&gt;.com (−30.0%) · $1\n▪️ TrafficStars на c.com (−21.0%) · $1</blockquote>\n👉 Сверить счётчики.");
    expect(t).not.toContain("old.com"); // old warnings are not news
    expect(t).not.toContain(RULE_LABEL.low_fill);
    expect(t).toContain("⚠️ Проблемы — 1 критичная, 1 предупреждение");
    expect(t).toContain("Все алерты →");
    expect(tags(msg)).toBe(true);
  });

  it("a long day: alert details fold first; still too long — the numbers and the problems go as separate messages, each within the limit, tags closed", () => {
    const long = (i: number) => item(`Убыточное гео ${i} на site-${i}.com`, 50 - i, true, "За 7 дней выручка $120.00 при расходе $180.00 (ROMI −33.3%, 40 000 загрузок). ".repeat(3));
    const groups = ["loss_geo", "waterfall_inversion", "dead_zone", "invisible_zone", "overdue_payment"].map((rule) =>
      alert({ level: "CRITICAL", rule, count: 20, newCount: 20, moneyAtRisk: 500, items: Array.from({ length: 20 }, (_, i) => long(i)) }));
    const msgs = buildDigest(base({ alerts: groups, bundles: Array.from({ length: 30 }, (_, i) => ({ name: `Bundle ${i}`, revenue: 100, margin: 50, avgRevenue: 100 })) }));
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) { expect(m.length).toBeLessThanOrEqual(4000); expect(tags(m)).toBe(true); }
    expect(msgs[0]).toContain("📊 <b>TubeStat");
    expect(msgs.slice(1).join("")).toContain("⚠️ <b>Проблемы</b>");
    const all = msgs.join("\n");
    for (const rule of ["loss_geo", "waterfall_inversion", "dead_zone", "invisible_zone", "overdue_payment"]) expect(all).toContain(RULE_LABEL[rule]); // nothing dropped
    expect(all).toContain("19 на site-19.com"); // the 20th alert of a group is there, folded
  });

  it("incomplete data is said under the date; without a comparison base there are no deltas and no changes", () => {
    const t = digestPlain(buildDigest(base({ incomplete: true, baseDays: 0 })));
    expect(t.split("\n")[1]).toBe("⚠️ Данные за вчера загружены не полностью — цифры ещё изменятся");
    expect(t).not.toContain("к ср. 7 дн.");
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

  it("words and money: date, plurals, whole dollars with a real minus", () => {
    expect([dayLabel("2026-11-15"), dayLabel("2026-01-01")]).toEqual(["воскресенье, 15 ноября", "четверг, 1 января"]);
    expect([1, 2, 5, 11, 21, 104].map((n) => plural(n, "случай", "случая", "случаев"))).toEqual(["1 случай", "2 случая", "5 случаев", "11 случаев", "21 случай", "104 случая"]);
    expect([usd(4210.4), usd(-140.2), usd(0), usd(-0.3), usd(1234567)]).toEqual(["$4 210", "−$140", "$0", "$0", "$1 234 567"]);
  });
});
