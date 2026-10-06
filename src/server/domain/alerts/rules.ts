// Alert rules (docs/product/06-metrics.md#alerts). Plain SQL over the reporting views,
// evaluated nightly. Every candidate carries a link to the slice that produced it.
import Decimal from "decimal.js";
import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import { closedPeriods, addDays } from "@/server/domain/deals";

export type Level = "WARNING" | "CRITICAL";
export interface Candidate {
  rule: string; entityKey: string; level: Level; title: string; message: string; link: string;
  siteId: string | null; moneyAtRisk: number; payload: Record<string, unknown>;
  /** What to do — shown as the recommendation's action (never derived from the message text). */
  action: string;
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const money = (v: number) => `$${v.toFixed(2)}`;
const int = (v: number) => v.toLocaleString("ru-RU");
/** Country ZZ is "no country": per-site network cuts carry it. Alerts then speak about the site, not a country. */
const where = (cc: string, domain: string) => (cc === "ZZ" ? `на ${domain}` : `в ${cc} на ${domain}`);
const FORMAT_WORD: Record<string, string> = { POPUNDER: "Popunder", BANNER: "баннеров", NATIVE: "нативки", SLIDER: "слайдера", OUTSTREAM: "Outstream", INVIDEO: "In-video", INPAGEPUSH: "In-page push", OTHER: "прочих форматов" };
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const day = (s: string) => new Date(`${s}T00:00:00Z`);

export interface RuleContext { db: PrismaClient; asOf: string; configuredSources: string[] }

/**
 * 1. Loss-making geo: 7 days, revenue < cost, cost > $5, ≥ 10 000 loads. Only days the site has a
 * country cut (a day with just the ZZ total has no country revenue and would look like a loss).
 * ZZ cost (traffic sources, ADR 0006) is spread over the day's countries by loads, the same way the
 * geo table does it (ADR 0008), so the alert and the page agree. XX (unrecognised) is skipped.
 */
async function lossGeo({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; country_code: string; rev: unknown; cost: unknown; loads: unknown }[]>`
    WITH g AS (
      SELECT g.site_id, g.date, g.country_code, g.revenue, g.cost, g.page_loads
      FROM v_site_geo_daily g
      WHERE g.date >= ${day(addDays(asOf, -7))} AND g.date < ${day(asOf)} AND g.country_code <> 'XX'
        AND EXISTS (SELECT 1 FROM "FactRevenueGeo" r WHERE r."siteId" = g.site_id AND r.date = g.date AND r."countryCode" <> 'ZZ')
    ), zz AS (SELECT site_id, date, SUM(cost) zz_cost FROM g WHERE country_code = 'ZZ' GROUP BY 1, 2),
    tot AS (SELECT site_id, date, SUM(page_loads) loads FROM g WHERE country_code <> 'ZZ' GROUP BY 1, 2),
    c AS (
      SELECT g.site_id, g.country_code, g.revenue, g.page_loads,
             g.cost + COALESCE(zz.zz_cost, 0) * g.page_loads / NULLIF(tot.loads, 0) AS cost
      FROM g JOIN tot USING (site_id, date) LEFT JOIN zz USING (site_id, date) WHERE g.country_code <> 'ZZ'
    )
    SELECT c.site_id, s.domain, c.country_code, SUM(c.revenue) rev, SUM(c.cost) cost, SUM(c.page_loads) loads
    FROM c JOIN "Site" s ON s.id = c.site_id WHERE s.status <> 'ARCHIVED'
    GROUP BY 1, 2, 3 HAVING SUM(c.revenue) < SUM(c.cost) AND SUM(c.cost) > 5 AND SUM(c.page_loads) >= 10000`;
  return rows.map((r) => {
    const rev = n(r.rev), cost = n(r.cost), romi = ((rev - cost) / cost) * 100;
    return {
      rule: "loss_geo", entityKey: `site:${r.site_id}|country:${r.country_code}`, level: "CRITICAL",
      title: `Убыточное гео ${r.country_code} на ${r.domain}`,
      message: `За 7 дней выручка ${money(rev)} при расходе ${money(cost)} (ROMI ${romi.toFixed(1)}%, ${int(n(r.loads))} загрузок).`,
      action: "Снизить закупку гео или поднять флор.",
      link: `/sites/${r.domain}?by=geo&preset=7d`, siteId: r.site_id, moneyAtRisk: cost - rev,
      payload: { country: r.country_code, revenue: rev, cost, romi },
    };
  });
}

/** 2. Waterfall inversion: a network ranked below 3rd by price holds > 30% of volume. */
async function waterfallInversion({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; country_code: string; network_title: string; loads: unknown; vol_share: unknown; price_rank: unknown; rev_per_k: unknown; best: string }[]>`
    WITH a AS (
      SELECT g.site_id, g.country_code, g.network_id, g.network_title,
             SUM(g.revenue) / NULLIF(SUM(g.page_loads), 0) * 1000 AS rev_per_k,
             SUM(g.page_loads) AS loads,
             SUM(g.page_loads)::numeric / NULLIF(SUM(SUM(g.page_loads)) OVER (PARTITION BY g.site_id, g.country_code), 0) AS vol_share
      FROM v_network_geo g JOIN "Network" nw ON nw.id = g.network_id
      WHERE g.date >= ${day(addDays(asOf, -7))} AND g.date < ${day(asOf)} AND NOT nw."isSystem"
      GROUP BY 1, 2, 3, 4
    ), r AS (
      -- rank by price only among networks with a real share (≥ 5% of loads): a handful of expensive loads is noise, not a rank
      SELECT a.*, RANK() OVER (PARTITION BY site_id, country_code ORDER BY rev_per_k DESC NULLS LAST) AS price_rank FROM a WHERE vol_share >= 0.05
    )
    SELECT r.*, s.domain,
           (SELECT b.network_title FROM r b WHERE b.site_id = r.site_id AND b.country_code = r.country_code ORDER BY b.price_rank LIMIT 1) AS best
    FROM r JOIN "Site" s ON s.id = r.site_id
    WHERE r.price_rank > 3 AND r.vol_share > 0.30 AND r.loads > 10000 AND s.status <> 'ARCHIVED'`;
  return rows.map((r) => ({
    rule: "waterfall_inversion", entityKey: `site:${r.site_id}|country:${r.country_code}|net:${r.network_title}`, level: "WARNING",
    title: `Инверсия waterfall: ${r.network_title} ${where(r.country_code, r.domain)}`,
    message: `${r.network_title} — ${n(r.price_rank)}-я по цене, но держит ${pct(n(r.vol_share))} объёма.`,
    action: `Переставить ниже в waterfall, объём отдать ${r.best}.`,
    link: `/sites/${r.domain}?by=networks&preset=7d`, siteId: r.site_id, moneyAtRisk: 0,
    payload: { network: r.network_title, country: r.country_code, volShare: n(r.vol_share), rank: n(r.price_rank) },
  }));
}

/** 3. Discrepancy > 25% two days in a row with > 5000 impressions; negative & ×2 → critical. */
async function discrepancyRule({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; network_title: string; country_code: string; own: unknown; network: unknown; days: unknown }[]>`
    WITH d AS (
      SELECT g.date, g.site_id, g.network_title, g.country_code, SUM(g.imps_own) own, SUM(g.imps_network) network
      FROM v_network_geo g JOIN "Network" nw ON nw.id = g.network_id
      WHERE g.date >= ${day(addDays(asOf, -2))} AND g.date < ${day(asOf)} AND NOT nw."isSystem"
      GROUP BY 1, 2, 3, 4
      HAVING SUM(imps_own) > 5000 AND ABS(SUM(imps_own) - SUM(imps_network))::numeric / SUM(imps_own) > 0.25
    )
    SELECT d.site_id, s.domain, d.network_title, d.country_code, SUM(d.own) own, SUM(d.network) network, COUNT(*) days
    FROM d JOIN "Site" s ON s.id = d.site_id WHERE s.status <> 'ARCHIVED' GROUP BY 1, 2, 3, 4 HAVING COUNT(*) = 2`;
  return rows.map((r) => {
    const own = n(r.own), net = n(r.network), disc = (own - net) / own, mult = net / own;
    const critical = disc < 0 && mult > 2;
    return {
      rule: "discrepancy", entityKey: `site:${r.site_id}|country:${r.country_code}|net:${r.network_title}`,
      level: critical ? "CRITICAL" : "WARNING",
      title: `Дискрепанси ${pct(disc)}: ${r.network_title} ${where(r.country_code, r.domain)}`,
      message: `2 дня подряд: наши показы ${int(own)}, у сетки ${int(net)} (×${mult.toFixed(2)}).`,
      action: critical ? "Перевести дил на оплату за загрузку." : "Сверить счётчики.",
      link: `/sites/${r.domain}?by=networks&preset=7d`, siteId: r.site_id, moneyAtRisk: 0,
      payload: { own, network: net, discrepancy: disc, multiplier: mult },
    };
  });
}

/** Zones whose place on the site is sold through a deal: their zone revenue is not the measure of the place. */
const NOT_SOLD = `NOT EXISTS (SELECT 1 FROM "Zone" zz JOIN "DealPlace" dp ON dp."siteId" = zz."siteId" AND dp."placementSlug" = zz."placementSlug"
  JOIN "Deal" dd ON dd.id = dp."dealId" AND dd.status IN ('ACTIVE', 'PAUSED') WHERE zz.id = z.zone_id)`;
/** Below this the alert is noise: nothing worth acting on. */
const MIN_RISK = 5;

/**
 * 4. Invisible zone: BANNER/NATIVE with view rate < 15% on > 50 000 impressions in 7 days. Needs
 * real views (ADOK sends banner_view_rate; without it views are 0 and nothing can be said) and
 * revenue > 0: the estimate is the zone's own viewable CPM at 35% visibility, so with no revenue it
 * would read "$0 instead of $0". Zones sold through a deal are skipped.
 */
async function invisibleZone({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ zone_id: string; zone_name: string; site_id: string; domain: string; imps: unknown; views: unknown; revenue: unknown }[]>`
    SELECT z.zone_id, z.zone_name, z.site_id, s.domain, SUM(z.imps_own) imps, SUM(z.views) views, SUM(z.revenue) revenue
    FROM v_zone_daily z JOIN "Site" s ON s.id = z.site_id
    WHERE z.format IN ('BANNER', 'NATIVE') AND z.date >= ${day(addDays(asOf, -7))} AND z.date < ${day(asOf)} AND s.status <> 'ARCHIVED'
      AND ${raw(NOT_SOLD)}
    GROUP BY 1, 2, 3, 4
    HAVING SUM(z.imps_own) > 50000 AND SUM(z.views) > 0 AND SUM(z.revenue) > 0 AND SUM(z.views)::numeric / SUM(z.imps_own) < 0.15`;
  const out: Candidate[] = [];
  for (const r of rows) {
    const imps = n(r.imps), views = n(r.views), rev = n(r.revenue);
    const vcpm = (rev / views) * 1000;
    const potential = (vcpm * imps * 0.35) / 1000;
    if (potential - rev < MIN_RISK) continue;
    out.push({
      rule: "invisible_zone", entityKey: `zone:${r.zone_id}`, level: "WARNING",
      title: `Зона не видна: ${r.zone_name} на ${r.domain}`,
      message: `View rate ${pct(views / imps)}, viewable CPM $${vcpm.toFixed(4)}. При view rate 35% зона дала бы ≈${money(potential)} за 7 дней вместо ${money(rev)}.`,
      action: "Поднять зону выше фолда или перенести на другое место.",
      link: `/sites/${r.domain}?by=zones&preset=7d`, siteId: r.site_id, moneyAtRisk: potential - rev,
      payload: { viewRate: views / imps, viewableCpm: vcpm, potential },
    });
  }
  return out;
}

/**
 * 5. Dead zone: over 30 days under 1% of the revenue of the site's zones *of the same format* while
 * holding over 5% of their impressions (CPM is only comparable within a format, docs 06). Needs
 * ≥ 50 000 impressions, data in the last 3 days, an active zone, a live site, no deal on its place.
 * Money at risk = what the zone would earn at the format's CPM.
 */
async function deadZone({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ zone_id: string; zone_name: string; site_id: string; domain: string; format: string; rev: unknown; imps: unknown; rev_share: unknown; imp_share: unknown; fmt_cpm: unknown }[]>`
    WITH z AS (
      SELECT z.zone_id, z.zone_name, z.site_id, z.format, SUM(z.revenue) rev, SUM(z.imps_own) imps, MAX(z.date) last_day
      FROM v_zone_daily z JOIN "Zone" zo ON zo.id = z.zone_id
      WHERE z.date >= ${day(addDays(asOf, -30))} AND z.date < ${day(asOf)} AND zo."isActive" AND ${raw(NOT_SOLD)}
      GROUP BY 1, 2, 3, 4
    ), t AS (SELECT site_id, format, SUM(rev) rev, SUM(imps) imps, COUNT(*) zones FROM z GROUP BY 1, 2)
    SELECT z.zone_id, z.zone_name, z.site_id, s.domain, z.format, z.rev, z.imps,
           z.rev / NULLIF(t.rev, 0) rev_share, z.imps::numeric / NULLIF(t.imps, 0) imp_share,
           t.rev / NULLIF(t.imps, 0) * 1000 fmt_cpm
    FROM z JOIN t USING (site_id, format) JOIN "Site" s ON s.id = z.site_id
    WHERE s.status <> 'ARCHIVED' AND t.zones > 1 AND z.imps >= 50000 AND z.last_day >= ${day(addDays(asOf, -3))}
      AND z.rev / NULLIF(t.rev, 0) < 0.01 AND z.imps::numeric / NULLIF(t.imps, 0) > 0.05`;
  return rows.map((r) => {
    const rev = n(r.rev), imps = n(r.imps), fmtCpm = n(r.fmt_cpm);
    const risk = Math.max(0, (fmtCpm * imps) / 1000 - rev);
    return {
      rule: "dead_zone", entityKey: `zone:${r.zone_id}`, level: "WARNING",
      title: `Мёртвая зона: ${r.zone_name} на ${r.domain}`,
      message: `За 30 дней ${pct(n(r.rev_share))} выручки ${FORMAT_WORD[r.format] ?? r.format} сайта при ${pct(n(r.imp_share))} их показов (${money(rev)}; по CPM формата было бы ${money(risk + rev)}).`,
      action: "Снести зону или отдать место формату с более высоким CPM.",
      link: `/sites/${r.domain}?by=zones&preset=30d`, siteId: r.site_id, moneyAtRisk: risk,
      payload: { revShare: n(r.rev_share), impShare: n(r.imp_share), formatCpm: fmtCpm },
    };
  });
}

/** 6. Low fill: format fill rate < 25% with > 100 000 page loads in 7 days. */
async function lowFill({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; format: string; loads: unknown; imps: unknown }[]>`
    SELECT f.site_id, s.domain, f.format, SUM(f.page_loads) loads, SUM(f.imps_own) imps
    FROM v_format_daily f JOIN "Site" s ON s.id = f.site_id
    WHERE f.date >= ${day(addDays(asOf, -7))} AND f.date < ${day(asOf)} AND s.status <> 'ARCHIVED'
    GROUP BY 1, 2, 3 HAVING SUM(f.page_loads) > 100000 AND SUM(f.imps_own)::numeric / SUM(f.page_loads) < 0.25`;
  return rows.map((r) => ({
    rule: "low_fill", entityKey: `site:${r.site_id}|format:${r.format}`, level: "WARNING",
    title: `Низкий фил ${FORMAT_WORD[r.format] ?? r.format} на ${r.domain}`,
    message: `Fill rate ${pct(n(r.imps) / n(r.loads))} на ${int(n(r.loads))} запросах за 7 дней.`,
    action: "Подключить бэкфилл-сетку на формат.",
    link: `/sites/${r.domain}?by=formats&preset=7d`, siteId: r.site_id, moneyAtRisk: 0,
    payload: { fillRate: n(r.imps) / n(r.loads), loads: n(r.loads) },
  }));
}

/** 7. Deal period closed more than 7 days ago without advertiser numbers. */
async function dealNoNumbers({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const deals = await db.deal.findMany({ where: { status: { in: ["ACTIVE", "PAUSED", "ENDED"] } }, include: { periods: true, advertiser: true } });
  const out: Candidate[] = [];
  for (const d of deals) {
    const periods = closedPeriods({
      startsAt: d.startsAt.toISOString().slice(0, 10), endsAt: d.endsAt?.toISOString().slice(0, 10) ?? null, billingPeriod: d.billingPeriod,
    }, asOf);
    for (const p of periods) {
      if (p.to >= addDays(asOf, -7)) continue;
      const entered = d.periods.some((x) => !x.supersededById && x.status !== "OPEN" &&
        x.from.toISOString().slice(0, 10) <= p.from && x.to.toISOString().slice(0, 10) >= p.to);
      if (entered) continue;
      out.push({
        rule: "deal_no_numbers", entityKey: `deal:${d.id}|${p.from}`, level: "WARNING",
        title: `Нет цифр по дилу «${d.title}» за ${p.from} — ${p.to}`,
        message: `Период закрыт, отчёта ${d.advertiser.name} нет.`,
        action: "Запросить цифры у рекламодателя.",
        link: `/deals/${d.id}`, siteId: null, moneyAtRisk: 0, payload: { dealId: d.id, ...p },
      });
    }
  }
  return out;
}

/** 8. Invoice not paid after the due date; > 30 days overdue is critical. */
async function overduePayment({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const periods = await db.dealPeriod.findMany({
    where: { supersededById: null, status: { in: ["INVOICED", "PARTIAL", "DISPUTED"] }, dueAt: { lt: day(asOf) } },
    include: { deal: { include: { advertiser: true } } },
  });
  const out: Candidate[] = [];
  for (const p of periods) {
    const overdue = Math.round((day(asOf).getTime() - p.dueAt!.getTime()) / 86_400_000);
    const owed = new Decimal(p.amountInvoiced ?? 0).sub(p.amountPaid ?? 0).toNumber();
    if (owed <= 0) continue; // nothing is owed: paid in full or never invoiced
    out.push({
      rule: "overdue_payment", entityKey: `period:${p.id}`, level: overdue > 30 ? "CRITICAL" : "WARNING",
      title: `Просрочена оплата: ${p.deal.advertiser.name}, «${p.deal.title}»`,
      message: `Счёт ${p.invoiceNo ?? "без номера"} на ${money(owed)} просрочен на ${overdue} дн.`,
      action: "Напомнить рекламодателю об оплате.",
      link: `/deals/${p.dealId}`, siteId: null, moneyAtRisk: owed, payload: { periodId: p.id, overdue, owed },
    });
  }
  return out;
}

/** 9. Ingest down: last run of a configured source failed or is older than 3 hours. */
async function ingestDown({ db, configuredSources }: RuleContext): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const source of configuredSources) {
    const last = await db.ingestRun.findFirst({ where: { source, status: { not: "running" } }, orderBy: { startedAt: "desc" } });
    const lastOk = await db.ingestRun.findFirst({ where: { source, status: "ok" }, orderBy: { startedAt: "desc" } });
    const stale = !lastOk || Date.now() - lastOk.startedAt.getTime() > 3 * 3_600_000;
    if (last?.status !== "failed" && !stale) continue;
    out.push({
      rule: "ingest_down", entityKey: `source:${source}`, level: "CRITICAL",
      title: `Ингест ${source} не работает`,
      message: last?.status === "failed" ? `Последний запуск упал: ${last.error ?? "без текста ошибки"}` : "Нет успешных загрузок больше 3 часов.",
      action: "Проверить ключи и запуски на странице «Интеграции».",
      link: "/settings/integrations", siteId: null, moneyAtRisk: 0, payload: { source, lastRunId: last?.id ?? null },
    });
  }
  return out;
}

/**
 * 10. A deal with an end date is about to end: 7, 3 and 1 day(s) before, and once the date has
 * passed while the deal is still active. `payload.stage` (7 / 3 / 1 / 0) changes at each
 * threshold; evaluateAlerts treats a stage change as a new notification (fresh firstSeenAt,
 * snooze cleared). Money at risk = the deal's revenue over the last 30 days.
 */
async function dealEnding({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const deals = await db.deal.findMany({
    where: { status: { in: ["ACTIVE", "PAUSED"] }, endsAt: { not: null, lte: day(addDays(asOf, 7)) } },
    include: { advertiser: true, places: { include: { placement: true } }, sites: true },
  });
  const out: Candidate[] = [];
  for (const d of deals) {
    const endsAt = d.endsAt!.toISOString().slice(0, 10);
    const daysLeft = Math.round((day(endsAt).getTime() - day(asOf).getTime()) / 86_400_000);
    const stage = daysLeft < 0 ? 0 : daysLeft <= 1 ? 1 : daysLeft <= 3 ? 3 : 7;
    const recent = await db.factFixDeal.aggregate({ _sum: { revenue: true }, where: { dealId: d.id, date: { gte: day(addDays(asOf, -30)), lt: day(asOf) } } });
    const risk = n(recent._sum.revenue);
    const placeTitles = [...new Set(d.places.map((p) => p.placement.title))].sort();
    const where = `${placeTitles.length ? `${placeTitles.join(", ")}, ` : ""}${d.sites.length} ${d.sites.length === 1 ? "сайт" : "сайтов"}`;
    const terms = `${d.advertiser.name}, $${d.price.toString()} ${BASIS_WORD[d.paymentBasis] ?? d.paymentBasis}`;
    const ended = stage === 0;
    out.push({
      rule: "deal_ending", entityKey: `deal:${d.id}|end:${endsAt}`, level: stage === 7 ? "WARNING" : "CRITICAL",
      title: ended
        ? `Фикс-дил «${d.title}» закончился ${-daysLeft} дн. назад, статус всё ещё активен`
        : `Фикс-дил «${d.title}» заканчивается через ${daysLeft} дн.`,
      message: `${terms} · ${where} · до ${endsAt}.${risk > 0 ? ` За 30 дней принёс ${money(risk)}.` : ""}`,
      action: ended ? "Продлить дил (новая дата конца) или завершить его и освободить место." : "Договориться о продлении или освободить место.",
      link: `/deals/${d.id}`, siteId: null, moneyAtRisk: risk,
      payload: { dealId: d.id, stage, daysLeft, endsAt, advertiser: d.advertiser.name, placement: placeTitles.join(", ") || null },
    });
  }
  return out;
}

/**
 * 11. A traffic source AdSpyglass reported in the last 7 days whose cost share nobody has confirmed:
 * new sources start at 100% (all the sum paid back), which is right for bought traffic and wrong
 * for anything else, so until the owner sets the share the site's margin on that traffic is unknown.
 */
async function sourceUnconfigured({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ slug: string; title: string; rev_share: unknown; sum: unknown; sites: unknown }[]>`
    SELECT c.slug, c.title, c."revShare" rev_share, SUM(f."revenueReported") sum, COUNT(DISTINCT f."siteId") sites
    FROM "CostSource" c JOIN "FactTrafficSource" f ON f."sourceSlug" = c.slug
    WHERE NOT c.confirmed AND f.date >= ${day(addDays(asOf, -7))} AND f.date < ${day(asOf)}
    GROUP BY 1, 2, 3 HAVING SUM(f."revenueReported") > 0`;
  return rows.map((r) => ({
    rule: "source_unconfigured", entityKey: `source:${r.slug}`, level: "WARNING",
    title: `Источник «${r.title}»: доля расхода не подтверждена`,
    message: `За 7 дней принёс ${money(n(r.sum))} на ${int(n(r.sites))} сайтах; в расход идёт ${pct(n(r.rev_share))} этой суммы по умолчанию.`,
    action: "Задать долю расхода источника в Настройки → Расход (0% — бесплатный трафик).",
    link: "/settings/costs", siteId: null, moneyAtRisk: n(r.sum) * n(r.rev_share), payload: { source: r.slug, revShare: n(r.rev_share) },
  }));
}

/** Raw SQL fragment inside a tagged query. */
const raw = (sql: string) => Prisma.raw(sql);

const BASIS_WORD: Record<string, string> = {
  PER_1000_LOADS: "за 1000 загрузок", CPM_ADVERTISER: "CPM по счётчику рекл.", CPM_OWN: "CPM по нашему", FLAT_DAILY: "в сутки", FLAT_PERIOD: "за период",
};

export const RULES = { lossGeo, waterfallInversion, discrepancyRule, invisibleZone, deadZone, lowFill, dealNoNumbers, overduePayment, ingestDown, dealEnding, sourceUnconfigured };
/** Rules whose silence means "no data", not "all good", when yesterday has no per-site cut. */
const DATA_RULES = new Set(["loss_geo", "waterfall_inversion", "discrepancy", "invisible_zone", "dead_zone", "low_fill"]);

export async function collectCandidates(ctx: RuleContext): Promise<Candidate[]> {
  const all = await Promise.all(Object.values(RULES).map((r) => r(ctx)));
  return all.flat();
}

/**
 * Upserts candidates by (rule, entityKey). Alerts not produced this run are resolved (data rules
 * only when yesterday's per-site cut exists).
 * A snoozed alert comes back early if money at risk more than doubled since snoozing.
 */
export async function evaluateAlerts(ctx: RuleContext): Promise<{ active: number; resolved: number }> {
  const { db } = ctx;
  const cands = await collectCandidates(ctx);
  const now = new Date();
  const seen = new Set<string>();
  for (const c of cands) {
    seen.add(`${c.rule}|${c.entityKey}`);
    const existing = await db.alert.findUnique({ where: { rule_entityKey: { rule: c.rule, entityKey: c.entityKey } } });
    const wake = existing?.snoozedUntil && existing.snoozedRisk != null && c.moneyAtRisk > 2 * Number(existing.snoozedRisk) && c.moneyAtRisk > 0;
    // A rule that moves through stages (deal_ending: 7 → 3 → 1 → 0) is a new notification at each one.
    const prevStage = (existing?.payload as Record<string, unknown> | null)?.stage;
    const restage = existing != null && c.payload.stage !== undefined && prevStage !== c.payload.stage;
    const data = {
      level: c.level, title: c.title, message: c.message, link: c.link, siteId: c.siteId,
      moneyAtRisk: c.moneyAtRisk.toFixed(4), payload: { ...c.payload, action: c.action } as object, lastSeenAt: now,
    };
    if (!existing) await db.alert.create({ data: { rule: c.rule, entityKey: c.entityKey, ...data } });
    else await db.alert.update({
      where: { id: existing.id },
      data: { ...data, resolvedAt: null, firstSeenAt: existing.resolvedAt || restage ? now : existing.firstSeenAt,
        ...(wake || restage ? { snoozedUntil: null, snoozedRisk: null } : {}) },
    });
  }
  // A missing nightly cut makes the data rules silent; that is not "resolved", so those alerts stay until data is back.
  const cut = await db.factRevenueGeo.count({ where: { date: day(addDays(ctx.asOf, -1)), countryCode: { not: "ZZ" } }, take: 1 });
  const open = await db.alert.findMany({ where: { resolvedAt: null }, select: { id: true, rule: true, entityKey: true } });
  const stale = open.filter((a) => !seen.has(`${a.rule}|${a.entityKey}`) && (cut > 0 || !DATA_RULES.has(a.rule))).map((a) => a.id);
  if (stale.length) await db.alert.updateMany({ where: { id: { in: stale } }, data: { resolvedAt: now } });
  return { active: seen.size, resolved: stale.length };
}

/** "Принято к сведению": hides an alert for 30 days, remembering money at risk at that moment. */
export async function snoozeAlert(db: PrismaClient, id: string, days = 30): Promise<void> {
  const a = await db.alert.findUniqueOrThrow({ where: { id } });
  await db.alert.update({ where: { id }, data: { snoozedUntil: new Date(Date.now() + days * 86_400_000), snoozedRisk: a.moneyAtRisk } });
}
