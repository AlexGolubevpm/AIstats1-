import Link from "next/link";
import { TrendChart } from "@/components/data/charts";
import { DataTable } from "@/components/data/data-table";
import type { Row } from "@/components/data/format-cell";
import { KpiCard } from "@/components/data/kpi-card";
import { StatusBadge } from "@/components/data/misc";
import { PageHeader } from "@/components/layout/page-header";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/card";
import { TableScroll } from "@/components/data/table-scroll";
import { withBase } from "@/lib/base-path";
import { fmtDate, fmtMoney, fmtPercent } from "@/lib/format";
import { daysBetween, periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { asgPayouts, financeKpis, monthlyPnl, opexEntries, pnlTable, receivables, revenueStructure } from "@/server/queries/finance";
import { monthForecast } from "@/server/queries/forecast";
import { costCoverage } from "@/server/queries/common";
import { OPEX_LABEL, type OpexCategory } from "@/server/services/opex";
import { DeleteOpex, OpexButton } from "./opex";
import { PayoutButton } from "./payout";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;

export default async function Finance({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const p = periodFromParams(sp, "mtd");
  const monthly = daysBetween(p.from, p.to) > 62;
  const [k, structure, pnl, payouts, recv, months, opex, sites, coverage] = await Promise.all([financeKpis(p), revenueStructure(p, monthly), pnlTable(p), asgPayouts(), receivables(),
    monthlyPnl(), opexEntries(), db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" }, select: { id: true, domain: true } }), costCoverage(p)]);
  const today = new Date().toISOString().slice(0, 10);
  const thisMonth = today.slice(0, 7);
  // Month-end projection beside the month-to-date figures: only while the period is this month from its 1st day (ADR 0008 pace).
  const monthEnd = p.from === `${thisMonth}-01` && p.to <= today ? (await monthForecast(today)).projection.projected : null;
  const eom = (v: number | null | undefined) => (v == null ? null : `на конец месяца ${fmtMoney(v).replace(/\.\d\d$/, "")}`);
  const seg = (v: number) => (k.revenue > 0 ? `${(v / k.revenue) * 100}%` : "0%");
  const bundle = sp.bundle;
  const rows: Row[] = pnl.filter((r) => !bundle || r.bundles.includes(bundle)).map((r) => ({
    ...r, _key: r.siteId, _href: `/sites/${r.domain}`,
    _dashed: { asg: r.asgConfirmed < r.asg * 0.999, deals: r.deals > 0 && r.dealsConfirmed + r.dealsInvoiced < r.deals },
    completeness: [r.costGapDays ? `расход: ${r.costGapDays} дн. пусто` : "", r.noTraffic ? "нет Метрики" : "", r.dealNoNumbers ? "дил без цифр" : ""].filter(Boolean).join(" · ") || "",
    incomplete: Boolean(r.costGapDays || r.noTraffic || r.dealNoNumbers),
    _warn: Boolean(r.costGapDays || r.noTraffic),
    _badges: r.costGapDays ? { romi: [{ label: "неполный", tone: "warning" as const }] } : undefined,
    _children: r.months.map((x) => ({ ...x, month: monthLabel(x.month) })),
  }));
  const shown = pnl.filter((r) => !bundle || r.bundles.includes(bundle));
  // Totals follow the bundle filter; without a filter, opex of sites that had no data in the period (not in any row) is added so the total equals the KPI.
  const tot = shown.reduce((a, r) => ({ asg: a.asg + r.asg, deals: a.deals + r.deals, revenue: a.revenue + r.revenue, cost: a.cost + r.cost, opex: a.opex + r.opex }),
    { asg: 0, deals: 0, revenue: 0, cost: 0, opex: bundle ? 0 : Math.max(0, k.opex - pnl.reduce((a, r) => a + r.opex, 0)) });
  const opexByMonth = new Map<string, typeof opex>();
  for (const e of opex) opexByMonth.set(e.month, [...(opexByMonth.get(e.month) ?? []), e]);
  const bundles = [...new Set(pnl.flatMap((r) => r.bundles))].sort();

  return (
    <>
      <PageHeader title="Финансы по тьюбам" sub="Сколько каждый сайт заработал, сколько ещё придёт и где мы в минусе" period={p}
        extraPresets={[{ id: "quarter", label: "Квартал" }]}
        actions={<a href={withBase(`/api/export/month?month=${p.from.slice(0, 7)}`)} className="inline-flex h-8 items-center rounded-md border border-border bg-surface px-3 text-[13px] hover:bg-surface-hover">Отчёт за месяц (CSV)</a>} />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4 min-[1800px]:grid-cols-8">
        <div className="card flex flex-col gap-2 p-4 lg:col-span-1">
          <span className="text-xs font-medium text-muted">Выручка всего</span>
          <span className="num text-[26px] leading-8 font-semibold">{fmtMoney(k.revenue).replace(/\.\d\d$/, "")}</span>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-surface-hover" title="подтверждено · выставлено · прогноз">
            <span className="bg-positive" style={{ width: seg(k.confirmed) }} /><span className="bg-accent" style={{ width: seg(k.invoiced) }} />
            <span className="bg-border-strong" style={{ width: seg(k.forecast) }} />
          </div>
          <span className="text-[11px] text-faint">{monthEnd ? eom(monthEnd.revenue) : "подтв. · выставл. · прогноз"}</span>
        </div>
        <KpiCard label="Подтверждено" value={k.confirmed} format="money" color="#16A34A" />
        <KpiCard label="Ожидается" value={k.expected} format="money" sub="прогноз + выставлено" />
        <KpiCard label="Расход на трафик" value={k.cost} format="money" color="#F43F5E" sub={eom(monthEnd?.cost) ?? undefined} warn={coverage.warn} />
        <KpiCard label="Опер. расходы" value={k.opex} format="money" color="#F97316" sub={monthEnd ? eom(monthEnd.opex) ?? undefined : "хостинг, люди, софт"} />
        <KpiCard label="Маржа" value={k.margin} format="money" negativeFrame={k.margin < 0} sub={monthEnd ? `${eom(monthEnd.margin)} · после опер. расходов` : "после опер. расходов"} />
        <KpiCard label="ROMI" value={k.romi} format="percent" sub={monthEnd?.romi != null ? `на конец месяца ${fmtPercent(monthEnd.romi, true)}` : "на расход на трафик"} />
        <KpiCard label="Дебиторка просрочена" value={k.overdue} format="money" color="#E11D48"
          sub={k.overduePeriods ? `${k.overduePeriods} счетов` : "нет просрочки"} warn={k.overdue > 0 ? "Выставлено и не оплачено дольше срока" : undefined} />
      </div>

      <Section title="Структура выручки" sub={monthly ? "По месяцам · линия — расход" : "По дням · линия — расход"}>
        <TrendChart data={structure} series={[
          { key: "asg", label: "AdSpyglass", color: "#4F8DF7", type: "bar", stack: "r" },
          { key: "dealsConfirmed", label: "Фикс-дилы подтв.", color: "#16A34A", type: "bar", stack: "r" },
          { key: "dealsExpected", label: "Фикс-дилы ожид.", color: "#86EFAC", type: "bar", stack: "r" },
          { key: "cost", label: "Расход на трафик", color: "#F43F5E", type: "line" },
        ]} />
      </Section>

      <Section title="По месяцам" sub="Календарные месяцы: фикс-дилы и операционные расходы ложатся на дни своего месяца. Текущий месяц — не закрыт">
        <TableScroll><table className="tbl num w-full text-[13px] [&_td]:px-2 [&_td:first-child]:pl-0 [&_th]:px-2 [&_th:first-child]:pl-0">
          <thead><tr className="border-b border-border text-xs text-muted">
            <th className="py-2 text-left font-medium">Месяц</th><th className="text-right font-medium">AdSpyglass</th><th className="text-right font-medium">Фикс-дилы</th>
            <th className="text-right font-medium">Выручка</th><th className="text-right font-medium">Расход на трафик</th><th className="text-right font-medium">Опер. расходы</th>
            <th className="text-right font-medium">Маржа</th><th className="text-right font-medium">ROMI</th></tr></thead>
          <tbody>{months.map((x) => (
            <tr key={x.month} className={`h-10 border-b border-border/60 ${x.isCurrent ? "text-muted" : ""}`} data-month={x.month}>
              <td className="capitalize">{monthLabel(x.month)}{x.isCurrent && <span className="ml-2 text-[11px] text-faint">идёт</span>}</td>
              <td className="text-right">{fmtMoney(x.asg)}</td><td className="text-right">{fmtMoney(x.deals)}</td><td className="text-right font-medium">{fmtMoney(x.revenue)}</td>
              <td className="text-right">{fmtMoney(x.cost)}</td><td className="text-right">{fmtMoney(x.opex)}</td>
              <td className={`text-right font-medium ${x.margin < 0 ? "text-negative" : ""}`}>{fmtMoney(x.margin)}</td>
              <td className="text-right">{x.romi == null ? <span className="text-faint">—</span> : fmtPercent(x.romi / 100)}</td>
            </tr>
          ))}
          {months.length === 0 && <tr><td colSpan={8} className="py-6 text-center text-sm text-muted">Данных ещё нет</td></tr>}</tbody>
        </table></TableScroll>
      </Section>

      <Section title="Операционные расходы" sub="Хостинг, люди, софт — цифра за месяц, делится поровну на его дни. Без сайта — расход всей сети"
        actions={<OpexButton sites={sites} defaultMonth={thisMonth} />}>
        {opex.length === 0 ? <p className="py-6 text-center text-sm text-muted">Расходов пока нет — добавьте первый: месяц, что и сколько</p> : (
          <TableScroll><table className="tbl num w-full text-[13px] [&_td]:px-2 [&_td:first-child]:pl-0 [&_th]:px-2 [&_th:first-child]:pl-0">
            <thead><tr className="border-b border-border text-xs text-muted">
              <th className="py-2 text-left font-medium">Месяц</th><th className="text-left font-medium">Что</th><th className="text-left font-medium">Категория</th>
              <th className="text-left font-medium">Сайт</th><th className="text-right font-medium">За месяц</th><th className="text-right font-medium">В день</th><th /></tr></thead>
            <tbody>{[...opexByMonth.entries()].map(([mo, list]) => [
              <tr key={`${mo}-h`} className="h-8 bg-surface-2 text-xs font-medium text-muted"><td className="capitalize">{monthLabel(mo)}</td><td colSpan={3} />
                <td className="text-right">{fmtMoney(list.reduce((a, e) => a + e.amount, 0))}</td><td colSpan={2} /></tr>,
              ...list.map((e) => (
                <tr key={e.id} className="h-10 border-b border-border/60">
                  <td />
                  <td>{e.title}{e.note && <span className="ml-2 text-xs text-faint">{e.note}</span>}</td>
                  <td className="text-muted">{OPEX_LABEL[e.category as OpexCategory] ?? e.category}</td>
                  <td className="font-mono text-xs">{e.domain ?? <span className="text-muted">вся сеть</span>}</td>
                  <td className="text-right">{fmtMoney(e.amount)}</td>
                  <td className="text-right text-muted">{fmtMoney(e.amount / new Date(Date.UTC(+e.month.slice(0, 4), +e.month.slice(5, 7), 0)).getUTCDate())}</td>
                  <td className="text-right whitespace-nowrap"><OpexButton sites={sites} defaultMonth={thisMonth} label="Изменить" values={e} /> <DeleteOpex id={e.id} /></td>
                </tr>
              )),
            ])}</tbody>
          </table></TableScroll>
        )}
      </Section>

      <Section title="P&L по тьюбам" sub="Итог считается по сайтам. Маржа — после операционных расходов (общие расходы сети разложены по выручке). Пунктир — прогноз, не подтверждено деньгами"
        actions={<div className="flex flex-wrap gap-1 text-xs">
          <Link href={{ query: { ...sp, bundle: undefined } }} className={`rounded-full border px-2.5 py-1 ${!bundle ? "border-accent bg-accent-soft text-accent" : "border-border text-muted"}`}>Все</Link>
          {bundles.map((b) => <Link key={b} href={{ query: { ...sp, bundle: b } }} className={`rounded-full border px-2.5 py-1 ${bundle === b ? "border-accent bg-accent-soft text-accent" : "border-border text-muted"}`}>{b}</Link>)}
        </div>}>
        <DataTable id="pnl" exportName="pnl" defaultSort={{ id: "margin", dir: "desc" }}
          columns={[
            { id: "domain", header: "Сайт", kind: "site" }, { id: "asg", header: "AdSpyglass", kind: "money" }, { id: "deals", header: "Фикс-дилы", kind: "money" },
            { id: "revenue", header: "Выручка", kind: "money" }, { id: "cost", header: "Расход на трафик", kind: "money" }, { id: "opex", header: "Опер. расходы", kind: "money" },
            { id: "margin", header: "Маржа", kind: "money", heat: "sign" },
            { id: "romi", header: "ROMI", kind: "romi", heat: "vsMean" }, { id: "marginShare", header: "Доля маржи", kind: "share" }, { id: "completeness", header: "Полнота", kind: "text" },
          ]}
          nestedColumns={[{ id: "month", header: "Месяц", kind: "text" }, { id: "asg", header: "AdSpyglass", kind: "money" }, { id: "deals", header: "Фикс-дилы", kind: "money" },
            { id: "cost", header: "Расход на трафик", kind: "money" }, { id: "margin", header: "Маржа до опер.", kind: "money", heat: "sign" }, { id: "romi", header: "ROMI", kind: "romi" }]}
          filters={[{ id: "loss", label: "Только убыточные", column: "margin", op: "lt", value: 0 }, { id: "inc", label: "С неполными данными", column: "incomplete", op: "truthy" }]}
          rows={rows}
          totals={{ domain: bundle ? `Итого по бандлу ${bundle}` : "Итого по сети", ...tot, margin: tot.revenue - tot.cost - tot.opex, romi: tot.cost ? ((tot.revenue - tot.cost) / tot.cost) * 100 : null }} />
      </Section>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Section title="Выплаты AdSpyglass" sub="Полученная сумма подтверждает выручку месяца">
          {payouts.length === 0 ? <p className="py-6 text-center text-sm text-muted">Нет выручки AdSpyglass</p> : (
            <TableScroll><table className="tbl num w-full text-[13px] [&_td]:px-2 [&_td:first-child]:pl-0 [&_th]:px-2 [&_th:first-child]:pl-0">
              <thead><tr className="border-b border-border text-xs text-muted">
                <th className="py-2 text-left font-medium">Месяц</th><th className="text-right font-medium">Отчёт</th><th className="text-right font-medium">Получено</th>
                <th className="text-right font-medium">Расхождение</th><th className="text-right font-medium">Статус</th><th /></tr></thead>
              <tbody>{payouts.map((x) => (
                <tr key={x.month} className="h-10 border-b border-border/60">
                  <td className="capitalize">{monthLabel(x.month)}</td>
                  <td className="text-right">{fmtMoney(x.reported)}</td>
                  <td className="text-right">{x.received == null ? <span className="text-faint">—</span> : fmtMoney(x.received)}</td>
                  <td className={`text-right ${x.diff != null && Math.abs(x.diff) > 0.02 ? "text-warning" : ""}`}>{x.diff == null ? <span className="text-faint">—</span> : fmtPercent(x.diff)}</td>
                  <td className="text-right">{x.status === "CONFIRMED" ? <Badge tone="positive">подтверждено</Badge> : x.status === "OPEN" ? <Badge>месяц идёт</Badge> : <Badge tone="warning">ждём выплату</Badge>}</td>
                  <td className="text-right">{x.status !== "OPEN" && <PayoutButton month={x.month} reported={x.reported} label={x.received == null ? "Внести выплату" : "Изменить"} />}</td>
                </tr>
              ))}</tbody>
            </table></TableScroll>
          )}
        </Section>
        <Section title="Дебиторка по фикс-дилам" actions={<Link href="/deals?tab=payments" className="text-sm text-accent hover:underline">Все оплаты →</Link>}>
          {recv.length === 0 ? <p className="py-6 text-center text-sm text-muted">Неоплаченных счетов нет</p> : (
            <TableScroll><table className="tbl num w-full text-[13px] [&_td]:px-2 [&_td:first-child]:pl-0 [&_th]:px-2 [&_th:first-child]:pl-0">
              <thead><tr className="border-b border-border text-xs text-muted">
                <th className="py-2 text-left font-medium">Рекламодатель · дил</th><th className="text-left font-medium">Период</th><th className="text-right font-medium">Остаток</th>
                <th className="text-right font-medium">Срок</th><th className="text-right font-medium">Просрочка</th></tr></thead>
              <tbody>{recv.slice(0, 8).map((r) => (
                <tr key={r.id} className="h-10 border-b border-border/60">
                  <td><Link href={`/deals/${r.dealId}`} className="hover:text-accent">{r.advertiser} · <span className="text-muted">{r.deal}</span></Link></td>
                  <td className="text-muted">{fmtDate(r.from)} — {fmtDate(r.to)}</td>
                  <td className="text-right">{fmtMoney(r.outstanding)}</td>
                  <td className="text-right text-muted">{fmtDate(r.dueAt)}</td>
                  <td className="text-right">{r.status === "DISPUTED" ? <StatusBadge status="DISPUTED" /> : r.overdueDays > 0 ? <span className="text-negative">{r.overdueDays} дн.</span> : <span className="text-faint">—</span>}</td>
                </tr>
              ))}</tbody>
            </table></TableScroll>
          )}
        </Section>
      </div>
    </>
  );
}
