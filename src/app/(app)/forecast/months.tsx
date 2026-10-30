import Link from "next/link";
import { TrendChart } from "@/components/data/charts";
import { KpiCard } from "@/components/data/kpi-card";
import { DealFormButton } from "@/components/pages/deal-form";
import { Section } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { fmtMoney } from "@/lib/format";
import type { MonthsForecast } from "@/server/queries/forecast";
import { PLAN_ITEM_LABEL } from "@/server/services/forecast-plan";
import { DeleteOpex, OpexButton } from "../finance/opex";
import { CopyOpex, DeletePlanItem, PlanItemButton, PlanMonthForm, ResetMonth, ScenarioForm, type MonthLine } from "./plan";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const shortMonth = (m: string) => `${MONTHS[+m.slice(5, 7) - 1].slice(0, 3)} ${m.slice(2, 4)}`;
const money = (v: number) => fmtMoney(v);

type DealOpts = Parameters<typeof DealFormButton>[0];

/** /forecast «На месяцы вперёд»: this month as projected, then the horizon month by month (ADR 0020). */
export interface MonthOpex { id: string; title: string; category: string; amount: number; siteId: string | null; note: string | null }

export function MonthsView({ f, sites, dealOpts, selected, opex, opexFrom, href }: {
  f: MonthsForecast; sites: { id: string; domain: string }[]; dealOpts: Pick<DealOpts, "sites" | "advertisers" | "placements">;
  /** The month the panel opens; its own opex entries; the month its opex is carried from when it has none. */
  selected: string | null; opex: MonthOpex[]; opexFrom: string | null; href: (over: Record<string, string | undefined>) => string;
}) {
  const { current: c, months } = f;
  const all = [...(c ? [{ month: c.month, revenue: c.revenue, cost: c.cost, opex: c.opex, margin: c.margin, cumMargin: c.cumMargin }] : []), ...months];
  const total = { revenue: months.reduce((a, m) => a + m.revenue, 0), cost: months.reduce((a, m) => a + m.cost, 0), opex: months.reduce((a, m) => a + m.opex, 0), margin: months.reduce((a, m) => a + m.margin, 0),
    base: months.reduce((a, m) => a + m.baseMargin, 0) };
  const net = (r: { itemsRevenue: number; itemsCost: number; itemsSaving: number }) => r.itemsRevenue - r.itemsCost + r.itemsSaving;
  const end = all[all.length - 1]?.cumMargin ?? null;
  const next = months[0]?.month ?? c?.month ?? "";
  const chart = [
    ...(c ? [{ label: `${shortMonth(c.month)} · прогноз`, rotation: c.revenue - c.upcomingDeals - c.itemsRevenue, deals: c.upcomingDeals, items: c.itemsRevenue, cost: c.cost, opex: c.opex, margin: c.margin, baseMargin: c.baseMargin }] : []),
    ...months.map((m) => ({ label: shortMonth(m.month), rotation: m.rotation, deals: m.deals + (f.plan.includeDrafts ? m.draftDeals : 0), items: m.itemsRevenue, cost: m.cost, opex: m.opex, margin: m.margin, baseMargin: m.baseMargin })),
  ];
  const sel = months.find((m) => m.month === selected) ?? null;
  const selIdx = sel ? months.indexOf(sel) : -1;
  const prevMonth = selIdx > 0 ? months[selIdx - 1].month : c?.month ?? null;
  const prevLabel = prevMonth ? monthLabel(prevMonth) : "прошлый месяц";
  const prevMargin = selIdx > 0 ? months[selIdx - 1].margin : c?.margin ?? null;
  const selItems = sel ? f.items.filter((x) => x.months.includes(sel.month)) : [];
  const lines: MonthLine[] = sel ? [
    { key: "rotation", label: "Ротация ASG", defaultAmount: sel.defaults.rotation, value: sel.edited.rotation ? sel.rotation : null },
    { key: "traffic_cost", label: "Расход на трафик", defaultAmount: sel.defaults.trafficCost, value: sel.edited.trafficCost ? sel.trafficCost : null },
    ...sel.dealLines.map((d) => ({ key: `deal:${d.id}`, label: `${d.title}${d.draft ? " · черновик" : ""}`, deal: true, defaultAmount: d.defaultAmount, value: d.edited ? d.amount : null,
      sub: `${d.sites}${d.source === "contract" ? (d.estimate ? " · оценка по загрузкам сайтов" : " · по договору") : ` · как ${prevLabel}`}` })),
  ] : [];
  const growth = (v: number) => (v ? `${v > 0 ? "+" : ""}${Math.round(v * 1000) / 10}%/мес` : "без роста");
  const th = "h-8 text-right font-medium";

  return (
    <>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 min-[1500px]:grid-cols-6">
        <KpiCard label={`Выручка за ${months.length} мес.`} value={months.length ? total.revenue : null} format="money" color="#3B82F6" sub={`ротация ${growth(f.plan.revenueGrowth)}`} />
        <KpiCard label="Расход на трафик и статьи" value={months.length ? total.cost : null} format="money" color="#F43F5E" tone="inverse" sub={`трафик ${growth(f.plan.costGrowth)}`} />
        <KpiCard label="Опер. расходы" value={months.length ? total.opex : null} format="money" color="#94A3B8" sub={months.some((m) => m.opexCarried) ? "часть — по прошлому месяцу" : "как внесены"} />
        <KpiCard label="Маржа за горизонт" value={months.length ? total.margin : null} format="money" color="#16A34A" negativeFrame={total.margin < 0}
          sub={months.length ? `база ${money(total.base)} · дилы и статьи ${total.margin - total.base >= 0 ? "+" : "−"}${money(Math.abs(total.margin - total.base))}` : "после опер. расходов"} />
        <KpiCard label="База: только ASG" value={months.length ? total.base : null} format="money" color="#64748B" negativeFrame={total.base < 0} sub="маржа без фикс-дилов и статей" />
        <KpiCard label="Накоплено к концу горизонта" value={end} format="money" color="#16A34A" negativeFrame={(end ?? 0) < 0}
          sub={all.length ? `${all[0].month === c?.month ? "с текущего месяца" : ""} по ${monthLabel(all[all.length - 1].month)}`.trim() : undefined} />
      </div>
      {!f.pace.daysUsed && <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">Нет полных дней с данными за последние {f.lookback} дн. — темп не посчитать, месяцы вперёд пусты.</p>}

      <Section title="Сценарий" sub={`Опора — ${c ? monthLabel(c.month) : "текущий месяц"} из ASG (факт + темп последних ${f.pace.daysUsed || f.lookback} дн.): ротация ${money(f.monthRate.rotation)}/день, расход на трафик ${money(f.monthRate.cost)}/день. Каждый следующий месяц по умолчанию — как предыдущий, рост ниже умножает его ставку. Прямые фикс-дилы — по договору, пока месяц их не поправит; черновики — только если включить`}>
        <ScenarioForm plan={f.plan} />
      </Section>

      <Section title="По месяцам" sub="Столбцы — выручка: ротация, фикс-дилы, плановые статьи; линии — расход, опер. расходы и маржа"
        actions={<div className="flex flex-wrap gap-2">
          <DealFormButton {...dealOpts} label="Новый дил" variant="secondary" values={{ startsAt: `${next}-01` }} />
          <PlanItemButton sites={sites} defaultMonth={next} minMonth={c?.month ?? next} />
          <OpexButton sites={sites} defaultMonth={next} label="Опер. расход на месяц" />
        </div>}>
        <TrendChart data={chart} xKey="label" height={300} series={[
          { key: "rotation", label: "Ротация", color: "#3B82F6", type: "bar", stack: "rev" },
          { key: "deals", label: "Фикс-дилы", color: "#A78BFA", type: "bar", stack: "rev" },
          { key: "items", label: "Статьи", color: "#22D3EE", type: "bar", stack: "rev" },
          { key: "cost", label: "Расход", color: "#F43F5E", type: "line" },
          { key: "opex", label: "Опер. расходы", color: "#94A3B8", type: "line", dashed: true },
          { key: "margin", label: "Маржа", color: "#16A34A", type: "line" },
          { key: "baseMargin", label: "Маржа базы (только ASG)", color: "#64748B", type: "line", dashed: true },
        ]} />
        <div className="-mx-5 mt-4 overflow-x-auto">
          <table className="num w-full text-[12px]" data-testid="forecast-months">
            <thead><tr className="border-b border-border text-xs text-muted">
              <th className="h-8 pl-5 text-left font-medium">Месяц</th><th className={th}>Ротация</th><th className={th}>Фикс-дилы</th><th className={th}>Статьи</th>
              <th className={th}>Выручка</th><th className={th}>Расход</th><th className={th}>Опер.</th><th className={th}>Маржа</th><th className={th} title="Только ASG по темпу: без фикс-дилов и плановых статей">Маржа базы</th><th className={th}>ROMI</th><th className={cn(th, "pr-5")}>Накоплено</th></tr></thead>
            <tbody>
              {c && (
                <tr className="h-8 border-b border-border/60" data-month={c.month}>
                  <td className="pl-5">{monthLabel(c.month)} <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] text-accent">текущий</span></td>
                  <td className="text-right text-muted" colSpan={2} title="факт с начала месяца + темп; идущие дилы уже в темпе">факт {money(c.actualRevenue)} + темп{c.upcomingDeals ? ` · дилы ${money(c.upcomingDeals)}` : ""}</td>
                  <td className="text-right">{c.itemsRevenue || c.itemsCost || c.itemsSaving ? money(net(c)) : "—"}</td>
                  <td className="text-right">{money(c.revenue)}</td><td className="text-right">{money(c.cost)}</td><td className="text-right">{money(c.opex)}</td>
                  <td className={cn("text-right", c.margin < 0 && "text-negative")}>{money(c.margin)}</td>
                  <td className={cn("text-right text-muted", c.baseMargin < 0 && "text-negative")}>{money(c.baseMargin)}</td>
                  <td className="text-right">{c.romi == null ? "—" : `${Math.round(c.romi)}%`}</td><td className="pr-5 text-right">{money(c.cumMargin)}</td>
                </tr>
              )}
              {months.map((m) => (
                <tr key={m.month} className={cn("h-8 border-b border-border/60 text-muted", m.month === selected && "bg-accent-soft/40")} data-month={m.month}>
                  <td className="pl-5 text-text"><Link href={href({ m: m.month })} className="hover:text-accent" scroll={false}>{monthLabel(m.month)}</Link>
                    {(m.edited.rotation || m.edited.trafficCost || m.dealLines.some((d) => d.edited)) && <span className="ml-1.5 inline-block size-1.5 rounded-full bg-accent align-middle" title="месяц поправлен вручную" data-edited />}</td>
                  <td className="text-right">{money(m.rotation)}</td>
                  <td className="text-right">{m.deals ? money(m.deals) : "—"}{m.draftDeals > 0 && <span className="ml-1 text-[11px] text-faint" title="черновики дилов">{f.plan.includeDrafts ? "вкл. " : "+"}{money(m.draftDeals)} черн.</span>}</td>
                  <td className="text-right">{m.itemsRevenue || m.itemsCost || m.itemsSaving ? money(net(m)) : "—"}</td>
                  <td className="text-right text-text">{money(m.revenue)}</td><td className="text-right">{money(m.cost)}</td>
                  <td className="text-right">{money(m.opex)}{m.opexCarried && <span className="ml-1 text-[11px] text-faint" title="на этот месяц ничего не внесено — повтор последнего месяца с записями">*</span>}</td>
                  <td className={cn("text-right text-text", m.margin < 0 && "text-negative")}>{money(m.margin)}</td>
                  <td className={cn("text-right", m.baseMargin < 0 && "text-negative")} data-base>{money(m.baseMargin)}</td>
                  <td className="text-right">{m.romi == null ? "—" : `${Math.round(m.romi)}%`}</td><td className="pr-5 text-right">{money(m.cumMargin)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-faint">Клик по месяцу открывает его ниже: по умолчанию месяц — как предыдущий, правки переходят в следующие (точка — месяц поправлен). Будущие месяцы — прогноз. «Маржа базы» — только ASG по темпу последних дней, без фикс-дилов и статей: что будет, если ничего нового не делать. Статьи — рост выручки − новые расходы + экономия. * опер. расходы на месяц не внесены — повторён последний месяц с записями. ROMI — на расход.</p>
      </Section>

      {sel && (
        <Section title={`Месяц: ${monthLabel(sel.month)}`} sub={`По умолчанию каждая строка — как ${prevLabel} (в день × ${sel.days} дн.). Поправьте нужное: следующие месяцы возьмут цифры этого месяца`}
          actions={<ResetMonth month={sel.month} />}>
          <nav className="mb-3 flex flex-wrap gap-1.5" aria-label="Месяц плана" data-testid="plan-months">
            {months.map((m) => <Link key={m.month} href={href({ m: m.month })} scroll={false} data-month-chip={m.month}
              className={cn("rounded-full border px-3 py-1 text-sm", m.month === sel.month ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover")}>{shortMonth(m.month)}</Link>)}
          </nav>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="space-y-6">
              <div>
                <h3 className="mb-1 text-sm font-medium">ASG и фикс-дилы</h3>
                <PlanMonthForm key={sel.month} month={sel.month} prevLabel={prevLabel} lines={lines} />
                <div className="mt-2 flex flex-wrap gap-2"><DealFormButton {...dealOpts} label={`Дил с ${monthLabel(sel.month)}`} variant="secondary" values={{ startsAt: `${sel.month}-01` }} /></div>
              </div>
              <div data-testid="plan-month-opex">
                <h3 className="mb-1 text-sm font-medium">Опер. расходы</h3>
                {opex.length ? (
                  <ul className="num divide-y divide-border/60 text-[13px]">
                    {opex.map((e) => (
                      <li key={e.id} className="flex flex-wrap items-center gap-x-2 py-1.5"><span>{e.title}</span><span className="ml-auto">{money(e.amount)}</span>
                        <OpexButton sites={sites} defaultMonth={sel.month} label="Изменить" values={{ ...e, month: sel.month }} /><DeleteOpex id={e.id} /></li>
                    ))}
                  </ul>
                ) : <p className="text-sm text-muted">{opexFrom ? <>Не внесены — берётся как {monthLabel(opexFrom)}: <span className="num">{money(sel.opex)}</span></> : "Не внесены"}</p>}
                <div className="mt-2 flex flex-wrap gap-2">
                  {!opex.length && opexFrom && <CopyOpex month={sel.month} from={monthLabel(opexFrom)} />}
                  <OpexButton sites={sites} defaultMonth={sel.month} label="Добавить расход" />
                </div>
              </div>
              <div>
                <h3 className="mb-1 text-sm font-medium">Плановые статьи</h3>
                {selItems.length === 0 ? <p className="text-sm text-muted">Нет</p> : (
                  <ul className="num space-y-1 text-[13px]">
                    {selItems.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center gap-x-2" data-item={x.id}>
                        <span>{x.title}</span>
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px]", x.kind === "COST" ? "bg-negative-soft text-negative" : "bg-positive-soft text-positive")}>{PLAN_ITEM_LABEL[x.kind]}</span>
                        {x.recurring && <span className="text-xs text-muted">каждый месяц с {monthLabel(x.month)}{x.untilMonth ? ` по ${monthLabel(x.untilMonth)}` : ""}</span>}
                        {x.hypothesisId && <Link href={`/hypotheses/${x.hypothesisId}`} className="text-xs text-accent hover:underline">гипотеза: {x.hypothesis}</Link>}
                        {x.domain && <span className="text-xs text-muted">{x.domain}</span>}
                        <span className="ml-auto">{x.kind === "COST" ? "−" : "+"}{money(x.amount)}</span>
                        <PlanItemButton sites={sites} defaultMonth={x.month} minMonth={[x.month, c?.month ?? next].sort()[0]} label="Изменить"
                          values={{ id: x.id, month: x.month, kind: x.kind, title: x.title, amount: x.amount, siteId: x.siteId, note: x.note, recurring: x.recurring, untilMonth: x.untilMonth, hypothesisId: x.hypothesisId }} />
                        <DeletePlanItem id={x.id} />
                      </li>
                    ))}
                  </ul>
                )}
                <div className="mt-2"><PlanItemButton sites={sites} defaultMonth={sel.month} minMonth={c?.month ?? next} label="Статья на месяц" /></div>
              </div>
            </div>
            <dl className="num h-fit space-y-2 rounded-lg border border-border p-4 text-sm" data-testid="plan-month-total">
              {([["Ротация ASG", sel.rotation], ["Фикс-дилы", sel.deals + (f.plan.includeDrafts ? sel.draftDeals : 0)], ["Статьи", net(sel)], ["Выручка", sel.revenue], ["Расход", -sel.cost], ["Опер. расходы", -sel.opex]] as const).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd>{money(v)}</dd></div>
              ))}
              <div className="flex justify-between gap-3 border-t border-border pt-2 font-semibold"><dt>Маржа</dt><dd className={sel.margin < 0 ? "text-negative" : ""}>{money(sel.margin)}</dd></div>
              <div className="flex justify-between gap-3 text-xs text-muted"><dt>{prevLabel}</dt><dd>{prevMargin == null ? "—" : money(prevMargin)}</dd></div>
              <div className="flex justify-between gap-3 text-xs text-muted"><dt>База: только ASG</dt><dd>{money(sel.baseMargin)}</dd></div>
            </dl>
          </div>
        </Section>
      )}
    </>
  );
}
