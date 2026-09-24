import Link from "next/link";
import { DataTable } from "@/components/data/data-table";
import { KpiCard } from "@/components/data/kpi-card";
import { PageHeader } from "@/components/layout/page-header";
import { GEO_COLS, geoRows } from "@/components/pages/columns";
import { Section } from "@/components/ui/card";
import { fmtPercent } from "@/lib/format";
import { periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { geoMatrix, geoTable } from "@/server/queries/reports";

export default async function Geo({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const p = periodFromParams(await searchParams, "7d");
  const [rows, matrix, unresolved] = await Promise.all([geoTable(p, {}, 0), geoMatrix(p), db.unresolvedAlias.aggregate({ _sum: { rows: true } })]);
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
        <KpiCard label="Стран с расходом" value={withCost.length} format="count" />
        <KpiCard label="Убыточных" value={losing.length} format="count" color="#E11D48" />
        <KpiCard label="Расход в убыточных гео" value={losing.reduce((a, r) => a + r.cost, 0)} format="money" color="#E11D48" />
        <KpiCard label="ROMI гео с расходом" value={cost ? ((rev - cost) / cost) * 100 : null} format="percent" color="#16A34A" />
      </div>
      <Section title="Страны">
        <DataTable id="geo" exportName="geo" defaultSort={{ id: "cost", dir: "desc" }}
          columns={[...GEO_COLS.slice(0, 2), { id: "sites", header: "Сайтов", kind: "int" }, GEO_COLS[2], { id: "costPerUnique", header: "Cost/unique", kind: "cpm" }, ...GEO_COLS.slice(4)]}
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
