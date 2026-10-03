// Recommendations: one place for every "what to do" the system derives — from alerts (each
// carries its action) and from rules over the report tables (docs/product/06-metrics.md#recommendations).
// Pure builders over plain rows; the query layer feeds them. The system recommends, a human acts.

export type RecScope = "site" | "geo" | "zone" | "network" | "deal" | "source" | "format" | "system";
export interface Recommendation {
  id: string; scope: RecScope; site: { id: string; domain: string } | null;
  title: string; why: string; action: string; impact: number; link: string; source: "alert" | "rule"; level: "WARNING" | "CRITICAL" | "INFO";
}
export const SCOPE_LABEL: Record<RecScope, string> = {
  site: "Сайты", geo: "Гео", zone: "Зоны", network: "Сетки", deal: "Фикс-дилы", source: "Источники", format: "Форматы", system: "Система",
};

const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const ALERT_SCOPE: Record<string, RecScope> = {
  loss_geo: "geo", waterfall_inversion: "network", discrepancy: "network", invisible_zone: "zone", dead_zone: "zone", low_fill: "format",
  deal_no_numbers: "deal", overdue_payment: "deal", ingest_down: "system", deal_ending: "deal",
};

export interface AlertRow { id: string; rule: string; level: "WARNING" | "CRITICAL"; title: string; message: string; link: string; siteId: string | null; domain: string | null; moneyAtRisk: number }

/** Every alert ends with its recommended action: split it off the "why". */
export function fromAlert(a: AlertRow): Recommendation {
  const sentences = a.message.split(/(?<=[.!])\s+/).filter(Boolean);
  const action = sentences.length > 1 ? sentences[sentences.length - 1] : a.message;
  const why = sentences.length > 1 ? sentences.slice(0, -1).join(" ") : "";
  return { id: `alert:${a.id}`, scope: ALERT_SCOPE[a.rule] ?? "site", site: a.siteId && a.domain ? { id: a.siteId, domain: a.domain } : null,
    title: a.title, why, action, impact: a.moneyAtRisk, link: a.link, source: "alert", level: a.level };
}

export interface SiteRow { id: string; domain: string; revenue: number; cost: number; margin: number; romi: number | null }
/** A site in the red over the window: cost above revenue. */
export function lossSites(rows: SiteRow[], days: number): Recommendation[] {
  return rows.filter((r) => r.cost > 0 && r.margin < 0).map((r) => ({
    id: `site-loss:${r.id}`, scope: "site" as const, site: { id: r.id, domain: r.domain }, title: `${r.domain} работает в минус`,
    why: `За ${days} дн. выручка ${money(r.revenue)} при расходе на трафик ${money(r.cost)} (ROMI ${r.romi == null ? "—" : `${r.romi.toFixed(1)}%`}).`,
    action: "Снизить закупку или поднять флор; проверить убыточные гео сайта.", impact: -r.margin, link: `/sites/${r.domain}?by=geo&preset=7d`, source: "rule" as const, level: "CRITICAL" as const,
  }));
}

export interface ZoneRow { siteId: string; domain: string; zone: string; format: string; revenue: number; share: number | null; impShare: number | null; viewRate: number | null; imps: number }
/** Zones that earn under 1% of the site while taking impressions, and banner zones nobody sees. */
export function zoneRecs(rows: ZoneRow[], days: number): Recommendation[] {
  const out: Recommendation[] = [];
  for (const z of rows) {
    const site = { id: z.siteId, domain: z.domain }, link = `/sites/${z.domain}?by=zones&preset=30d`;
    if (z.share != null && z.share < 0.01 && z.imps >= 1000) out.push({
      id: `zone-dead:${z.siteId}:${z.zone}`, scope: "zone", site, title: `Зона «${z.zone}» на ${z.domain} почти не зарабатывает`,
      why: `За ${days} дн. ${pct(z.share)} выручки сайта${z.impShare != null ? ` при ${pct(z.impShare)} показов` : ""} (${money(z.revenue)}).`,
      action: "Снести зону или отдать место формату с более высоким CPM.", impact: 0, link, source: "rule", level: "WARNING" });
    if (z.viewRate != null && z.viewRate < 0.15 && z.imps >= 1000) out.push({
      id: `zone-invisible:${z.siteId}:${z.zone}`, scope: "zone", site, title: `Зона «${z.zone}» на ${z.domain} не видна`,
      why: `View rate ${pct(z.viewRate)} за ${days} дн. — ниже 15%, баннер показывается за пределами экрана.`,
      action: "Поднять зону выше фолда или сменить место.", impact: 0, link, source: "rule", level: "WARNING" });
  }
  return out;
}

export interface NetworkRow { siteId: string; domain: string; network: string; revPer1k: number | null; floor: number | null; volShare: number | null; pageLoads: number; belowFloor: boolean }
/** A network under the site's floor that still takes a notable share of volume. */
export function floorRecs(rows: NetworkRow[], days: number): Recommendation[] {
  return rows.filter((r) => r.belowFloor && (r.volShare ?? 0) >= 0.1 && r.floor != null && r.revPer1k != null).map((r) => ({
    id: `floor:${r.siteId}:${r.network}`, scope: "network" as const, site: { id: r.siteId, domain: r.domain },
    title: `${r.network} на ${r.domain} ниже флора`,
    why: `Rev/1000 loads ${money(r.revPer1k!)} при флоре ${money(r.floor!)}; держит ${pct(r.volShare ?? 0)} объёма за ${days} дн.`,
    action: `Поднять флор ${r.network} до ${money(r.floor!)} за 1000 загрузок или опустить в waterfall.`,
    impact: ((r.floor! - r.revPer1k!) * r.pageLoads) / 1000, link: `/sites/${r.domain}?by=networks&preset=7d`, source: "rule" as const, level: "WARNING" as const,
  }));
}

export interface SourceRow { siteId: string; domain: string; source: string; cost: number; siteRevenue: number; loadsShare: number | null }
/** A traffic source whose cost eats most of the site's revenue. */
export function sourceRecs(rows: SourceRow[], days: number): Recommendation[] {
  return rows.filter((r) => r.siteRevenue > 0 && r.cost / r.siteRevenue >= 0.6 && r.cost > 5).map((r) => ({
    id: `source:${r.siteId}:${r.source}`, scope: "source" as const, site: { id: r.siteId, domain: r.domain },
    title: `${r.source} съедает ${pct(r.cost / r.siteRevenue)} выручки ${r.domain}`,
    why: `За ${days} дн. источнику ушло ${money(r.cost)} из ${money(r.siteRevenue)} выручки сайта${r.loadsShare != null ? `, это ${pct(r.loadsShare)} загрузок` : ""}.`,
    action: "Снизить закупку у источника или договориться о меньшей доле; проверить, что сумма ADOK — действительно расход.",
    impact: r.cost - r.siteRevenue * 0.5, link: `/sites/${r.domain}?by=sources&preset=7d`, source: "rule" as const, level: "WARNING" as const,
  }));
}

export interface FreeRow { siteId: string; domain: string; free: number; places: number; revenue: number; rank: number }
/** Free ad places on the sites that earn the most: inventory nobody sells. */
export function freePlaceRecs(rows: FreeRow[], topN = 10): Recommendation[] {
  return rows.filter((r) => r.rank <= topN && r.free > 0).map((r) => ({
    id: `free:${r.siteId}`, scope: "format" as const, site: { id: r.siteId, domain: r.domain },
    title: `${r.free} свободных ${r.free === 1 ? "место" : r.free < 5 ? "места" : "мест"} на ${r.domain}`,
    why: `Сайт №${r.rank} по выручке (${money(r.revenue)} за 7 дн.), ${r.free} из ${r.places} мест ничем не заняты.`,
    action: "Продать фикс-дил на свободное место или включить ротацию AdSpyglass.", impact: 0, link: `/inventory?free=1`, source: "rule" as const, level: "INFO" as const,
  }));
}

/** Alerts win over rules about the same object; then by impact, critical first. */
export function mergeRecs(lists: Recommendation[][]): Recommendation[] {
  const seen = new Set<string>(), out: Recommendation[] = [];
  const objectKey = (r: Recommendation) => `${r.scope}|${r.site?.id ?? ""}|${r.title.replace(/[^а-яa-z0-9]+/gi, "").toLowerCase()}`;
  for (const r of lists.flat()) {
    const k = objectKey(r);
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || b.impact - a.impact);
}
