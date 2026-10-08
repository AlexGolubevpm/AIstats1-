// Hypotheses: every "what could earn more or stop a loss" the system derives — from alerts (each
// carries its action) and from rules over the daily analytics (docs/product/06-metrics.md#hypotheses,
// ADR 0013). Pure builders over plain rows; the query layer feeds them, the service stores them.
// The system proposes, a human accepts, does and measures.

export type HypScope = "site" | "geo" | "zone" | "network" | "deal" | "source" | "format" | "bundle" | "system";
export type HypLevel = "INFO" | "WARNING" | "CRITICAL";
/** What a hypothesis is measured by, over its object (site, bundle, zone, network, format, source, deal). */
export type Metric = "revenue" | "margin" | "rev_per_1k" | "rpm" | "view_rate" | "cost_per_1k" | "cost_share";
export const METRIC_LABEL: Record<Metric, string> = {
  revenue: "выручка за 14 дн.", margin: "маржа за 14 дн.", rev_per_1k: "rev / 1000 loads", rpm: "RPM на уника", view_rate: "view rate",
  cost_per_1k: "цена 1000 loads", cost_share: "доля расхода в выручке",
};
export const METRICS = Object.keys(METRIC_LABEL) as Metric[];

export interface HypothesisCandidate {
  ruleKey: string;
  /** What it is about (site, zone id, bundle…): an alert and a rule about the same object share ruleKey + objectKey. */
  objectKey: string;
  scope: HypScope; level: HypLevel;
  title: string; hypothesis: string; evidence: Record<string, unknown>; impactMonth: number; link: string; metric: Metric | null;
  source: "AUTO" | "ALERT";
  alertId?: string | null; siteId?: string | null; bundleId?: string | null; format?: string | null; zoneId?: string | null; networkId?: string | null;
  countryCode?: string | null; sourceSlug?: string | null; dealId?: string | null;
}
export const SCOPE_LABEL: Record<HypScope, string> = {
  bundle: "Бандлы", site: "Сайты", geo: "Гео", zone: "Зоны", network: "Сетки", format: "Форматы", deal: "Фикс-дилы", source: "Источники", system: "Система",
};
export const SOURCE_LABEL = { AUTO: "авто", ALERT: "алерт", MANUAL: "своя" } as const;
export const STATUS_LABEL = { PROPOSED: "предложена", ACCEPTED: "в работе", DONE: "проверена", REJECTED: "отклонена", EXPIRED: "неактуальна" } as const;

const money = (v: number) => `$${v.toFixed(2)}`;
const cpm = (v: number) => `$${v.toFixed(4)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const round = (v: number, dp = 4) => Number(v.toFixed(dp));
/** Window total × 30 / days: the monthly figure every impact is quoted in. */
const perMonth = (v: number, days: number) => (days > 0 ? (v * 30) / days : 0);
export function median(values: number[]): number | null {
  const v = [...values].sort((a, b) => a - b);
  if (!v.length) return null;
  return v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
}
const per1k = (revenue: number, loads: number) => (loads > 0 ? (revenue / loads) * 1000 : null);
/** Level from the monthly effect: a big number deserves the owner's attention first. */
const LEVEL_ORDER: Record<HypLevel, number> = { INFO: 0, WARNING: 1, CRITICAL: 2 };
export const levelOf = (impactMonth: number, floor: HypLevel = "INFO"): HypLevel => {
  const byImpact: HypLevel = impactMonth >= 300 ? "CRITICAL" : impactMonth >= 30 ? "WARNING" : "INFO";
  return LEVEL_ORDER[byImpact] >= LEVEL_ORDER[floor] ? byImpact : floor;
};

const ALERT_SCOPE: Record<string, HypScope> = {
  loss_geo: "geo", waterfall_inversion: "network", discrepancy: "network", invisible_zone: "zone", dead_zone: "zone", low_fill: "format",
  deal_no_numbers: "deal", overdue_payment: "deal", ingest_down: "system", deal_ending: "deal", source_unconfigured: "source",
};
const ALERT_METRIC: Record<string, Metric | null> = {
  loss_geo: "margin", waterfall_inversion: "rev_per_1k", discrepancy: null, invisible_zone: "view_rate", dead_zone: "revenue", low_fill: "revenue",
  deal_no_numbers: null, overdue_payment: null, ingest_down: null, deal_ending: "revenue", source_unconfigured: null,
};

export interface AlertRow { id: string; rule: string; entityKey: string; level: "WARNING" | "CRITICAL"; title: string; message: string; link: string; siteId: string | null; domain: string | null; moneyAtRisk: number; action?: string | null }

/** Reads `site:<id>|country:JP|zone:<id>|net:<title>|format:F` style keys into object fields. */
export function parseEntityKey(key: string): { siteId?: string; countryCode?: string; zoneId?: string; format?: string; dealId?: string; sourceSlug?: string } {
  const out: Record<string, string> = {};
  for (const part of key.split("|")) {
    const [k, ...rest] = part.split(":"); const v = rest.join(":");
    if (k === "site") out.siteId = v; else if (k === "country") out.countryCode = v; else if (k === "zone") out.zoneId = v;
    else if (k === "format") out.format = v; else if (k === "deal") out.dealId = v; else if (k === "source") out.sourceSlug = v;
  }
  return out;
}

/** An alert carries its action in `payload.action`; the message is the "why". (Older alerts without one: the last sentence.) */
export function fromAlert(a: AlertRow): HypothesisCandidate {
  const sentences = a.message.split(/(?<=[.!])\s+/).filter(Boolean);
  const action = a.action?.trim() || (sentences.length > 1 ? sentences[sentences.length - 1] : a.message);
  const why = a.action?.trim() ? a.message : sentences.length > 1 ? sentences.slice(0, -1).join(" ") : "";
  const keys = parseEntityKey(a.entityKey);
  return {
    ruleKey: a.rule, objectKey: a.entityKey, scope: ALERT_SCOPE[a.rule] ?? "site", level: a.level, title: a.title,
    hypothesis: `${action}${why ? ` — ${why}` : ""}`, evidence: { why, action, moneyAtRisk: a.moneyAtRisk, alert: a.rule },
    impactMonth: a.moneyAtRisk, link: a.link, metric: ALERT_METRIC[a.rule] ?? null, source: "ALERT", alertId: a.id,
    siteId: a.siteId ?? keys.siteId ?? null, countryCode: keys.countryCode ?? null, zoneId: keys.zoneId ?? null, format: keys.format ?? null,
    dealId: keys.dealId ?? null, sourceSlug: keys.sourceSlug ?? null,
  };
}

// ---------- Rules carried over from the recommendations page ----------

export interface SiteRow { id: string; domain: string; revenue: number; cost: number; margin: number; romi: number | null }
/** A site in the red over the window: cost above revenue. */
export function lossSites(rows: SiteRow[], days: number): HypothesisCandidate[] {
  return rows.filter((r) => r.cost > 0 && r.margin < 0).map((r) => ({
    ruleKey: "site_loss", objectKey: `site:${r.id}`, scope: "site" as const, siteId: r.id, title: `${r.domain} работает в минус`,
    hypothesis: `Если снизить закупку или поднять флор на убыточных гео, сайт выйдет в плюс: за ${days} дн. выручка ${money(r.revenue)} при расходе на трафик ${money(r.cost)} (ROMI ${r.romi == null ? "—" : `${r.romi.toFixed(1)}%`}).`,
    evidence: { days, revenue: round(r.revenue, 2), cost: round(r.cost, 2), romi: r.romi }, impactMonth: round(perMonth(-r.margin, days), 2),
    link: `/sites/${r.domain}?by=geo&preset=7d`, metric: "margin" as const, level: "CRITICAL" as const, source: "AUTO" as const,
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
 * revenue. Between two nightly runs the rule fills in for the alert (same ruleKey + objectKey).
 */
export function zoneRecs(rows: ZoneRow[]): HypothesisCandidate[] {
  const out: HypothesisCandidate[] = [];
  for (const z of rows) {
    const base = { scope: "zone" as const, siteId: z.siteId, zoneId: z.zoneId, format: z.format, link: `/sites/${z.domain}?by=zones&preset=30d`, source: "AUTO" as const };
    if (z.share != null && z.share < 0.01 && (z.impShare ?? 0) > 0.05 && z.imps >= 50_000) out.push({ ...base,
      ruleKey: "dead_zone", objectKey: `zone:${z.zoneId}`, title: `Мёртвая зона: ${z.zone} на ${z.domain}`,
      hypothesis: `Если снести зону или отдать место формату с более высоким CPM, место начнёт зарабатывать: за 30 дн. ${pct(z.share)} выручки зон этого формата на сайте при ${pct(z.impShare ?? 0)} их показов (${money(z.revenue)}).`,
      evidence: { days: 30, share: z.share, impShare: z.impShare, imps: z.imps, revenue: round(z.revenue, 2) }, impactMonth: 0, metric: "revenue", level: "WARNING" });
    if (z.viewRate7 != null && z.viewRate7 > 0 && z.viewRate7 < 0.15 && z.imps7 > 50_000 && z.revenue7 > 0) out.push({ ...base,
      ruleKey: "invisible_zone", objectKey: `zone:${z.zoneId}`, title: `Зона не видна: ${z.zone} на ${z.domain}`,
      hypothesis: `Если поднять зону выше фолда или сменить место, view rate вырастет с ${pct(z.viewRate7)} к 35% и выручка зоны — пропорционально: сейчас баннер показывается за пределами экрана.`,
      evidence: { days: 7, viewRate: z.viewRate7, imps: z.imps7, revenue: round(z.revenue7, 2) },
      impactMonth: round(perMonth(Math.max(0, (z.revenue7 * 0.35) / z.viewRate7 - z.revenue7), 7), 2), metric: "view_rate", level: "WARNING" });
  }
  return out;
}

export interface NetworkRow { siteId: string; domain: string; networkId?: string | null; network: string; revPer1k: number | null; floor: number | null; volShare: number | null; pageLoads: number; belowFloor: boolean }
/** A network under the site's floor that still takes a notable share of volume. */
export function floorRecs(rows: NetworkRow[], days: number): HypothesisCandidate[] {
  return rows.filter((r) => r.belowFloor && (r.volShare ?? 0) >= 0.1 && r.floor != null && r.floor > 0 && r.revPer1k != null).map((r) => {
    const impact = perMonth(((r.floor! - r.revPer1k!) * r.pageLoads) / 1000, days);
    return {
      ruleKey: "network_below_floor", objectKey: `site:${r.siteId}|net:${r.network}`, scope: "network" as const, siteId: r.siteId, networkId: r.networkId ?? null,
      title: `${r.network} на ${r.domain} ниже флора`,
      hypothesis: `Если поднять флор ${r.network} до ${cpm(r.floor!)} за 1000 загрузок или опустить сетку в waterfall, её объём уйдёт по цене флора: сейчас rev/1000 loads ${cpm(r.revPer1k!)} при ${pct(r.volShare ?? 0)} объёма за ${days} дн.`,
      evidence: { days, revPer1k: round(r.revPer1k!), floor: round(r.floor!), volShare: r.volShare, pageLoads: r.pageLoads }, impactMonth: round(impact, 2),
      link: `/sites/${r.domain}?by=networks&preset=7d`, metric: "rev_per_1k" as const, level: levelOf(impact), source: "AUTO" as const,
    };
  });
}

export interface SourceRow { siteId: string; domain: string; source: string; sourceSlug?: string | null; cost: number; siteRevenue: number; loadsShare: number | null }
/** A traffic source whose cost eats most of the site's revenue. */
export function sourceRecs(rows: SourceRow[], days: number): HypothesisCandidate[] {
  return rows.filter((r) => r.siteRevenue > 0 && r.cost / r.siteRevenue >= 0.6 && r.cost > 5).map((r) => {
    const impact = perMonth(r.cost - r.siteRevenue * 0.5, days);
    return {
      ruleKey: "source_eats_revenue", objectKey: `site:${r.siteId}|source:${r.sourceSlug ?? r.source}`, scope: "source" as const, siteId: r.siteId, sourceSlug: r.sourceSlug ?? null,
      title: `${r.source} съедает ${pct(r.cost / r.siteRevenue)} выручки ${r.domain}`,
      hypothesis: `Если снизить закупку у источника или договориться о меньшей доле, расход вернётся к половине выручки: за ${days} дн. источнику ушло ${money(r.cost)} из ${money(r.siteRevenue)}${r.loadsShare != null ? `, это ${pct(r.loadsShare)} загрузок` : ""}. Проверить, что сумма ADOK — действительно расход.`,
      evidence: { days, cost: round(r.cost, 2), siteRevenue: round(r.siteRevenue, 2), loadsShare: r.loadsShare }, impactMonth: round(impact, 2),
      link: `/sites/${r.domain}?by=sources&preset=7d`, metric: "cost_share" as const, level: levelOf(impact), source: "AUTO" as const,
    };
  });
}

export interface FreeRow { siteId: string; domain: string; free: number; places: number; revenue: number; rank: number }
/** Free ad places on the sites that earn the most: inventory nobody sells. */
export function freePlaceRecs(rows: FreeRow[], topN = 10): HypothesisCandidate[] {
  return rows.filter((r) => r.rank <= topN && r.free > 0 && r.revenue > 0).map((r) => ({
    ruleKey: "free_places", objectKey: `site:${r.siteId}`, scope: "format" as const, siteId: r.siteId,
    title: `${r.free} свободных ${r.free === 1 ? "место" : r.free < 5 ? "места" : "мест"} на ${r.domain}`,
    hypothesis: `Если продать фикс-дил на свободное место или включить ротацию AdSpyglass, сайт №${r.rank} по выручке (${money(r.revenue)} за 7 дн.) заработает с ${r.free} из ${r.places} мест, которые сейчас ничем не заняты.`,
    evidence: { days: 7, free: r.free, places: r.places, rank: r.rank, revenue: round(r.revenue, 2) }, impactMonth: 0, link: `/inventory?free=1`,
    metric: "revenue" as const, level: "INFO" as const, source: "AUTO" as const,
  }));
}

// ---------- New rules over the daily analytics (bundle, site vs bundle, geo vs network, format vs peers) ----------

export interface BundleSiteRow { bundleId: string; bundleTitle: string; bundleSlug: string; siteId: string; domain: string; revenue: number; pageLoads: number; cost: number }
/** A site earning well below the median of its bundle per 1000 loads: same niche, same traffic kind, less money. */
export function siteBelowBundle(rows: BundleSiteRow[], days: number, minLoads = 50_000): HypothesisCandidate[] {
  const out: HypothesisCandidate[] = [];
  const byBundle = new Map<string, BundleSiteRow[]>();
  for (const r of rows) byBundle.set(r.bundleId, [...(byBundle.get(r.bundleId) ?? []), r]);
  for (const sites of byBundle.values()) {
    const withData = sites.filter((s) => s.pageLoads >= minLoads);
    if (withData.length < 3) continue;
    const med = median(withData.map((s) => per1k(s.revenue, s.pageLoads)!))!;
    if (med <= 0) continue;
    const leader = [...withData].sort((a, b) => per1k(b.revenue, b.pageLoads)! - per1k(a.revenue, a.pageLoads)!)[0];
    for (const s of withData) {
      const cur = per1k(s.revenue, s.pageLoads)!;
      if (cur >= med * 0.75) continue;
      const impact = perMonth(((med - cur) * s.pageLoads) / 1000, days);
      out.push({
        ruleKey: "site_below_bundle", objectKey: `site:${s.siteId}|bundle:${s.bundleId}`, scope: "site", siteId: s.siteId, bundleId: s.bundleId,
        title: `${s.domain} зарабатывает на ${pct(1 - cur / med)} меньше бандла ${s.bundleTitle}`,
        hypothesis: `Если выровнять сетки, флоры и форматы с лидером бандла (${leader.domain}, ${cpm(per1k(leader.revenue, leader.pageLoads)!)}), rev/1000 loads подтянется с ${cpm(cur)} к медиане ${cpm(med)} за ${days} дн.`,
        evidence: { days, revPer1k: round(cur), bundleMedian: round(med), leader: leader.domain, leaderRevPer1k: round(per1k(leader.revenue, leader.pageLoads)!), pageLoads: s.pageLoads, sites: withData.length },
        impactMonth: round(impact, 2), link: `/bundles/${s.bundleSlug}?preset=7d`, metric: "rev_per_1k", level: levelOf(impact), source: "AUTO",
      });
    }
  }
  return out;
}

export interface GeoRow { siteId: string; domain: string; countryCode: string; revenue: number; pageLoads: number }
/** A country that pays well across the network but poorly on one site: the floor or the network for that geo is off. */
export function geoBelowNetwork(rows: GeoRow[], days: number, minLoads = 10_000): HypothesisCandidate[] {
  const out: HypothesisCandidate[] = [];
  const byCountry = new Map<string, GeoRow[]>();
  for (const r of rows) if (r.countryCode !== "ZZ" && r.countryCode !== "XX" && r.pageLoads >= minLoads) byCountry.set(r.countryCode, [...(byCountry.get(r.countryCode) ?? []), r]);
  for (const [cc, sites] of byCountry) {
    if (sites.length < 3) continue;
    const med = median(sites.map((s) => per1k(s.revenue, s.pageLoads)!))!;
    if (med <= 0) continue;
    for (const s of sites) {
      const cur = per1k(s.revenue, s.pageLoads)!;
      if (cur >= med * 0.7) continue;
      const impact = perMonth(((med - cur) * s.pageLoads) / 1000, days);
      out.push({
        ruleKey: "geo_below_network", objectKey: `site:${s.siteId}|country:${cc}`, scope: "geo", siteId: s.siteId, countryCode: cc,
        title: `${cc} на ${s.domain} платит ${cpm(cur)} против ${cpm(med)} по сети`,
        hypothesis: `Если поднять флор или сменить сетку для ${cc} на этом сайте, rev/1000 loads страны дойдёт до медианы сети: ${sites.length} сайтов с трафиком из ${cc} за ${days} дн., здесь ${pct(1 - cur / med)} ниже.`,
        evidence: { days, revPer1k: round(cur), networkMedian: round(med), pageLoads: s.pageLoads, sites: sites.length },
        impactMonth: round(impact, 2), link: `/sites/${s.domain}?by=geo&preset=7d`, metric: "rev_per_1k", level: levelOf(impact), source: "AUTO",
      });
    }
  }
  return out;
}

export interface FormatRow { siteId: string; format: string; revenue: number; pageLoads: number }
/** A format that earns on most sites of the bundle and is absent on this one. */
export function formatMissingVsPeers(sites: BundleSiteRow[], formats: FormatRow[], days: number, minLoads = 20_000): HypothesisCandidate[] {
  const out: HypothesisCandidate[] = [];
  const bySite = new Map<string, FormatRow[]>();
  for (const f of formats) bySite.set(f.siteId, [...(bySite.get(f.siteId) ?? []), f]);
  const byBundle = new Map<string, BundleSiteRow[]>();
  for (const r of sites) byBundle.set(r.bundleId, [...(byBundle.get(r.bundleId) ?? []), r]);
  for (const peers of byBundle.values()) {
    const live = peers.filter((p) => p.pageLoads >= minLoads);
    if (live.length < 3) continue;
    const allFormats = new Set(live.flatMap((p) => (bySite.get(p.siteId) ?? []).filter((f) => f.revenue > 0).map((f) => f.format)));
    for (const format of allFormats) {
      const earning = live.filter((p) => (bySite.get(p.siteId) ?? []).some((f) => f.format === format && f.revenue > 0));
      if (earning.length < 2 || earning.length / live.length < 0.5) continue;
      // Site loads, not the format's own loads: the format is absent here, so its potential is the site's traffic at the peers' rate.
      const med = median(earning.map((p) => per1k((bySite.get(p.siteId) ?? []).find((f) => f.format === format)!.revenue, p.pageLoads)!))!;
      if (med <= 0) continue;
      for (const s of live) {
        if (earning.some((e) => e.siteId === s.siteId)) continue;
        const impact = perMonth((med * s.pageLoads) / 1000, days);
        out.push({
          ruleKey: "format_missing", objectKey: `site:${s.siteId}|format:${format}`, scope: "format", siteId: s.siteId, bundleId: s.bundleId, format,
          title: `На ${s.domain} нет формата ${format}, который работает у ${earning.length} из ${live.length} сайтов ${s.bundleTitle}`,
          hypothesis: `Если добавить формат ${format} (зона в AdSpyglass или фикс-дил на место), сайт получит около ${cpm(med)} за 1000 загрузок — столько он даёт соседям по бандлу за ${days} дн.`,
          evidence: { days, format, peersEarning: earning.length, peers: live.length, peerMedianPer1k: round(med), pageLoads: s.pageLoads },
          impactMonth: round(impact, 2), link: `/inventory?bundle=${s.bundleSlug}`, metric: "revenue", level: levelOf(impact), source: "AUTO",
        });
      }
    }
  }
  return out;
}

export interface NetworkShareRow { bundleId: string; bundleTitle: string; bundleSlug: string; siteId: string; domain: string; networkId: string; network: string; revenue: number; pageLoads: number; siteLoads: number; siteRevenue: number }
/** A network that is among the two best paying on the bundle's peers but barely gets volume on this site. */
export function networkUnderused(rows: NetworkShareRow[], days: number, minLoads = 20_000): HypothesisCandidate[] {
  const out: HypothesisCandidate[] = [];
  const byBundle = new Map<string, NetworkShareRow[]>();
  for (const r of rows) byBundle.set(r.bundleId, [...(byBundle.get(r.bundleId) ?? []), r]);
  for (const list of byBundle.values()) {
    const sites = new Map<string, NetworkShareRow[]>();
    for (const r of list) sites.set(r.siteId, [...(sites.get(r.siteId) ?? []), r]);
    if (sites.size < 3) continue;
    // Peer median rev/1k per network, over the sites where it carries real volume.
    const perNet = new Map<string, { network: string; values: number[] }>();
    for (const r of list) if (r.pageLoads >= 1000 && r.revenue > 0) {
      const e = perNet.get(r.networkId) ?? { network: r.network, values: [] }; e.values.push(per1k(r.revenue, r.pageLoads)!); perNet.set(r.networkId, e);
    }
    const ranked = [...perNet].filter(([, e]) => e.values.length >= 2).map(([id, e]) => ({ id, network: e.network, med: median(e.values)! })).sort((a, b) => b.med - a.med).slice(0, 2);
    for (const [siteId, nets] of sites) {
      const any = nets[0];
      if (any.siteLoads < minLoads) continue;
      const siteRate = per1k(any.siteRevenue, any.siteLoads) ?? 0;
      for (const top of ranked) {
        const here = nets.find((n) => n.networkId === top.id);
        const share = here ? here.pageLoads / any.siteLoads : 0;
        if (share >= 0.1 || top.med <= siteRate) continue;
        const impact = perMonth(((top.med - siteRate) * any.siteLoads * 0.1) / 1000, days);
        out.push({
          ruleKey: "network_underused", objectKey: `site:${siteId}|net:${top.id}`, scope: "network", siteId, bundleId: any.bundleId, networkId: top.id,
          title: `${top.network} почти не получает объём на ${any.domain}`,
          hypothesis: `Если поднять ${top.network} в waterfall до 10% объёма, эта доля пойдёт по ${cpm(top.med)} вместо средних ${cpm(siteRate)} сайта: на соседях по бандлу ${any.bundleTitle} сетка в топ-2 по rev/1000 loads, здесь у неё ${pct(share)} загрузок за ${days} дн.`,
          evidence: { days, network: top.network, peerMedianPer1k: round(top.med), siteRevPer1k: round(siteRate), volShare: round(share), siteLoads: any.siteLoads },
          impactMonth: round(impact, 2), link: `/sites/${any.domain}?by=networks&preset=7d`, metric: "rev_per_1k", level: levelOf(impact), source: "AUTO",
        });
      }
    }
  }
  return out;
}

export interface SourcePriceRow { siteId: string; domain: string; sourceSlug: string; source: string; cost: number; loads: number; siteRevenue: number; siteLoads: number }
/** Traffic bought dearer than the site turns it into money: cost per 1000 loads above revenue per 1000 loads. */
export function sourceAboveRevenue(rows: SourcePriceRow[], days: number, minLoads = 10_000): HypothesisCandidate[] {
  return rows.filter((r) => r.loads >= minLoads && r.siteLoads > 0 && r.cost > 0).flatMap((r) => {
    const cost1k = per1k(r.cost, r.loads)!, rev1k = per1k(r.siteRevenue, r.siteLoads)!;
    if (cost1k <= rev1k) return [];
    const impact = perMonth(((cost1k - rev1k) * r.loads) / 1000, days);
    return [{
      ruleKey: "source_above_revenue", objectKey: `site:${r.siteId}|source:${r.sourceSlug}`, scope: "source" as const, siteId: r.siteId, sourceSlug: r.sourceSlug,
      title: `${r.source} на ${r.domain}: трафик дороже, чем он приносит`,
      hypothesis: `Если срезать или переторговать источник до цены ниже ${cpm(rev1k)} за 1000 загрузок, минус исчезнет: за ${days} дн. 1000 загрузок стоили ${cpm(cost1k)}, а сайт зарабатывает ${cpm(rev1k)}.`,
      evidence: { days, costPer1k: round(cost1k), revPer1k: round(rev1k), loads: r.loads, cost: round(r.cost, 2) }, impactMonth: round(impact, 2),
      link: `/sites/${r.domain}?by=sources&preset=7d`, metric: "cost_per_1k" as const, level: levelOf(impact, "CRITICAL"), source: "AUTO" as const,
    }];
  });
}

export interface MarginTrendRow { siteId: string; domain: string; revenue: number; prevRevenue: number; margin: number; prevMargin: number; drops: { kind: "гео" | "сетка" | "формат"; name: string; delta: number }[] }
/** Margin fell by a fifth or more against the previous week; the evidence names the cut that fell the most. */
export function marginDrop(rows: MarginTrendRow[], days: number): HypothesisCandidate[] {
  return rows.filter((r) => r.prevRevenue > 50 && r.prevMargin > 0 && r.margin < r.prevMargin * 0.8).map((r) => {
    const worst = [...r.drops].sort((a, b) => a.delta - b.delta)[0];
    const impact = perMonth(r.prevMargin - r.margin, days);
    return {
      ruleKey: "margin_drop", objectKey: `site:${r.siteId}`, scope: "site" as const, siteId: r.siteId,
      title: `Маржа ${r.domain} упала на ${pct(1 - r.margin / r.prevMargin)} за неделю`,
      hypothesis: `Если вернуть то, что сломалось${worst ? ` — сильнее всего просел${worst.kind === "гео" ? "о" : worst.kind === "сетка" ? "а" : ""} ${worst.kind} ${worst.name} (${money(worst.delta)})` : ""}, маржа вернётся к ${money(r.prevMargin)} за ${days} дн. вместо ${money(r.margin)}.`,
      evidence: { days, margin: round(r.margin, 2), prevMargin: round(r.prevMargin, 2), revenue: round(r.revenue, 2), prevRevenue: round(r.prevRevenue, 2), drops: r.drops.slice(0, 3) },
      impactMonth: round(impact, 2), link: `/sites/${r.domain}?preset=7d`, metric: "margin" as const, level: levelOf(impact), source: "AUTO" as const,
    };
  });
}

export interface BundleCostRow { bundleId: string; title: string; slug: string; revenue: number; cost: number }
/** A bundle spending a far larger share of its revenue on traffic than the network does. */
export function bundleCostShare(rows: BundleCostRow[], network: { revenue: number; cost: number }, days: number): HypothesisCandidate[] {
  if (network.revenue <= 0) return [];
  const netShare = network.cost / network.revenue;
  return rows.filter((b) => b.revenue > 100 && b.cost / b.revenue >= netShare + 0.1).map((b) => {
    const share = b.cost / b.revenue;
    const impact = perMonth((share - netShare) * b.revenue, days);
    return {
      ruleKey: "bundle_cost_share", objectKey: `bundle:${b.bundleId}`, scope: "bundle" as const, bundleId: b.bundleId,
      title: `Бандл ${b.title} тратит на трафик ${pct(share)} выручки против ${pct(netShare)} по сети`,
      hypothesis: `Если привести закупку бандла к доле сети, маржа вырастет на разницу: за ${days} дн. расход ${money(b.cost)} при выручке ${money(b.revenue)}.`,
      evidence: { days, costShare: round(share), networkShare: round(netShare), revenue: round(b.revenue, 2), cost: round(b.cost, 2) },
      impactMonth: round(impact, 2), link: `/bundles/${b.slug}?preset=7d`, metric: "cost_share" as const, level: levelOf(impact), source: "AUTO" as const,
    };
  });
}

export interface DealRotationRow { dealId: string; title: string; advertiser: string; siteId: string; domain: string; format: string; dealRevenue: number; dealLoads: number; rotationPer1k: number | null }
/** A fixed deal paying less per 1000 loads than the rotation of the same format on the same site. */
export function dealBelowRotation(rows: DealRotationRow[], days: number, minLoads = 10_000): HypothesisCandidate[] {
  return rows.filter((r) => r.dealLoads >= minLoads && r.rotationPer1k != null && r.rotationPer1k > 0).flatMap((r) => {
    const deal1k = per1k(r.dealRevenue, r.dealLoads)!;
    if (deal1k >= r.rotationPer1k! * 0.7) return [];
    const impact = perMonth(((r.rotationPer1k! - deal1k) * r.dealLoads) / 1000, days);
    return [{
      ruleKey: "deal_below_rotation", objectKey: `deal:${r.dealId}|site:${r.siteId}`, scope: "deal" as const, siteId: r.siteId, dealId: r.dealId, format: r.format,
      title: `Дил ${r.advertiser} · ${r.title} на ${r.domain} дешевле ротации`,
      hypothesis: `Если поднять цену дила или вернуть место в ротацию, 1000 загрузок дадут ${cpm(r.rotationPer1k!)} вместо ${cpm(deal1k)}: столько приносит ротация формата ${r.format} на этом сайте за ${days} дн.`,
      evidence: { days, dealPer1k: round(deal1k), rotationPer1k: round(r.rotationPer1k!), dealLoads: r.dealLoads, dealRevenue: round(r.dealRevenue, 2) },
      impactMonth: round(impact, 2), link: `/deals/${r.dealId}`, metric: "rev_per_1k" as const, level: levelOf(impact), source: "AUTO" as const,
    }];
  });
}

/** Alerts win over rules about the same object (same ruleKey + objectKey; lists are given alerts first); then critical first, by effect. */
export function mergeCandidates(lists: HypothesisCandidate[][]): HypothesisCandidate[] {
  const seen = new Set<string>(), out: HypothesisCandidate[] = [];
  for (const r of lists.flat()) {
    const k = `${r.ruleKey}|${r.objectKey}`;
    if (seen.has(k)) continue;
    seen.add(k); out.push(r);
  }
  const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level] || b.impactMonth - a.impactMonth);
}
