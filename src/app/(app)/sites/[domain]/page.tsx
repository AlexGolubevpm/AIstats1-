import { ExternalLink, FlaskConical } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { TrendChart } from "@/components/data/charts";
import { DataTable } from "@/components/data/data-table";
import type { Column } from "@/components/data/format-cell";
import { KpiRow } from "@/components/data/kpi-row";
import { AlertBadge, BreakdownTabs, MoneyStatus, StatusBadge } from "@/components/data/misc";
import { PageHeader } from "@/components/layout/page-header";
import { DEVICE_LABEL, FORMAT_COLS, FORMAT_LABEL, GEO_COLS, NETWORK_COLS, geoRows } from "@/components/pages/columns";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { fmtDate, fmtInt, fmtMoney, fmtMultiplier } from "@/lib/format";
import { dealMultiplier } from "@/lib/metrics";
import { periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { D, costCoverage, dailyTotals, kpis } from "@/server/queries/common";
import { SCOPE_LABEL, SOURCE_LABEL, STATUS_LABEL, type HypScope } from "@/server/domain/hypotheses";
import { siteHypotheses } from "@/server/queries/hypotheses";
import { devicesTable, formatsTable, hoursTable, networksTable, siteGeoWithNetworks, sourcesTable, techTable, zonesTable } from "@/server/queries/reports";
import { SnoozeButton } from "../../alerts/snooze";
import { HypothesisActions, ToHypothesisButton } from "../../hypotheses/client";

type Props = { params: Promise<{ domain: string }>; searchParams: Promise<Record<string, string | undefined>> };
const TABS = [{ id: "zones", label: "Зоны" }, { id: "formats", label: "Форматы" }, { id: "networks", label: "Сетки" }, { id: "geo", label: "Гео" }, { id: "devices", label: "Девайсы" },
  { id: "platforms", label: "Платформы" }, { id: "hours", label: "Часы" }, { id: "sources", label: "Источники" }];
const TECH_COLS: Column[] = [
  { id: "name", header: "Платформа", kind: "text" }, { id: "pageLoads", header: "Page loads", kind: "int" }, { id: "loadsShare", header: "Доля трафика", kind: "share" },
  { id: "imps", header: "Показы", kind: "int" }, { id: "fillRate", header: "Fill rate", kind: "percent" }, { id: "ctr", header: "CTR", kind: "percent", tooltip: "Клики / показы" },
  { id: "revPer1k", header: "Rev/1000 loads", kind: "cpm" }, { id: "cpm", header: "CPM", kind: "cpm" }, { id: "revenue", header: "Выручка", kind: "money" }, { id: "share", header: "Доля", kind: "share" },
];
const HOUR_COLS: Column[] = [
  { id: "label", header: "Час (UTC)", kind: "text" }, { id: "loadsPerDay", header: "Page loads / день", kind: "int" }, { id: "loadsShare", header: "Доля трафика", kind: "share" },
  { id: "fillRate", header: "Fill rate", kind: "percent" }, { id: "ctr", header: "CTR", kind: "percent", tooltip: "Клики / показы" }, { id: "revPer1k", header: "Rev/1000 loads", kind: "cpm" },
  { id: "revenuePerDay", header: "Выручка / день", kind: "money" }, { id: "share", header: "Доля выручки", kind: "share" },
];

const ZONE_COLS: Column[] = [
  { id: "zone", header: "Зона", kind: "text" }, { id: "format", header: "Формат", kind: "text" }, { id: "position", header: "Позиция", kind: "text" },
  { id: "imps", header: "Показы", kind: "int" }, { id: "views", header: "Видимые", kind: "int" }, { id: "viewRate", header: "View rate", kind: "percent" },
  { id: "ctr", header: "CTR", kind: "percent", tooltip: "Клики / показы" },
  { id: "cpm", header: "CPM", kind: "cpm" }, { id: "viewableCpm", header: "Viewable CPM", kind: "cpm" }, { id: "revenue", header: "Выручка", kind: "money" },
  { id: "share", header: "Доля", kind: "share" },
];
const SOURCE_COLS: Column[] = [
  { id: "source", header: "Источник трафика", kind: "text" }, { id: "loads", header: "Page loads", kind: "int" }, { id: "loadsShare", header: "Доля трафика", kind: "share" },
  { id: "reported", header: "Сумма в ADOK", kind: "money", tooltip: "Поле, которое ADOK называет «выручкой» источника — по словам владельца, это сколько заплачено источнику" },
  { id: "revShare", header: "В расход", kind: "share", tooltip: "Доля суммы ADOK, идущая в расход: Настройки → Расход. 0% — бесплатный трафик (Direct, Organic SE, No source)" },
  { id: "cost", header: "Расход", kind: "money", tooltip: "Сумма в ADOK × доля" },
  { id: "costPer1k", header: "Цена 1000 loads", kind: "cpm" }, { id: "share", header: "Доля расхода", kind: "share" },
];
const NESTED_NET: Column[] = [
  { id: "network", header: "Сетка", kind: "text", tooltip: "ADOK не даёт сетку × страну: показаны сетки сайта за период" }, { id: "pageLoads", header: "Page loads", kind: "int" }, { id: "volShare", header: "Доля объёма", kind: "share" },
  { id: "revPer1k", header: "Rev/1000 loads", kind: "cpm" }, { id: "rank", header: "Ранг", kind: "int" }, { id: "discrepancy", header: "Дискрепанси", kind: "discrepancy" },
  { id: "revenue", header: "Выручка", kind: "money" },
];

export default async function SitePage({ params, searchParams }: Props) {
  const { domain } = await params;
  const sp = await searchParams;
  const p = periodFromParams(sp, "7d");
  const site = await db.site.findUnique({ where: { domain: decodeURIComponent(domain) }, include: { bundles: { include: { bundle: true } } } });
  if (!site) notFound();
  const by = TABS.some((t) => t.id === sp.by) ? sp.by! : "zones";
  const scope = { siteIds: [site.id] };
  const now = new Date();
  const [k, daily, allAlerts, coverage, dealFacts, hyps] = await Promise.all([
    kpis(p, scope), dailyTotals(p, scope),
    db.alert.findMany({ where: { siteId: site.id, resolvedAt: null }, orderBy: [{ level: "desc" }, { moneyAtRisk: "desc" }] }),
    costCoverage(p, scope),
    db.factFixDeal.groupBy({ by: ["dealId", "revenueState"], where: { siteId: site.id, date: { gte: D(p.from), lte: D(p.to) } },
      _sum: { revenue: true, impsOwn: true, impsReported: true } }),
    siteHypotheses(site.id),
  ]);
  // «Принято к сведению» hides an alert here as on /alerts; the header says how many are hidden.
  const alerts = allAlerts.filter((a) => !(a.snoozedUntil && a.snoozedUntil > now));
  const hiddenAlerts = allAlerts.length - alerts.length;
  const inHypotheses = new Set((await db.hypothesis.findMany({ where: { siteId: site.id, status: { in: ["PROPOSED", "ACCEPTED"] }, source: "ALERT" }, select: { ruleKey: true, objectKey: true } }))
    .map((h) => `${h.ruleKey}|${h.objectKey}`));
  // A zone with an open «мёртвая зона» alert wears the badge whatever the chosen period shows.
  const deadZoneAlerts = new Set(allAlerts.filter((a) => a.rule === "dead_zone").map((a) => a.entityKey.replace(/^zone:/, "")));
  // Every deal that is on the site or earned on it in the period — so the fix-deal money in the KPIs is always explained
  // by this list (an ended deal keeps its accruals for the days it ran; a detached one is labelled).
  const deals = await db.deal.findMany({ where: { OR: [{ sites: { some: { siteId: site.id } }, status: { in: ["ACTIVE", "PAUSED"] } }, { id: { in: dealFacts.map((f) => f.dealId) } }] },
    include: { advertiser: true, sites: { where: { siteId: site.id } } } });
  // The multiplier compares only days the advertiser reported (forecast days would drag it down), like factSums on /deals.
  const reportedFacts = await db.factFixDeal.groupBy({ by: ["dealId"], where: { siteId: site.id, date: { gte: D(p.from), lte: D(p.to) }, impsReported: { gt: 0 } },
    _sum: { impsOwn: true, impsReported: true } });

  let table: React.ReactNode;
  if (by === "zones") {
    const z = await zonesTable(p, site.id);
    table = <DataTable id="z" exportName={`${site.domain}-zones`} defaultSort={{ id: "revenue", dir: "desc" }} columns={ZONE_COLS}
      rows={z.map((r) => ({ ...r, format: FORMAT_LABEL[r.format] ?? r.format, _key: r.id,
        _badges: { zone: [...(r.candidateRemove || deadZoneAlerts.has(r.id) ? [{ label: "кандидат на снос", tone: "warning" as const }] : []), ...(r.invisible ? [{ label: "не видна", tone: "negative" as const }] : [])] } }))} />;
  } else if (by === "formats") {
    const f = await formatsTable(p, scope);
    table = <DataTable id="f" exportName={`${site.domain}-formats`} defaultSort={{ id: "revenue", dir: "desc" }} columns={FORMAT_COLS}
      rows={f.map((r) => ({ ...r, format: FORMAT_LABEL[r.format] ?? r.format, _key: r.format }))} />;
  } else if (by === "networks") {
    const n = await networksTable(p, scope);
    table = <DataTable id="n" exportName={`${site.domain}-networks`} defaultSort={{ id: "revenue", dir: "desc" }}
      columns={[...NETWORK_COLS, { id: "floor", header: "Флор", kind: "cpm", tooltip: "60-й перцентиль rev/1000 loads двух лучших источников" }]}
      rows={n.map((r) => ({ ...r, _key: r.slug, _warn: r.inverted, _badges: { network: r.belowFloor ? [{ label: "ниже флора", tone: "warning" as const }] : [] } }))} />;
  } else if (by === "geo") {
    const g = await siteGeoWithNetworks(p, site.id);
    table = <DataTable id="g" exportName={`${site.domain}-geo`} defaultSort={{ id: "pageLoads", dir: "desc" }} columns={GEO_COLS} nestedColumns={NESTED_NET}
      rows={geoRows(g).map((r) => ({ ...r, _children: r.children }))} filters={[{ id: "loss", label: "Только убыточные", column: "margin", op: "lt", value: 0 }]} />;
  } else if (by === "platforms") {
    const [os, browsers] = await Promise.all([techTable(p, site.id, "PLATFORM"), techTable(p, site.id, "BROWSER")]);
    table = (
      <div className="flex flex-col gap-4">
        {os.length === 0 && browsers.length === 0 && <p className="px-5 py-6 text-center text-sm text-muted">Разрезы по платформам и браузерам ещё не загружены — они включаются в плане «Разрезы ADOK» на Интеграциях и приходят ночью</p>}
        {os.length > 0 && <DataTable id="os" exportName={`${site.domain}-platforms`} defaultSort={{ id: "revenue", dir: "desc" }} columns={TECH_COLS} rows={os.map((r) => ({ ...r, _key: r.name }))} />}
        {browsers.length > 0 && <DataTable id="br" exportName={`${site.domain}-browsers`} defaultSort={{ id: "revenue", dir: "desc" }} columns={[{ ...TECH_COLS[0], header: "Браузер" }, ...TECH_COLS.slice(1)]} rows={browsers.map((r) => ({ ...r, _key: r.name }))} />}
      </div>
    );
  } else if (by === "hours") {
    const h = await hoursTable(p, site.id);
    table = h.length === 0 ? <p className="px-5 py-6 text-center text-sm text-muted">Разрез по часам ещё не загружен — он включается в плане «Разрезы ADOK» на Интеграциях и приходит ночью</p> : (
      <div className="flex flex-col gap-4">
        <div className="px-5"><TrendChart xKey="label" height={200} kind="money" data={h.map((r) => ({ label: r.label, revenue: Math.round(r.revenuePerDay * 100) / 100 }))} series={[{ key: "revenue", label: "Выручка в среднем за день", color: "var(--accent)", type: "bar" }]} /></div>
        <DataTable id="h" exportName={`${site.domain}-hours`} defaultSort={{ id: "hour", dir: "asc" }} columns={HOUR_COLS} rows={h.map((r) => ({ ...r, _key: String(r.hour) }))} />
      </div>
    );
  } else if (by === "sources") {
    const src = await sourcesTable(p, site.id);
    table = <DataTable id="s" exportName={`${site.domain}-sources`} defaultSort={{ id: "loads", dir: "desc" }} columns={SOURCE_COLS}
      rows={src.map((r) => ({ ...r, _key: r.source, _badges: r.revShare === 0 ? { source: [{ label: "бесплатно", tone: "neutral" as const }] } : undefined }))} />;
  } else {
    const d = await devicesTable(p, site.id);
    table = <DataTable id="d" exportName={`${site.domain}-devices`} defaultSort={{ id: "revenue", dir: "desc" }}
      columns={[{ id: "device", header: "Девайс", kind: "text" }, { id: "uniques", header: "Уники", kind: "int" }, { id: "imps", header: "Показы", kind: "int" },
        { id: "ctr", header: "CTR", kind: "percent", tooltip: "Клики / показы" }, { id: "cpm", header: "CPM", kind: "cpm" }, { id: "revenue", header: "Выручка", kind: "money" }, { id: "share", header: "Доля", kind: "share" }]}
      rows={d.map((r) => ({ ...r, device: DEVICE_LABEL[r.device] ?? r.device, _key: r.device }))} />;
  }
  const tabHref = (id: string) => { const q = new URLSearchParams(sp as Record<string, string>); q.set("by", id); return `?${q}`; };

  return (
    <>
      <PageHeader title={<span className="font-mono">{site.domain}</span>} crumbs={[{ href: "/sites", label: "Сайты" }]} period={p}
        badges={<>
          {site.bundles.map((b) => <Link key={b.bundleId} href={`/bundles/${b.bundle.slug}`}><Badge tone="accent">{b.bundle.title}</Badge></Link>)}
          <StatusBadge status={site.status} />
        </>}
        sub={<span className="flex flex-wrap gap-3">
          {site.launchedAt && <span>Запущен {fmtDate(site.launchedAt)}</span>}
          <a className="inline-flex items-center gap-1 hover:text-accent" href={`https://${site.domain}`} target="_blank" rel="noreferrer">Открыть сайт <ExternalLink className="size-3" /></a>
          {site.adsgSiteId && <span>AdSpyglass ID {site.adsgSiteId}</span>}
        </span>} />
      <KpiRow k={k} keys={["revenue", "cost", "margin", "romi", "uniques", "rpm", "depth"]} partial={coverage.warn} />
      <Section title="Выручка и расход" sub="Красная линия выше синей — дни, когда сайт работал в минус">
        <TrendChart data={daily.map((d) => ({ date: d.date, revenue: Number.isNaN(d.revenue) ? null : d.revenue, cost: Number.isNaN(d.revenue) ? null : d.cost }))}
          series={[{ key: "revenue", label: "Выручка", color: "#3B82F6", type: "area" }, { key: "cost", label: "Расход на трафик", color: "#F43F5E", type: "line" }]} />
      </Section>
      <Section title="Разрезы">
        <div className="-mx-5 -mt-2 mb-3 px-5"><BreakdownTabs tabs={TABS} active={by} hrefFor={tabHref} /></div>
        {table}
      </Section>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {(alerts.length > 0 || hiddenAlerts > 0) && (
          <Section title={`Алерты по сайту · ${alerts.length}`} sub={hiddenAlerts ? `${hiddenAlerts} скрыт${hiddenAlerts === 1 ? "" : "о"} («Принято к сведению») — на /alerts под «Показать скрытые»` : undefined}>
            {alerts.length === 0 ? <p className="py-4 text-center text-sm text-muted">Все алерты сайта приняты к сведению</p> : (
            <ul className="-mx-2 divide-y divide-border" data-testid="site-alerts">{alerts.map((a) => {
              const action = typeof (a.payload as Record<string, unknown> | null)?.action === "string" ? String((a.payload as Record<string, unknown>).action) : null;
              const estimate = Boolean((a.payload as Record<string, unknown> | null)?.estimate);
              return (
                <li key={a.id} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
                  <div className="min-w-0 flex-1">
                    <AlertBadge level={a.level} title={a.title} message={a.message} link={a.link}
                      meta={<>{action && <span className="text-fg">{action} </span>}с {fmtDate(a.firstSeenAt)}{Number(a.moneyAtRisk) > 0 && <> · под риском {fmtMoney(Number(a.moneyAtRisk))}{estimate && " (оценка)"}</>}</>} />
                  </div>
                  <div className="flex shrink-0 items-center gap-1 pl-12 pb-1 sm:pl-0 sm:pt-2.5 sm:pb-0"><ToHypothesisButton alertId={a.id} exists={inHypotheses.has(`${a.rule}|${a.entityKey}`)} /><SnoozeButton id={a.id} snoozed={false} /></div>
                </li>
              );
            })}</ul>)}
          </Section>
        )}
        {hyps.length > 0 && (
          <Section title={`Гипотезы сайта · ${hyps.length}`} sub="Что система предлагает попробовать на этом сайте" actions={<Link href={`/hypotheses?site=${encodeURIComponent(site.domain)}`} className="text-sm text-accent hover:underline">Все гипотезы сайта →</Link>}>
            <ul className="-mx-5 divide-y divide-border/60" data-testid="site-hypotheses">{hyps.map((h) => (
              <li key={h.id} className="flex flex-col gap-2 px-5 py-2.5 sm:flex-row sm:items-start">
                <div className="flex min-w-0 flex-1 gap-3">
                  <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", h.level === "CRITICAL" ? "bg-negative-soft text-negative" : h.level === "WARNING" ? "bg-warning-soft text-warning" : "bg-accent-soft text-accent")}><FlaskConical className="size-3.5" /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link href={h.link} className="text-sm font-medium hover:text-accent">{h.title}</Link>
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{SCOPE_LABEL[h.scope as HypScope] ?? h.scope}</span>
                      <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{SOURCE_LABEL[h.source]}</span>
                      {h.status === "ACCEPTED" && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{STATUS_LABEL[h.status]}</span>}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">{h.hypothesis}</p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pl-10 sm:flex-col sm:items-end sm:pl-0">
                  <span className="num text-sm">{Number(h.impactMonth ?? 0) > 0 ? <><span className="font-medium">{fmtMoney(Number(h.impactMonth))}</span><span className="ml-1 text-[11px] text-faint">{(h.evidence as Record<string, unknown> | null)?.debt ? "долг" : "в месяц"}</span></> : <span className="text-faint">—</span>}</span>
                  <HypothesisActions id={h.id} status={h.status} />
                </div>
              </li>
            ))}</ul>
          </Section>
        )}
        {deals.length > 0 && (
          <Section title="Фикс-дилы на сайте">
            <ul className="divide-y divide-border">
              {deals.map((d) => {
                const f = dealFacts.filter((x) => x.dealId === d.id);
                const rf = reportedFacts.find((x) => x.dealId === d.id);
                const own = rf?._sum.impsOwn ?? 0, rep = rf?._sum.impsReported ?? 0;
                const mult = rep ? dealMultiplier(rep, own) : null;
                return (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                    <span className="flex items-center gap-2">
                      <Link href={`/deals/${d.id}`} className="font-medium hover:text-accent">{d.advertiser.name} · {d.title}</Link>
                      {d.status === "ENDED" && <Badge tone="neutral">завершён{d.endsAt ? ` ${fmtDate(d.endsAt)}` : ""}</Badge>}
                      {d.status === "PAUSED" && <Badge tone="warning">пауза</Badge>}
                      {!d.sites.length && <Badge tone="negative" title="Сайт убран из дила, но начисления за период остались">не привязан</Badge>}
                    </span>
                    <span className="num flex items-center gap-3 text-muted">
                      <span>{FORMAT_LABEL[d.format]}</span><span>{d.geoScope.length ? d.geoScope.join(", ") : "все гео"}</span>
                      <span>{fmtInt(own)} / {rep ? fmtInt(rep) : "—"}</span>
                      <span className={mult && mult > 1.5 ? "font-medium text-warning" : ""} title={mult && mult > 1.5 ? `Рекламодатель засчитывает в ${mult.toFixed(1)} раза больше показов` : undefined}>{fmtMultiplier(mult)}</span>
                      {f.map((x) => <MoneyStatus key={x.revenueState} amount={Number(x._sum.revenue ?? 0)} state={x.revenueState} />)}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Section>
        )}
      </div>
    </>
  );
}
