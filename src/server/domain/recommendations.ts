// Recommendations: one place for every "what to do" the system derives — from alerts (each
// carries its action) and from rules over the report tables (docs/product/06-metrics.md#recommendations).
// Pure builders over plain rows; the query layer feeds them. The system recommends, a human acts.

export type RecScope = "site" | "geo" | "zone" | "network" | "deal" | "source" | "format" | "system";
export interface Recommendation {
  id: string; scope: RecScope; site: { id: string; domain: string } | null;
  /** What the recommendation is about (site, zone id, network…): an alert and a rule about the same object share it. */
  objectKey: string;
  title: string; why: string; action: string; impact: number; link: string; source: "alert" | "rule"; level: "WARNING" | "CRITICAL" | "INFO";
}
export const SCOPE_LABEL: Record<RecScope, string> = {
  site: "Сайты", geo: "Гео", zone: "Зоны", network: "Сетки", deal: "Фикс-дилы", source: "Источники", format: "Форматы", system: "Система",
};

const money = (v: number) => `$${v.toFixed(2)}`;
const cpm = (v: number) => `$${v.toFixed(4)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const ALERT_SCOPE: Record<string, RecScope> = {
  loss_geo: "geo", waterfall_inversion: "network", discrepancy: "network", invisible_zone: "zone", dead_zone: "zone", low_fill: "format",
  deal_no_numbers: "deal", overdue_payment: "deal", ingest_down: "system", deal_ending: "deal", source_unconfigured: "source",
};

export interface AlertRow { id: string; rule: string; entityKey: string; level: "WARNING" | "CRITICAL"; title: string; message: string; link: string; siteId: string | null; domain: string | null; moneyAtRisk: number; action?: string | null }

/** An alert carries its action in `payload.action`; the message is the "why". (Older alerts without one: the last sentence.) */
export function fromAlert(a: AlertRow): Recommendation {
  const sentences = a.message.split(/(?<=[.!])\s+/).filter(Boolean);
  const action = a.action?.trim() || (sentences.length > 1 ? sentences[sentences.length - 1] : a.message);
  const why = a.action?.trim() ? a.message : sentences.length > 1 ? sentences.slice(0, -1).join(" ") : "";
  return { id: `alert:${a.id}`, scope: ALERT_SCOPE[a.rule] ?? "site", site: a.siteId && a.domain ? { id: a.siteId, domain: a.domain } : null,
    objectKey: `${a.rule}|${a.entityKey}`, title: a.title, why, action, impact: a.moneyAtRisk, link: a.link, source: "alert", level: a.level };
}

export interface SiteRow { id: string; domain: string; revenue: number; cost: number; margin: number; romi: number | null }
/** A site in the red over the window: cost above revenue. */
export function lossSites(rows: SiteRow[], days: number): Recommendation[] {
  return rows.filter((r) => r.cost > 0 && r.margin < 0).map((r) => ({
    id: `site-loss:${r.id}`, scope: "site" as const, site: { id: r.id, domain: r.domain }, objectKey: `site-loss|site:${r.id}`, title: `${r.domain} работает в минус`,
    why: `За ${days} дн. выручка ${money(r.revenue)} при расходе на трафик ${money(r.cost)} (ROMI ${r.romi == null ? "—" : `${r.romi.toFixed(1)}%`}).`,
    action: "Снизить закупку или поднять флор; проверить убыточные гео сайта.", impact: -r.margin, link: `/sites/${r.domain}?by=geo&preset=7d`, source: "rule" as const, level: "CRITICAL" as const,
  }));
}

export interface ZoneRow {
  zoneId: string; siteId: string; domain: string; zone: string; format: string; revenue: number;
  /** Shares among the site's zones of the same format (CPM is only comparable within a format). */
  share: number | null; impShare: number | null; imps: number; imps7: number; revenue7: number; viewRate7: number | null;
}
/**
 * Zones the alerts would flag (same thresholds, docs 06): dead — under 1% of the revenue of the
 * site's zones of the same format with over 5% of their impressions in 30 days (≥ 50 000 imps);
 * invisible — view rate under 15% on more than 50 000 impressions in 7 days, with real views and
 * revenue. Between two nightly runs the rule fills in for the alert.
 */
export function zoneRecs(rows: ZoneRow[]): Recommendation[] {
  const out: Recommendation[] = [];
  for (const z of rows) {
    const site = { id: z.siteId, domain: z.domain }, link = `/sites/${z.domain}?by=zones&preset=30d`;
    if (z.share != null && z.share < 0.01 && (z.impShare ?? 0) > 0.05 && z.imps >= 50_000) out.push({
      id: `zone-dead:${z.zoneId}`, scope: "zone", site, objectKey: `dead_zone|zone:${z.zoneId}`, title: `Мёртвая зона: ${z.zone} на ${z.domain}`,
      why: `За 30 дн. ${pct(z.share)} выручки зон этого формата на сайте при ${pct(z.impShare ?? 0)} их показов (${money(z.revenue)}).`,
      action: "Снести зону или отдать место формату с более высоким CPM.", impact: 0, link, source: "rule", level: "WARNING" });
    if (z.viewRate7 != null && z.viewRate7 > 0 && z.viewRate7 < 0.15 && z.imps7 > 50_000 && z.revenue7 > 0) out.push({
      id: `zone-invisible:${z.zoneId}`, scope: "zone", site, objectKey: `invisible_zone|zone:${z.zoneId}`, title: `Зона не видна: ${z.zone} на ${z.domain}`,
      why: `View rate ${pct(z.viewRate7)} за 7 дн. — ниже 15%, баннер показывается за пределами экрана.`,
      action: "Поднять зону выше фолда или сменить место.", impact: 0, link, source: "rule", level: "WARNING" });
  }
  return out;
}

export interface NetworkRow { siteId: string; domain: string; network: string; revPer1k: number | null; floor: number | null; volShare: number | null; pageLoads: number; belowFloor: boolean }
/** A network under the site's floor that still takes a notable share of volume. */
export function floorRecs(rows: NetworkRow[], days: number): Recommendation[] {
  return rows.filter((r) => r.belowFloor && (r.volShare ?? 0) >= 0.1 && r.floor != null && r.floor > 0 && r.revPer1k != null).map((r) => ({
    id: `floor:${r.siteId}:${r.network}`, scope: "network" as const, site: { id: r.siteId, domain: r.domain }, objectKey: `floor|site:${r.siteId}|net:${r.network}`,
    title: `${r.network} на ${r.domain} ниже флора`,
    why: `Rev/1000 loads ${cpm(r.revPer1k!)} при флоре ${cpm(r.floor!)}; держит ${pct(r.volShare ?? 0)} объёма за ${days} дн.`,
    action: `Поднять флор ${r.network} до ${cpm(r.floor!)} за 1000 загрузок или опустить в waterfall.`,
    impact: ((r.floor! - r.revPer1k!) * r.pageLoads) / 1000, link: `/sites/${r.domain}?by=networks&preset=7d`, source: "rule" as const, level: "WARNING" as const,
  }));
}

export interface SourceRow { siteId: string; domain: string; source: string; cost: number; siteRevenue: number; loadsShare: number | null }
/** A traffic source whose cost eats most of the site's revenue. */
export function sourceRecs(rows: SourceRow[], days: number): Recommendation[] {
  return rows.filter((r) => r.siteRevenue > 0 && r.cost / r.siteRevenue >= 0.6 && r.cost > 5).map((r) => ({
    id: `source:${r.siteId}:${r.source}`, scope: "source" as const, site: { id: r.siteId, domain: r.domain }, objectKey: `source|site:${r.siteId}|${r.source}`,
    title: `${r.source} съедает ${pct(r.cost / r.siteRevenue)} выручки ${r.domain}`,
    why: `За ${days} дн. источнику ушло ${money(r.cost)} из ${money(r.siteRevenue)} выручки сайта${r.loadsShare != null ? `, это ${pct(r.loadsShare)} загрузок` : ""}.`,
    action: "Снизить закупку у источника или договориться о меньшей доле; проверить, что сумма ADOK — действительно расход.",
    impact: r.cost - r.siteRevenue * 0.5, link: `/sites/${r.domain}?by=sources&preset=7d`, source: "rule" as const, level: "WARNING" as const,
  }));
}

export interface FreeRow { siteId: string; domain: string; free: number; places: number; revenue: number; rank: number }
/** Free ad places on the sites that earn the most: inventory nobody sells. */
export function freePlaceRecs(rows: FreeRow[], topN = 10): Recommendation[] {
  return rows.filter((r) => r.rank <= topN && r.free > 0 && r.revenue > 0).map((r) => ({
    id: `free:${r.siteId}`, scope: "format" as const, site: { id: r.siteId, domain: r.domain }, objectKey: `free|site:${r.siteId}`,
    title: `${r.free} свободных ${r.free === 1 ? "место" : r.free < 5 ? "места" : "мест"} на ${r.domain}`,
    why: `Сайт №${r.rank} по выручке (${money(r.revenue)} за 7 дн.), ${r.free} из ${r.places} мест ничем не заняты.`,
    action: "Продать фикс-дил на свободное место или включить ротацию AdSpyglass.", impact: 0, link: `/inventory?free=1`, source: "rule" as const, level: "INFO" as const,
  }));
}

/** Alerts win over rules about the same object (same objectKey; lists are given alerts first); then critical first, by impact. */
export function mergeRecs(lists: Recommendation[][]): Recommendation[] {
  const seen = new Set<string>(), out: Recommendation[] = [];
  for (const r of lists.flat()) {
    if (seen.has(r.objectKey)) continue;
    seen.add(r.objectKey); out.push(r);
  }
  const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || b.impact - a.impact);
}
