import Link from "next/link";
import { TrendChart } from "@/components/data/charts";
import { DataTable } from "@/components/data/data-table";
import { KpiCard } from "@/components/data/kpi-card";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { fmtDate, fmtMoney } from "@/lib/format";
import { LOOKBACKS, parseLookback } from "@/lib/forecast";
import { monthForecast } from "@/server/queries/forecast";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const shiftMonth = (m: string, k: number) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + k, 1)).toISOString().slice(0, 7);

export default async function Forecast({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const n = parseLookback(sp.n);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.month ?? "") && sp.month! <= today.slice(0, 7) ? sp.month! : today.slice(0, 7);
  const f = await monthForecast(today, n, month);
  const { projection: pr, prev } = f;
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) q.set(k, v);
    return `/forecast${q.size ? `?${q}` : ""}`;
  };
  const isCurrent = month === today.slice(0, 7);
  const chart = pr.days.map((d) => ({
    date: d.date,
    revenue: d.kind === "actual" ? d.revenue : null, revenueForecast: d.kind === "actual" ? null : d.revenue,
    cost: d.kind === "actual" ? d.cost : null, costForecast: d.kind === "actual" ? null : d.cost,
    cumMargin: d.revenue == null ? null : d.cumMargin,
  }));
  const delta = (cur: number | null | undefined, base: number | undefined) => (cur == null || !base ? null : ((cur - base) / Math.abs(base)) * 100);
  const KIND: Record<string, string> = { actual: "факт", today: "сегодня", forecast: "прогноз" };

  return (
    <>
      <PageHeader title="Прогноз" sub={`${monthLabel(month)}: что уже есть и чем закончится месяц при текущей динамике`}
        actions={<div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">Динамика по последним</span>
          {LOOKBACKS.map((k) => <Link key={k} href={href({ n: String(k) })} className={`rounded-md border px-3 py-1.5 ${k === n ? "border-accent bg-accent-soft text-accent" : "border-border hover:bg-surface-hover"}`}>{k} дн.</Link>)}
          <span className="mx-2 text-faint">|</span>
          <Link href={href({ month: shiftMonth(month, -1) })} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface-hover">← {monthLabel(shiftMonth(month, -1))}</Link>
          {!isCurrent && <Link href={href({ month: undefined })} className="rounded-md border border-border px-3 py-1.5 hover:bg-surface-hover">Текущий месяц</Link>}
        </div>} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 min-[1800px]:grid-cols-6">
        <KpiCard label={isCurrent ? "Прогноз выручки" : "Выручка за месяц"} value={pr.projected?.revenue ?? null} format="money" color="#3B82F6"
          sub={isCurrent ? `факт ${fmtMoney(pr.actual.revenue)} за ${pr.actual.days} дн. + ${fmtMoney(pr.rate.revenue)}/день × ${pr.daysLeft}` : undefined}
          delta={delta(pr.projected?.revenue, prev?.revenue)} />
        <KpiCard label="Расход на трафик" value={pr.projected?.cost ?? null} format="money" color="#F43F5E" tone="inverse" delta={delta(pr.projected?.cost, prev?.cost)}
          sub={isCurrent ? `${fmtMoney(pr.rate.cost)}/день` : undefined} />
        <KpiCard label="Опер. расходы" value={pr.projected?.opex ?? null} format="money" color="#94A3B8" sub="известны на весь месяц" />
        <KpiCard label="Маржа" value={pr.projected?.margin ?? null} format="money" color="#16A34A" negativeFrame={(pr.projected?.margin ?? 0) < 0} delta={delta(pr.projected?.margin, prev?.margin)}
          sub="после опер. расходов" />
        <KpiCard label="ROMI" value={pr.projected?.romi ?? null} format="percent" color="#16A34A" sub="на расход на трафик" />
        <KpiCard label={prev ? `${monthLabel(prev.month)}` : "Прошлый месяц"} value={prev?.revenue ?? null} format="money" color="#A78BFA"
          sub={prev ? `маржа ${fmtMoney(prev.margin)}` : "нет данных"} />
      </div>
      {pr.rate.daysUsed < n && isCurrent && (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">Полных дней с данными только {pr.rate.daysUsed} — темп посчитан по ним. Прогноз станет точнее через {n - pr.rate.daysUsed} дн.</p>
      )}
      <Section title="По дням месяца" sub={`Сплошные столбцы — факт, светлые — прогноз по темпу последних ${pr.rate.daysUsed || n} дн. Линия — накопленная маржа после опер. расходов${f.knownDeals ? ` · фикс-дилов впереди известно на ${fmtMoney(f.knownDeals)}` : ""}`}>
        <TrendChart data={chart} height={320} series={[
          { key: "revenue", label: "Выручка", color: "#3B82F6", type: "bar", stack: "rev" },
          { key: "revenueForecast", label: "Выручка · прогноз", color: "#BFDBFE", type: "bar", stack: "rev" },
          { key: "cost", label: "Расход на трафик", color: "#F43F5E", type: "line" },
          { key: "costForecast", label: "Расход на трафик · прогноз", color: "#F43F5E", type: "line", dashed: true },
          { key: "cumMargin", label: "Маржа накопленно", color: "#16A34A", type: "line" },
        ]} />
        <div className="-mx-5 mt-4 overflow-x-auto">
          <table className="num w-full text-[12px]">
            <thead><tr className="border-b border-border text-xs text-muted">
              <th className="h-8 pl-5 text-left font-medium">День</th><th className="h-8 text-left font-medium">Статус</th>
              <th className="h-8 text-right font-medium">Выручка</th><th className="h-8 text-right font-medium">Расход</th><th className="h-8 text-right font-medium">Опер.</th>
              <th className="h-8 text-right font-medium">Маржа</th><th className="h-8 pr-5 text-right font-medium">Накоплено</th></tr></thead>
            <tbody>{pr.days.map((d) => (
              <tr key={d.date} className={`h-8 border-b border-border/60 ${d.kind === "actual" ? "" : "text-muted"}`} data-kind={d.kind}>
                <td className="pl-5">{fmtDate(d.date)}</td>
                <td><span className={`rounded px-1.5 py-0.5 text-[11px] ${d.kind === "actual" ? "bg-positive-soft text-positive" : d.kind === "today" ? "bg-accent-soft text-accent" : "border border-dashed border-border-strong"}`}>{KIND[d.kind]}</span></td>
                <td className="text-right">{d.revenue == null ? "—" : fmtMoney(d.revenue)}</td>
                <td className="text-right">{d.cost == null ? "—" : fmtMoney(d.cost)}</td>
                <td className="text-right">{d.opex ? fmtMoney(d.opex) : "—"}</td>
                <td className={`text-right ${d.margin != null && d.margin < 0 ? "text-negative" : ""}`}>{d.margin == null ? "—" : fmtMoney(d.margin)}</td>
                <td className="pr-5 text-right">{d.revenue == null ? "—" : fmtMoney(d.cumMargin)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Section>
      <Section title="По сайтам" sub="Факт с начала месяца, темп в день, прогноз на месяц и сравнение с прошлым месяцем">
        <DataTable id="fc" exportName={`forecast-${month}`} defaultSort={{ id: "projected", dir: "desc" }}
          columns={[
            { id: "domain", header: "Сайт", kind: "site" }, { id: "actual", header: "Факт", kind: "money" }, { id: "rate", header: "Темп / день", kind: "money" },
            { id: "projected", header: isCurrent ? "Прогноз месяца" : "Месяц", kind: "money" }, { id: "margin", header: "Маржа (прогноз)", kind: "money", heat: "sign" },
            { id: "prevMonth", header: "Прошлый месяц", kind: "money" }, { id: "delta", header: "К прошлому", kind: "delta" },
          ]}
          rows={f.sites.map((s) => ({ ...s, delta: s.delta == null ? null : s.delta * 100, _key: s.id, _href: `/sites/${s.domain}` }))}
          empty="Нет данных за месяц" />
        <p className="mt-3 text-xs text-faint">Прогноз сайта — его собственный темп за те же {n} дн.; маржа сайта без опер. расходов.</p>
      </Section>
    </>
  );
}
