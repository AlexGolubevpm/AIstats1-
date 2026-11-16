import { describe, expect, it } from "vitest";
import { buildDigest, digestChanges, digestPlain, digestProblems, usd, type DigestData } from "@/lib/digest";

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

describe("digest text", () => {
  it("one screen: totals with the 7-day comparison, AdSpyglass vs fix deals, bundles, cost by source, changes, no problems", () => {
    const t = digestPlain(buildDigest(base(), { appUrl: "https://stat.test" }));
    expect(t.split("\n")).toEqual([
      "📊 TubeStat · вс 15.11",
      "Выручка $4 210 (+6% к ср. 7 дн.) · расход $1 380 · маржа $2 830 · ROMI 205%",
      "AdSpyglass $3 650 (87%) · фикс-дилы $560 (13%)",
      "",
      "Бандлы · выручка · маржа · к ср. 7 дн.",
      "• Gay — $1 420 · $980 · +18%",
      "• Asian — $1 105 · $640 · −3%",
      "",
      "Расход на трафик: TubeCrown $820 · TrafficX $410 · A $100 · прочее $50",
      "",
      "Изменения · к ср. 7 дн.",
      "▲ gay-tube.com +$210 (+34%)",
      "▼ japan-tube.com −$140 (−22%)",
      "",
      "✅ Без просадок и сбоев",
      "",
      "Открыть сводку →",
    ]);
    expect(buildDigest(base(), { appUrl: "https://stat.test" })).toContain('<a href="https://stat.test/?preset=yesterday">Открыть сводку</a>');
    expect(buildDigest(base())).not.toContain("<a "); // no public address — no links
  });

  it("changes need both 20% and the dollar threshold; a higher threshold silences them", () => {
    expect(digestChanges(base()).up.map((x) => x.name)).toEqual(["gay-tube.com"]); // quiet.com: +$2 is noise
    expect(digestChanges(base(), 500)).toEqual({ up: [], down: [] });
    expect(digestChanges(base({ baseDays: 0 }))).toEqual({ up: [], down: [] }); // nothing to compare with
  });

  it("problems: loading first, then a dead site, the network drop, critical alerts, drops by money, new warnings; a problem site is not repeated in the changes", () => {
    const d = base({
      total: { revenue: 2000, mediated: 1800, direct: 200, cost: 900, margin: 1100 },
      health: ["AdSpyglass на паузе до 07:00 UTC: 429"],
      sites: [
        { name: "dead.com", revenue: 0, margin: 0, avgRevenue: 300, pageLoads: 0, avgLoads: 40_000 },
        { name: "japan-tube.com", revenue: 300, margin: 100, avgRevenue: 640, pageLoads: 30_000, avgLoads: 60_000 },
        { name: "small.com", revenue: 5, margin: 5, avgRevenue: 20, pageLoads: 100, avgLoads: 400 }, // −75% but $15: noise
      ],
      bundles: [{ name: "Asian", revenue: 500, margin: 200, avgRevenue: 1100 }],
      alerts: [
        { level: "CRITICAL", rule: "ingest_down", title: "Ингест AdSpyglass упал", count: 1, newCount: 1, moneyAtRisk: 0 },
        { level: "WARNING", rule: "discrepancy", title: "Дискрепанси AdPulsar 18%", count: 3, newCount: 1, moneyAtRisk: 40 },
        { level: "WARNING", rule: "low_fill", title: "Старое предупреждение", count: 2, newCount: 0, moneyAtRisk: 10 },
      ],
    });
    expect(digestProblems(d).map((p) => p.text)).toEqual([
      "AdSpyglass на паузе до 07:00 UTC: 429",
      "dead.com: нет загрузок (обычно 40 000 в день, $300)",
      "Сеть: выручка −50% к ср. 7 дн. (−$1 970)",
      "Ингест AdSpyglass упал · новый",
      "Бандл Asian: выручка −55% к ср. 7 дн. (−$600)",
      "japan-tube.com: выручка −53% к ср. 7 дн. (−$340)",
      "Дискрепанси AdPulsar 18% · новый · под риском $40",
    ]);
    const t = digestPlain(buildDigest(d, { appUrl: "https://stat.test" }));
    expect(t).toContain("⚠️ Проблемы");
    expect(t).toContain("…и ещё 2 — все алерты →"); // five shown, the rest behind the link
    expect(t).not.toContain("▼ dead.com"); // listed as a problem — not again as a change
    expect(t).toContain("▼ japan-tube.com −$340 (−53%)"); // did not fit the five problems: stays visible as a change
    expect(t).not.toContain("✅");
  });

  it("many alerts of one rule take one line: the costliest title, how many more, how many are new, the money at risk", () => {
    const line = (a: Partial<DigestData["alerts"][number]>) => digestProblems(base({ alerts: [{ level: "CRITICAL", rule: "loss_geo", title: "Убыточное гео FR на x.com", count: 1, newCount: 0, moneyAtRisk: 0, ...a }] }))[0].text;
    expect(line({})).toBe("Убыточное гео FR на x.com");
    expect(line({ count: 12, newCount: 3, moneyAtRisk: 340.4 })).toBe("Убыточное гео FR на x.com и ещё 11 таких · новых 3 · под риском $340");
    expect(line({ count: 2, newCount: 2 })).toBe("Убыточное гео FR на x.com и ещё 1 такой · все новые");
    // A warning group shows only its new ones.
    expect(digestProblems(base({ alerts: [{ level: "WARNING", rule: "low_fill", title: "Низкий fill", count: 9, newCount: 2, moneyAtRisk: 15 }] }))[0].text).toBe("Низкий fill и ещё 1 такой · все новые · под риском $15");
  });

  it("incomplete data is said in the second line; without a comparison base there are no deltas", () => {
    const t = digestPlain(buildDigest(base({ incomplete: true, baseDays: 0 })));
    expect(t.split("\n")[1]).toBe("⚠️ Данные за вчера загружены не полностью — цифры ещё изменятся");
    expect(t).not.toContain("к ср. 7 дн.");
    expect(t).not.toContain("Изменения");
  });

  it("more bundles than fit collapse into «ещё N»; overlapping bundles are marked; names are escaped; the text stays within the limit", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `B<${i}> & co`, revenue: 1000 - i * 10, margin: 500, avgRevenue: 1000 }));
    const html = buildDigest(base({ bundles: many, bundlesOverlap: true }));
    expect(html).toContain("• B&lt;0&gt; &amp; co — $1 000");
    expect(html).toContain("…и ещё 4");
    expect(html).toContain("пересекаются");
    const long = base({ sites: Array.from({ length: 40 }, (_, i) => ({ name: `${"very-long-domain-name-".repeat(4)}${i}.com`, revenue: 10, margin: 5, avgRevenue: 900, pageLoads: 10, avgLoads: 900 })),
      health: Array.from({ length: 6 }, (_, i) => `Проблема загрузки номер ${i} `.repeat(6)) });
    const cut = buildDigest(long, { maxChars: 900 });
    expect(cut.length).toBeLessThanOrEqual(900);
    expect((cut.match(/<b>/g) ?? []).length).toBe((cut.match(/<\/b>/g) ?? []).length); // no tag left open
  });

  it("money: whole dollars, a real minus, zero is $0", () => {
    expect([usd(4210.4), usd(-140.2), usd(0), usd(-0.3), usd(1234567)]).toEqual(["$4 210", "−$140", "$0", "$0", "$1 234 567"]);
  });
});
