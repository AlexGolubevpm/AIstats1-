import { ExternalLink } from "lucide-react";
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
import { fmtDate, fmtInt, fmtMultiplier } from "@/lib/format";
import { dealMultiplier } from "@/lib/metrics";
import { periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { D, dailyTotals, kpis } from "@/server/queries/common";
import { devicesTable, formatsTable, networksTable, siteGeoWithNetworks, zonesTable } from "@/server/queries/reports";

type Props = { params: Promise<{ domain: string }>; searchParams: Promise<Record<string, string | undefined>> };
const TABS = [{ id: "zones", label: "Зоны" }, { id: "formats", label: "Форматы" }, { id: "networks", label: "Сетки" }, { id: "geo", label: "Гео" }, { id: "devices", label: "Девайсы" }];

const ZONE_COLS: Column[] = [
  { id: "zone", header: "Зона", kind: "text" }, { id: "format", header: "Формат", kind: "text" }, { id: "position", header: "Позиция", kind: "text" },
  { id: "imps", header: "Показы", kind: "int" }, { id: "views", header: "Видимые", kind: "int" }, { id: "viewRate", header: "View rate", kind: "percent" },
  { id: "cpm", header: "CPM", kind: "cpm" }, { id: "viewableCpm", header: "Viewable CPM", kind: "cpm" }, { id: "revenue", header: "Выручка", kind: "money" },
  { id: "share", header: "Доля", kind: "share" },
];
const NESTED_NET: Column[] = [
  { id: "network", header: "Сетка в этой стране", kind: "text" }, { id: "pageLoads", header: "Page loads", kind: "int" }, { id: "volShare", header: "Доля объёма", kind: "share" },
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
  const [k, daily, alerts, deals] = await Promise.all([
    kpis(p, scope), dailyTotals(p, scope),
    db.alert.findMany({ where: { siteId: site.id, resolvedAt: null }, orderBy: [{ level: "desc" }, { moneyAtRisk: "desc" }] }),
    db.deal.findMany({ where: { sites: { some: { siteId: site.id } }, status: { in: ["ACTIVE", "PAUSED"] } }, include: { advertiser: true } }),
  ]);
  const dealFacts = await db.factFixDeal.groupBy({ by: ["dealId", "revenueState"], where: { siteId: site.id, date: { gte: D(p.from), lte: D(p.to) } },
    _sum: { revenue: true, impsOwn: true, impsReported: true } });

  let table: React.ReactNode;
  if (by === "zones") {
    const z = await zonesTable(p, site.id);
    table = <DataTable id="z" exportName={`${site.domain}-zones`} defaultSort={{ id: "revenue", dir: "desc" }} columns={ZONE_COLS}
      rows={z.map((r) => ({ ...r, format: FORMAT_LABEL[r.format] ?? r.format, _key: r.id,
        _badges: { zone: [...(r.candidateRemove ? [{ label: "кандидат на снос", tone: "warning" as const }] : []), ...(r.invisible ? [{ label: "не видна", tone: "negative" as const }] : [])] } }))} />;
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
  } else {
    const d = await devicesTable(p, site.id);
    table = <DataTable id="d" exportName={`${site.domain}-devices`} defaultSort={{ id: "revenue", dir: "desc" }}
      columns={[{ id: "device", header: "Девайс", kind: "text" }, { id: "uniques", header: "Уники", kind: "int" }, { id: "imps", header: "Показы", kind: "int" },
        { id: "cpm", header: "CPM", kind: "cpm" }, { id: "revenue", header: "Выручка", kind: "money" }, { id: "share", header: "Доля", kind: "share" }]}
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
      <KpiRow k={k} keys={["revenue", "cost", "margin", "romi", "uniques", "rpm", "depth"]} />
      <Section title="Выручка и расход" sub="Красная линия выше синей — дни, когда сайт работал в минус">
        <TrendChart data={daily.map((d) => ({ date: d.date, revenue: Number.isNaN(d.revenue) ? null : d.revenue, cost: Number.isNaN(d.revenue) ? null : d.cost }))}
          series={[{ key: "revenue", label: "Выручка", color: "#3B82F6", type: "area" }, { key: "cost", label: "Расход", color: "#F43F5E", type: "line" }]} />
      </Section>
      <Section title="Разрезы">
        <div className="-mx-5 -mt-2 mb-3 px-5"><BreakdownTabs tabs={TABS} active={by} hrefFor={tabHref} /></div>
        {table}
      </Section>
      <div className="grid gap-4 lg:grid-cols-2">
        {alerts.length > 0 && (
          <Section title="Алерты по сайту">
            <div className="-mx-2">{alerts.map((a) => <AlertBadge key={a.id} level={a.level} title={a.title} message={a.message} link={a.link} />)}</div>
          </Section>
        )}
        {deals.length > 0 && (
          <Section title="Фикс-дилы на сайте">
            <ul className="divide-y divide-border">
              {deals.map((d) => {
                const f = dealFacts.filter((x) => x.dealId === d.id);
                const own = f.reduce((a, x) => a + (x._sum.impsOwn ?? 0), 0), rep = f.reduce((a, x) => a + (x._sum.impsReported ?? 0), 0);
                const mult = rep ? dealMultiplier(rep, own) : null;
                return (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
                    <Link href={`/deals/${d.id}`} className="font-medium hover:text-accent">{d.advertiser.name} · {d.title}</Link>
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
