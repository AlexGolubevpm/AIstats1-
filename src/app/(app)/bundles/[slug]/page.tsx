import Link from "next/link";
import { notFound } from "next/navigation";
import { TrendChart } from "@/components/data/charts";
import { DataTable } from "@/components/data/data-table";
import { KpiRow } from "@/components/data/kpi-row";
import { EmptyState } from "@/components/data/misc";
import { PageHeader } from "@/components/layout/page-header";
import { FORMAT_COLS, FORMAT_LABEL, GEO_COLS, NETWORK_COLS, SITE_COLS, geoRows } from "@/components/pages/columns";
import { Button } from "@/components/ui/button";
import { Section } from "@/components/ui/card";
import { colorFor, pivot } from "@/lib/charts";
import { cn } from "@/lib/cn";
import { eachDay, periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { bundleSiteIds, dailyTotals, kpis } from "@/server/queries/common";
import { formatsTable, geoTable, networksTable, revenueSplitDaily, sitesTable, type SplitBy } from "@/server/queries/reports";

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | undefined>> };

export default async function BundlePage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const p = periodFromParams(sp, "7d");
  const bundle = await db.bundle.findUnique({ where: { slug } });
  if (!bundle) notFound();
  const siteIds = await bundleSiteIds(bundle.id);
  const header = <PageHeader title={bundle.title} crumbs={[{ href: "/bundles", label: "Бандлы" }]} period={p}
    badges={<span className="size-2.5 rounded-full" style={{ background: bundle.color }} />} sub={`${siteIds.length} сайтов`} />;
  if (!siteIds.length) {
    return <>{header}<section className="card"><EmptyState kind="no-data" action={<Button asChild variant="primary"><Link href="/settings/bundles">Добавить сайты в бандл</Link></Button>} /></section></>;
  }
  const scope = { siteIds };
  const split = (["formats", "sites", "networks"].includes(sp.split ?? "") ? sp.split : "formats") as SplitBy;
  const [k, sites, formats, geo, nets, splitRows, daily, networks] = await Promise.all([
    kpis(p, scope), sitesTable(p, scope), formatsTable(p, scope), geoTable(p, scope, 20), networksTable(p, scope), revenueSplitDaily(p, scope, split),
    dailyTotals(p, scope), db.network.findMany(),
  ]);
  const { data, series } = pivot(splitRows.map((r) => ({ ...r, key: split === "formats" ? FORMAT_LABEL[r.key] ?? r.key : r.key })), eachDay(p));
  const known = Object.fromEntries(networks.map((n) => [n.title, n.color]));
  const cost = new Map(daily.map((d) => [d.date, Number.isNaN(d.revenue) ? null : d.cost]));
  const chart = data.map((r) => ({ ...r, cost: cost.get(String(r.date)) ?? null }));
  const splitHref = (s: string) => { const q = new URLSearchParams(sp as Record<string, string>); q.set("split", s); return `?${q}`; };

  return (
    <>
      {header}
      <KpiRow k={k} keys={["revenue", "cost", "margin", "romi", "uniques", "rpm"]} />
      <Section title="Динамика" sub="Выручка по дням и расход: видно, пробивает ли выручка расход каждый день"
        actions={<div className="flex rounded-lg border border-border p-0.5 text-xs">
          {([["formats", "Форматы"], ["sites", "Сайты"], ["networks", "Сетки"]] as const).map(([id, label]) => (
            <Link key={id} href={splitHref(id)} scroll={false} className={cn("rounded-md px-2.5 py-1", split === id ? "bg-accent-soft text-accent" : "text-muted hover:text-text")}>{label}</Link>
          ))}
        </div>}>
        <TrendChart data={chart} series={[...series.map((s, i) => ({ key: s, label: s, color: colorFor(s, i, known), type: "bar" as const, stack: "rev" })),
          { key: "cost", label: "Расход", color: "#F43F5E", type: "line" as const }]} />
      </Section>
      <Section title="Сайты бандла" sub="Сортировка по марже: сразу видно, кто тащит бандл, а кто в минусе">
        <DataTable id="sites" exportName={`bundle-${slug}-sites`} defaultSort={{ id: "margin", dir: "desc" }} columns={SITE_COLS}
          rows={sites.map((s) => ({ ...s, _key: s.id, _href: `/sites/${s.domain}` }))}
          totals={{ domain: "Итого", uniques: k.cur.uniques, pageviews: k.cur.pageviews, depth: k.cur.depth, revenue: k.cur.revenue, cost: k.cur.cost, margin: k.cur.margin, romi: k.cur.romi, rpm: k.cur.rpm }} />
      </Section>
      <div className="grid gap-4 2xl:grid-cols-2">
        <Section title="Форматы" sub="CPM сравнивается только внутри формата; для баннеров — view rate и viewable CPM">
          <DataTable id="fmt" exportName={`bundle-${slug}-formats`} defaultSort={{ id: "revenue", dir: "desc" }} columns={FORMAT_COLS}
            rows={formats.map((f) => ({ ...f, format: FORMAT_LABEL[f.format] ?? f.format, _key: f.format }))} />
        </Section>
        <Section title="Сетки" sub="Строки с инверсией (4-я и ниже по цене при доле > 30%) подсвечены">
          <DataTable id="net" exportName={`bundle-${slug}-networks`} defaultSort={{ id: "revenue", dir: "desc" }} columns={NETWORK_COLS}
            rows={nets.map((n) => ({ ...n, _key: n.slug, _warn: n.inverted }))} />
        </Section>
      </div>
      <Section title="Гео" sub="Топ-20 стран по загрузкам. Рабочий экран для решения, какие гео продолжать закупать">
        <DataTable id="geo" exportName={`bundle-${slug}-geo`} defaultSort={{ id: "pageLoads", dir: "desc" }} columns={GEO_COLS} rows={geoRows(geo)}
          filters={[{ id: "loss", label: "Только убыточные", column: "margin", op: "lt", value: 0 }]} />
      </Section>
    </>
  );
}
