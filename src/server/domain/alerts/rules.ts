// Alert rules (docs/product/06-metrics.md#alerts). Plain SQL over the reporting views,
// evaluated nightly. Every candidate carries a link to the slice that produced it.
import Decimal from "decimal.js";
import type { PrismaClient } from "@/generated/prisma/client";
import { closedPeriods, addDays } from "@/server/domain/deals";

export type Level = "WARNING" | "CRITICAL";
export interface Candidate {
  rule: string; entityKey: string; level: Level; title: string; message: string; link: string;
  siteId: string | null; moneyAtRisk: number; payload: Record<string, unknown>;
}

const n = (v: unknown) => (v == null ? 0 : Number(v));
const money = (v: number) => `$${v.toFixed(2)}`;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const day = (s: string) => new Date(`${s}T00:00:00Z`);

export interface RuleContext { db: PrismaClient; asOf: string; configuredSources: string[] }

/** 1. Loss-making geo: 7 days, revenue < cost and cost > $5. */
async function lossGeo({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; country_code: string; rev: unknown; cost: unknown }[]>`
    SELECT g.site_id, s.domain, g.country_code, SUM(g.revenue) rev, SUM(g.cost) cost
    FROM v_site_geo_daily g JOIN "Site" s ON s.id = g.site_id
    WHERE g.date >= ${day(addDays(asOf, -7))} AND g.date < ${day(asOf)} AND g.cost > 0
    GROUP BY 1, 2, 3 HAVING SUM(g.revenue) < SUM(g.cost) AND SUM(g.cost) > 5`;
  return rows.map((r) => {
    const rev = n(r.rev), cost = n(r.cost), romi = ((rev - cost) / cost) * 100;
    return {
      rule: "loss_geo", entityKey: `site:${r.site_id}|country:${r.country_code}`, level: "CRITICAL",
      title: `Убыточное гео ${r.country_code} на ${r.domain}`,
      message: `За 7 дней выручка ${money(rev)} при расходе ${money(cost)} (ROMI ${romi.toFixed(1)}%). Снизить закупку гео или поднять флор.`,
      link: `/sites/${r.domain}?by=geo&preset=7d`, siteId: r.site_id, moneyAtRisk: cost - rev,
      payload: { country: r.country_code, revenue: rev, cost, romi },
    };
  });
}

/** 2. Waterfall inversion: a network ranked below 3rd by price holds > 30% of volume. */
async function waterfallInversion({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; country_code: string; network_title: string; loads: unknown; vol_share: unknown; price_rank: unknown; rev_per_k: unknown; best: string }[]>`
    WITH r AS (
      SELECT site_id, country_code, network_id, network_title,
             SUM(revenue) / NULLIF(SUM(page_loads), 0) * 1000 AS rev_per_k,
             SUM(page_loads) AS loads,
             SUM(page_loads)::numeric / NULLIF(SUM(SUM(page_loads)) OVER (PARTITION BY site_id, country_code), 0) AS vol_share,
             RANK() OVER (PARTITION BY site_id, country_code ORDER BY SUM(revenue) / NULLIF(SUM(page_loads), 0) DESC NULLS LAST) AS price_rank
      FROM v_network_geo
      WHERE date >= ${day(addDays(asOf, -7))} AND date < ${day(asOf)}
      GROUP BY 1, 2, 3, 4
    )
    SELECT r.*, s.domain,
           (SELECT b.network_title FROM r b WHERE b.site_id = r.site_id AND b.country_code = r.country_code ORDER BY b.price_rank LIMIT 1) AS best
    FROM r JOIN "Site" s ON s.id = r.site_id
    WHERE r.price_rank > 3 AND r.vol_share > 0.30 AND r.loads > 10000`;
  return rows.map((r) => ({
    rule: "waterfall_inversion", entityKey: `site:${r.site_id}|country:${r.country_code}|net:${r.network_title}`, level: "WARNING",
    title: `Инверсия waterfall: ${r.network_title} в ${r.country_code} на ${r.domain}`,
    message: `${r.network_title} — ${n(r.price_rank)}-я по цене, но держит ${pct(n(r.vol_share))} объёма. Переставить ниже в waterfall, объём отдать ${r.best}.`,
    link: `/sites/${r.domain}?by=networks&preset=7d`, siteId: r.site_id, moneyAtRisk: 0,
    payload: { network: r.network_title, country: r.country_code, volShare: n(r.vol_share), rank: n(r.price_rank) },
  }));
}

/** 3. Discrepancy > 25% two days in a row with > 5000 impressions; negative & ×2 → critical. */
async function discrepancyRule({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; network_title: string; country_code: string; own: unknown; network: unknown; days: unknown }[]>`
    WITH d AS (
      SELECT date, site_id, network_title, country_code, SUM(imps_own) own, SUM(imps_network) network
      FROM v_network_geo WHERE date >= ${day(addDays(asOf, -2))} AND date < ${day(asOf)}
      GROUP BY 1, 2, 3, 4
      HAVING SUM(imps_own) > 5000 AND ABS(SUM(imps_own) - SUM(imps_network))::numeric / SUM(imps_own) > 0.25
    )
    SELECT d.site_id, s.domain, d.network_title, d.country_code, SUM(d.own) own, SUM(d.network) network, COUNT(*) days
    FROM d JOIN "Site" s ON s.id = d.site_id GROUP BY 1, 2, 3, 4 HAVING COUNT(*) = 2`;
  return rows.map((r) => {
    const own = n(r.own), net = n(r.network), disc = (own - net) / own, mult = net / own;
    const critical = disc < 0 && mult > 2;
    return {
      rule: "discrepancy", entityKey: `site:${r.site_id}|country:${r.country_code}|net:${r.network_title}`,
      level: critical ? "CRITICAL" : "WARNING",
      title: `Дискрепанси ${pct(disc)}: ${r.network_title}, ${r.country_code}, ${r.domain}`,
      message: `2 дня подряд: наши показы ${own.toLocaleString("en")}, у сетки ${net.toLocaleString("en")} (×${mult.toFixed(2)}).` +
        (critical ? " Перевести дил на оплату за загрузку." : " Сверить счётчики."),
      link: `/sites/${r.domain}?by=networks&preset=7d`, siteId: r.site_id, moneyAtRisk: 0,
      payload: { own, network: net, discrepancy: disc, multiplier: mult },
    };
  });
}

/** 4. Invisible zone: BANNER/NATIVE with view rate < 15% on > 50 000 impressions in 7 days. */
async function invisibleZone({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ zone_id: string; zone_name: string; site_id: string; domain: string; imps: unknown; views: unknown; revenue: unknown }[]>`
    SELECT z.zone_id, z.zone_name, z.site_id, s.domain, SUM(z.imps_own) imps, SUM(z.views) views, SUM(z.revenue) revenue
    FROM v_zone_daily z JOIN "Site" s ON s.id = z.site_id
    WHERE z.format IN ('BANNER', 'NATIVE') AND z.date >= ${day(addDays(asOf, -7))} AND z.date < ${day(asOf)}
    GROUP BY 1, 2, 3, 4
    HAVING SUM(z.imps_own) > 50000 AND SUM(z.views)::numeric / SUM(z.imps_own) < 0.15`;
  return rows.map((r) => {
    const imps = n(r.imps), views = n(r.views), rev = n(r.revenue);
    const vcpm = views > 0 ? (rev / views) * 1000 : 0;
    const potential = (vcpm * imps * 0.35) / 1000;
    return {
      rule: "invisible_zone", entityKey: `zone:${r.zone_id}`, level: "WARNING",
      title: `Зона не видна: ${r.zone_name} на ${r.domain}`,
      message: `View rate ${pct(views / imps)}, viewable CPM $${vcpm.toFixed(4)}. При view rate 35% зона дала бы ≈${money(potential)} за 7 дней вместо ${money(rev)}.`,
      link: `/sites/${r.domain}?by=zones&preset=7d`, siteId: r.site_id, moneyAtRisk: Math.max(0, potential - rev),
      payload: { viewRate: views / imps, viewableCpm: vcpm, potential },
    };
  });
}

/** 5. Dead zone: < 1% of site revenue but > 5% of its impressions over 30 days. */
async function deadZone({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ zone_id: string; zone_name: string; site_id: string; domain: string; rev_share: unknown; imp_share: unknown }[]>`
    WITH z AS (
      SELECT zone_id, zone_name, site_id, SUM(revenue) rev, SUM(imps_own) imps
      FROM v_zone_daily WHERE date >= ${day(addDays(asOf, -30))} AND date < ${day(asOf)} GROUP BY 1, 2, 3
    ), t AS (SELECT site_id, SUM(rev) rev, SUM(imps) imps FROM z GROUP BY 1)
    SELECT z.zone_id, z.zone_name, z.site_id, s.domain,
           z.rev / NULLIF(t.rev, 0) rev_share, z.imps::numeric / NULLIF(t.imps, 0) imp_share
    FROM z JOIN t USING (site_id) JOIN "Site" s ON s.id = z.site_id
    WHERE z.rev / NULLIF(t.rev, 0) < 0.01 AND z.imps::numeric / NULLIF(t.imps, 0) > 0.05`;
  return rows.map((r) => ({
    rule: "dead_zone", entityKey: `zone:${r.zone_id}`, level: "WARNING",
    title: `Мёртвая зона: ${r.zone_name} на ${r.domain}`,
    message: `За 30 дней ${pct(n(r.rev_share))} выручки сайта при ${pct(n(r.imp_share))} показов. Снести и отдать место формату с более высоким CPM.`,
    link: `/sites/${r.domain}?by=zones&preset=30d`, siteId: r.site_id, moneyAtRisk: 0,
    payload: { revShare: n(r.rev_share), impShare: n(r.imp_share) },
  }));
}

/** 6. Low fill: format fill rate < 25% with > 100 000 page loads in 7 days. */
async function lowFill({ db, asOf }: RuleContext): Promise<Candidate[]> {
  const rows = await db.$queryRaw<{ site_id: string; domain: string; format: string; loads: unknown; imps: unknown }[]>`
    SELECT f.site_id, s.domain, f.format, SUM(f.page_loads) loads, SUM(f.imps_own) imps
    FROM v_format_daily f JOIN "Site" s ON s.id = f.site_id
    WHERE f.date >= ${day(addDays(asOf, -7))} AND f.date < ${day(asOf)}
    GROUP BY 1, 2, 3 HAVING SUM(f.page_loads) > 100000 AND SUM(f.imps_own)::numeric / SUM(f.page_loads) < 0.25`;
  return rows.map((r) => ({
    rule: "low_fill", entityKey: `site:${r.site_id}|format:${r.format}`, level: "WARNING",
    title: `Низкий фил ${r.format} на ${r.domain}`,
    message: `Fill rate ${pct(n(r.imps) / n(r.loads))} на ${n(r.loads).toLocaleString("en")} запросах за 7 дней. Подключить бэкфилл.`,
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
        message: `Период закрыт, отчёта ${d.advertiser.name} нет. Запросить цифры у рекламодателя.`,
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
  return periods.map((p) => {
    const overdue = Math.round((day(asOf).getTime() - p.dueAt!.getTime()) / 86_400_000);
    const owed = new Decimal(p.amountInvoiced ?? 0).sub(p.amountPaid ?? 0).toNumber();
    return {
      rule: "overdue_payment", entityKey: `period:${p.id}`, level: overdue > 30 ? "CRITICAL" : "WARNING",
      title: `Просрочена оплата: ${p.deal.advertiser.name}, «${p.deal.title}»`,
      message: `Счёт ${p.invoiceNo ?? "без номера"} на ${money(owed)} просрочен на ${overdue} дн. Напомнить рекламодателю.`,
      link: `/deals/${p.dealId}`, siteId: null, moneyAtRisk: owed, payload: { periodId: p.id, overdue, owed },
    };
  });
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
      link: "/settings/integrations", siteId: null, moneyAtRisk: 0, payload: { source, lastRunId: last?.id ?? null },
    });
  }
  return out;
}

export const RULES = { lossGeo, waterfallInversion, discrepancyRule, invisibleZone, deadZone, lowFill, dealNoNumbers, overduePayment, ingestDown };

export async function collectCandidates(ctx: RuleContext): Promise<Candidate[]> {
  const all = await Promise.all(Object.values(RULES).map((r) => r(ctx)));
  return all.flat();
}

/**
 * Upserts candidates by (rule, entityKey). Alerts not produced this run are resolved.
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
    const data = {
      level: c.level, title: c.title, message: c.message, link: c.link, siteId: c.siteId,
      moneyAtRisk: c.moneyAtRisk.toFixed(4), payload: c.payload as object, lastSeenAt: now,
    };
    if (!existing) await db.alert.create({ data: { rule: c.rule, entityKey: c.entityKey, ...data } });
    else await db.alert.update({
      where: { id: existing.id },
      data: { ...data, resolvedAt: null, firstSeenAt: existing.resolvedAt ? now : existing.firstSeenAt,
        ...(wake ? { snoozedUntil: null, snoozedRisk: null } : {}) },
    });
  }
  const open = await db.alert.findMany({ where: { resolvedAt: null }, select: { id: true, rule: true, entityKey: true } });
  const stale = open.filter((a) => !seen.has(`${a.rule}|${a.entityKey}`)).map((a) => a.id);
  if (stale.length) await db.alert.updateMany({ where: { id: { in: stale } }, data: { resolvedAt: now } });
  return { active: seen.size, resolved: stale.length };
}

/** "Принято к сведению": hides an alert for 30 days, remembering money at risk at that moment. */
export async function snoozeAlert(db: PrismaClient, id: string, days = 30): Promise<void> {
  const a = await db.alert.findUniqueOrThrow({ where: { id } });
  await db.alert.update({ where: { id }, data: { snoozedUntil: new Date(Date.now() + days * 86_400_000), snoozedRisk: a.moneyAtRisk } });
}
