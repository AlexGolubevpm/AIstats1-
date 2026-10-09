import Link from "next/link";
import { DataTable } from "@/components/data/data-table";
import { KpiCard } from "@/components/data/kpi-card";
import { PageHeader } from "@/components/layout/page-header";
import { GEO_COLS, geoRows } from "@/components/pages/columns";
import { Section } from "@/components/ui/card";
import { fmtPercent } from "@/lib/format";
import { periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { geoByTier, geoMatrix, geoTable } from "@/server/queries/reports";
import { TierChips } from "@/components/pages/tier-chips";
import type { Column } from "@/components/data/format-cell";

const TIER_COLS: Column[] = [
  { id: "label", header: "Тир", kind: "text" }, { id: "countries", header: "Стран", kind: "int" }, { id: "uniques", header: "Уники", kind: "int" }, { id: "pageLoads", header: "Page loads", kind: "int" },
  { id: "revenue", header: "Выручка", kind: "money" }, { id: "share", header: "Доля", kind: "share" }, { id: "cost", header: "Расход", kind: "money" },
  { id: "margin", header: "Маржа", kind: "money", heat: "sign" }, { id: "romi", header: "ROMI", kind: "romi" }, { id: "revPer1k", header: "Rev/1000 loads", kind: "cpm" },
];

export default async function Geo({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const p = periodFromParams(sp, "7d");
  const tier = /^[1-5]$/.test(sp.tier ?? "") ? Number(sp.tier) : null;
  const [rows, matrix, unresolved, tiers] = await Promise.all([geoTable(p, {}, 0, tier), geoMatrix(p), db.unresolvedAlias.aggregate({ _sum: { rows: true } }), geoByTier(p)]);
  const withCost = rows.filter((r) => r.cost > 0);
  const losing = withCost.filter((r) => r.margin < 0);
  const cost = withCost.reduce((a, r) => a + r.cost, 0), rev = withCost.reduce((a, r) => a + r.revenue, 0);
  const heat = (v: number | null) => (v == null ? "transparent" : v < 0 ? `color-mix(in srgb, var(--negative) ${Math.min(40, 10 + Math.abs(v) / 3)}%, transparent)` : `color-mix(in srgb, var(--positive) ${Math.min(35, 6 + v / 8)}%, transparent)`);
  return (
    <>
      <PageHeader title="Гео" sub="Маржа по странам по всей сети. Стоп-лист — фильтр «только убыточные»" period={p} />
      {(unresolved._sum.rows ?? 0) > 0 && (
        <Link href="/settings/integrations#geo" className="card flex items-center gap-2 border-warning/40 bg-warning-soft px-4 py-2.5 text-sm text-warning">
          ⚠ {unresolved._sum.rows} строк без распознанной страны (XX) — сопоставить
        </Link>
      )}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Стран с расходом" value={withCost.length} format="count" sub="расход источников разложен по загрузкам" />
        <KpiCard label="Убыточных" value={losing.length} format="count" color="#E11D48" sub="оценка" />
        <KpiCard label="Расход в убыточных гео" value={losing.reduce((a, r) => a + r.cost, 0)} format="money" color="#E11D48" sub="оценка" />
        <KpiCard label="ROMI гео с расходом" value={cost ? ((rev - cost) / cost) * 100 : null} format="percent" color="#16A34A" sub="оценка" />
      </div>
      <Section title="По тирам" sub="Куда уходят деньги и расход по тирам стран (Настройки → Гео и тиры); «Без страны» не учитывается">
        {tiers.length === 0 ? <p className="text-sm text-muted">Нет данных по странам за период</p> :
          <DataTable id="tiers" exportName="geo-tiers" defaultSort={{ id: "tier", dir: "asc" }} columns={TIER_COLS} rows={tiers.map((r) => ({ ...r, _key: String(r.tier), _href: `/geo?tier=${r.tier}` }))} />}
      </Section>
      <Section title={tier ? `Страны · T${tier}` : "Страны"} actions={<TierChips active={tier} params={sp} />}>
        <DataTable id="geo" exportName="geo" defaultSort={{ id: "cost", dir: "desc" }}
          columns={[...GEO_COLS.slice(0, 2), { id: "sites", header: "Сайтов", kind: "int" }, ...GEO_COLS.slice(2, 4), { id: "costPerUnique", header: "Cost/unique", kind: "cpm" }, ...GEO_COLS.slice(4)]}
          rows={geoRows(rows)}
          filters={[{ id: "loss", label: "Только убыточные", column: "margin", op: "lt", value: 0 }, { id: "paid", label: "Только с расходом", column: "cost", op: "gt", value: 0 }]} />
      </Section>
      <Section title="ROMI: сайт × страна" sub={`Топ-${matrix.countries.length} стран по расходу. Красное — убыток`}>
        <div className="-mx-5 overflow-x-auto">
          <table className="num w-full text-[12px]">
            <thead><tr className="border-b border-border"><th className="px-5 py-2 text-left text-xs font-medium text-muted">Сайт</th>
              {matrix.countries.map((c) => <th key={c} className="px-2 py-2 text-right font-mono text-[11px] font-medium text-muted">{c}</th>)}</tr></thead>
            <tbody>{matrix.sites.map((s) => (
              <tr key={s} className="border-b border-border/60">
                <td className="px-5 py-1.5"><Link href={`/sites/${s}?by=geo`} className="font-mono text-xs hover:text-accent">{s}</Link></td>
                {matrix.countries.map((c) => {
                  const v = matrix.cells[`${s}|${c}`] ?? null;
                  return <td key={c} className="px-2 py-1.5 text-right" style={{ background: heat(v) }}>{v == null ? <span className="text-faint">—</span> : fmtPercent(v, true)}</td>;
                })}
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
