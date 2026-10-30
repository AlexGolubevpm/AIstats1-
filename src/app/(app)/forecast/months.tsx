import Link from "next/link";
import { TrendChart } from "@/components/data/charts";
import { KpiCard } from "@/components/data/kpi-card";
import { DealFormButton } from "@/components/pages/deal-form";
import { Section } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { fmtMoney } from "@/lib/format";
import type { MonthsForecast } from "@/server/queries/forecast";
import { PLAN_ITEM_LABEL } from "@/server/services/forecast-plan";
import { OpexButton } from "../finance/opex";
import { DeletePlanItem, PlanItemButton, ScenarioForm } from "./plan";

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const monthLabel = (m: string) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const shortMonth = (m: string) => `${MONTHS[+m.slice(5, 7) - 1].slice(0, 3)} ${m.slice(2, 4)}`;
const money = (v: number) => fmtMoney(v);

type DealOpts = Parameters<typeof DealFormButton>[0];

/** /forecast «На месяцы вперёд»: this month as projected, then the horizon month by month (ADR 0020). */
export function MonthsView({ f, sites, dealOpts }: { f: MonthsForecast; sites: { id: string; domain: string }[]; dealOpts: Pick<DealOpts, "sites" | "advertisers" | "placements"> }) {
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

      <Section title="Сценарий" sub={`Темп — последние ${f.pace.daysUsed || f.lookback} полных дней: ротация ${money(f.pace.rotation)}/день, расход на трафик ${money(f.pace.cost)}/день. Прямые фикс-дилы — по своим датам, черновики — только если включить`}>
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
                <tr key={m.month} className="h-8 border-b border-border/60 text-muted" data-month={m.month}>
                  <td className="pl-5 text-text">{monthLabel(m.month)}</td>
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
        <p className="mt-3 text-xs text-faint">Будущие месяцы — прогноз по темпу. «Маржа базы» — только ASG по темпу последних дней, без фикс-дилов и статей: что будет, если ничего нового не делать. Статьи — рост выручки − новые расходы + экономия. * опер. расходы на месяц не внесены — повторён последний месяц с записями. ROMI — на расход.</p>
      </Section>

      <Section title="Дилы и статьи по месяцам" sub="Прямые фикс-дилы по датам: флэт — как выставляется, за 1000 загрузок / CPM — по их начислениям за последние дни, без начислений — оценка по загрузкам сайтов">
        <div className="-mx-5 divide-y divide-border/60" data-testid="forecast-month-details">
          {months.map((m, k) => {
            const items = f.items.filter((x) => x.months.includes(m.month));
            return (
              <details key={m.month} open={k === 0} className="px-5 py-2" data-month={m.month}>
                <summary className="cursor-pointer text-sm font-medium">{monthLabel(m.month)} <span className="num ml-2 text-xs font-normal text-muted">дилы {money(m.deals)}{m.draftDeals ? ` · черновики ${money(m.draftDeals)}` : ""} · статьи {money(net(m))}</span></summary>
                <div className="mt-2 flex flex-wrap gap-2">
                  <DealFormButton {...dealOpts} label={`Дил с ${monthLabel(m.month)}`} variant="secondary" values={{ startsAt: `${m.month}-01` }} />
                  <PlanItemButton sites={sites} defaultMonth={m.month} minMonth={c?.month ?? next} label="Статья на месяц" />
                </div>
                {m.dealLines.length === 0 && items.length === 0 ? <p className="py-2 text-xs text-muted">Ни дилов, ни статей на этот месяц</p> : (
                  <ul className="num mt-2 space-y-1 text-[13px]">
                    {m.dealLines.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-center gap-x-2" data-deal={d.id}>
                        <Link href={`/deals/${d.id}`} className="hover:text-accent">{d.title}</Link>
                        <span className="text-xs text-muted">{d.sites}</span>
                        {d.draft && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">черновик</span>}
                        {d.estimate && <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[11px] text-warning" title="дил ещё не начислялся: цена × загрузки его сайтов в день">оценка</span>}
                        <span className="ml-auto">{money(d.amount)}</span>
                      </li>
                    ))}
                    {items.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center gap-x-2" data-item={x.id}>
                        <span>{x.title}</span>
                        <span className={cn("rounded px-1.5 py-0.5 text-[11px]", x.kind === "COST" ? "bg-negative-soft text-negative" : "bg-positive-soft text-positive")}>{PLAN_ITEM_LABEL[x.kind]}</span>
                        {x.recurring && <span className="text-xs text-muted">каждый месяц с {monthLabel(x.month)}{x.untilMonth ? ` по ${monthLabel(x.untilMonth)}` : ""}</span>}
                        {x.hypothesisId && <Link href={`/hypotheses/${x.hypothesisId}`} className="text-xs text-accent hover:underline">гипотеза: {x.hypothesis}</Link>}
                        {x.domain && <span className="text-xs text-muted">{x.domain}</span>}
                        {x.note && <span className="text-xs text-faint">{x.note}</span>}
                        <span className="ml-auto">{x.kind === "COST" ? "−" : "+"}{money(x.amount)}</span>
                        <PlanItemButton sites={sites} defaultMonth={x.month} minMonth={[x.month, c?.month ?? next].sort()[0]} label="Изменить"
                          values={{ id: x.id, month: x.month, kind: x.kind, title: x.title, amount: x.amount, siteId: x.siteId, note: x.note, recurring: x.recurring, untilMonth: x.untilMonth, hypothesisId: x.hypothesisId }} />
                        <DeletePlanItem id={x.id} />
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            );
          })}
        </div>
      </Section>
    </>
  );
}
