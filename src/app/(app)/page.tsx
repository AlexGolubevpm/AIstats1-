import Link from "next/link";
import { Section } from "@/components/ui/card";
import { TrendChart } from "@/components/data/charts";
import { DataTable } from "@/components/data/data-table";
import { KpiRow } from "@/components/data/kpi-row";
import { AlertBadge, EmptyState } from "@/components/data/misc";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { colorFor, pivot } from "@/lib/charts";
import { fmtMoney } from "@/lib/format";
import { eachDay, periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { dailyTotals, kpis } from "@/server/queries/common";
import { bundlesTable, costSplitDaily, dataExists, opexDaily, overlappingSites, revenueSplitDaily, topMovers } from "@/server/queries/reports";

type SP = Promise<Record<string, string | string[] | undefined>>;

export default async function Overview({ searchParams }: { searchParams: SP }) {
  const p = periodFromParams(await searchParams, "7d");
  if (!(await dataExists())) {
    return (
      <>
        <PageHeader title="Сводка" sub="Маржа по сети" period={p} />
        <section className="card"><EmptyState kind="no-data" action={<Button asChild variant="primary"><Link href="/settings/integrations">Подключить источники</Link></Button>} /></section>
      </>
    );
  }
  const [k, bundles, overlap, movers, split, daily, alerts, networks, costSplit, opex] = await Promise.all([
    kpis(p), bundlesTable(p), overlappingSites(), topMovers(p), revenueSplitDaily(p, {}, "networks"), dailyTotals(p),
    db.alert.findMany({ where: { resolvedAt: null, OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: new Date() } }] }, orderBy: [{ level: "desc" }, { moneyAtRisk: "desc" }], take: 5 }),
    db.network.findMany(), costSplitDaily(p), opexDaily(p),
  ]);
  const { data, series } = pivot(split, eachDay(p));
  const known = Object.fromEntries(networks.map((n) => [n.title, n.color]));
  known["Фикс-дилы"] = "#22C55E";
  const costs = pivot(costSplit, eachDay(p));
  const costKnown: Record<string, string> = { "Опер. расходы": "#94A3B8" };
  // P&L by day: revenue and traffic cost from the facts, margin after operating expenses; empty days stay gaps.
  const pnl = daily.map((d) => {
    const gap = Number.isNaN(d.revenue), ox = opex.get(d.date) ?? 0;
    return { date: d.date, revenue: gap ? null : d.revenue, cost: gap ? null : d.cost, opex: gap ? null : ox, margin: gap ? null : d.revenue - d.cost - ox };
  });

  return (
    <>
      <PageHeader title="Сводка" sub="Маржа по всем сайтам и бандлам" period={p} />
      <KpiRow k={k} keys={["revenue", "cost", "margin", "romi", "uniques", "rpm"]} />
      <div className="grid gap-4 xl:grid-cols-3">
        <Section title="Выручка по сеткам" className="xl:col-span-2" sub="Столбцы — выручка по сеткам AdSpyglass и прямые фикс-дилы">
          <TrendChart data={data} series={series.map((s, i) => ({ key: s, label: s, color: colorFor(s, i, known), type: "bar" as const, stack: "rev" }))} />
        </Section>
        <Section title="Алерты" actions={<Link href="/alerts" className="text-sm text-accent hover:underline">Все →</Link>}>
          {alerts.length === 0 ? <p className="py-6 text-center text-sm text-muted">Активных алертов нет</p> : (
            <div className="-mx-2 flex flex-col">
              {alerts.map((a) => <AlertBadge key={a.id} level={a.level} title={a.title} message={a.message} link={a.link} />)}
            </div>
          )}
        </Section>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Расходы" sub="Столбцы — расход на трафик по источникам и операционные расходы по дням (KPI «Расход на трафик» выше — без опер. расходов)">
          <TrendChart data={costs.data} series={costs.series.map((s, i) => ({ key: s, label: s, color: colorFor(s, i, costKnown), type: "bar" as const, stack: "cost" }))} />
        </Section>
        <Section title="P&L" sub="Выручка и расход на трафик столбцами, маржа после опер. расходов линией (KPI «Маржа» выше — до них)">
          <TrendChart data={pnl} series={[
            { key: "revenue", label: "Выручка", color: "#3B82F6", type: "bar" as const },
            { key: "cost", label: "Расход на трафик", color: "#F43F5E", type: "bar" as const },
            { key: "opex", label: "Опер. расходы", color: "#94A3B8", type: "bar" as const },
            { key: "margin", label: "Маржа", color: "#16A34A", type: "line" as const },
          ]} />
        </Section>
      </div>
      <Section title="Бандлы" sub={overlap > 0 ? `Сумма по бандлам ≠ сети: ${overlap} ${overlap === 1 ? "сайт входит" : "сайта входят"} в несколько бандлов. Итог считается по сайтам.` : undefined}>
        <DataTable id="bundles" exportName="bundles" defaultSort={{ id: "revenue", dir: "desc" }}
          columns={[
            { id: "title", header: "Бандл", kind: "text" }, { id: "sites", header: "Сайтов", kind: "int" }, { id: "uniques", header: "Уники", kind: "int" },
            { id: "revenue", header: "Выручка", kind: "money" }, { id: "cost", header: "Расход", kind: "money" }, { id: "margin", header: "Маржа", kind: "money", heat: "sign" },
            { id: "romi", header: "ROMI", kind: "romi", heat: "vsMean" }, { id: "rpm", header: "RPM", kind: "money" },
          ]}
          rows={bundles.map((b) => ({ ...b, _key: b.id, _href: `/bundles/${b.slug}` }))}
          totals={{ title: "Итого по сети", uniques: k.cur.uniques, revenue: k.cur.revenue, cost: k.cur.cost, margin: k.cur.margin, romi: k.cur.romi, rpm: k.cur.rpm }} />
      </Section>
      <div className="grid gap-4 md:grid-cols-2">
        {([["Маржа выросла", movers.up, "text-positive"], ["Маржа упала", movers.down, "text-negative"]] as const).map(([title, list, cls]) => (
          <Section key={title} title={title} sub="к прошлому равному периоду">
            {list.length === 0 ? <p className="py-4 text-sm text-muted">Нет изменений</p> : (
              <ul className="divide-y divide-border">
                {list.map((x) => (
                  <li key={x.domain} className="flex h-9 items-center justify-between text-[13px]">
                    <Link href={`/sites/${x.domain}`} className="font-mono text-xs hover:text-accent">{x.domain}</Link>
                    <span className="num flex gap-4"><span className="text-muted">{fmtMoney(x.margin)}</span><span className={cls}>{x.change > 0 ? "+" : ""}{fmtMoney(x.change)}</span></span>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        ))}
      </div>
    </>
  );
}
