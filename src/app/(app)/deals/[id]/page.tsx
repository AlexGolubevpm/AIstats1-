import { notFound } from "next/navigation";
import { TrendChart } from "@/components/data/charts";
import { KpiCard } from "@/components/data/kpi-card";
import { StatusBadge } from "@/components/data/misc";
import { PageHeader } from "@/components/layout/page-header";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { DealFormButton } from "@/components/pages/deal-form";
import { DisputeButton, EnterPeriodButton, PaymentButton } from "@/components/pages/period-forms";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { fmtDate, fmtInt, fmtMoney, fmtPercent } from "@/lib/format";
import { closedPeriods, type BillingPeriod } from "@/server/domain/deals";
import { iso } from "@/server/queries/common";
import { dealFormOptions } from "@/server/queries/deal-form";
import { BASIS_LABEL, dealDetail } from "@/server/queries/deals";
import { DealStatusButtons } from "./status";

const FIELD_LABEL: Record<string, string> = {
  created: "создан", status: "статус", payment: "оплата", correction: "исправление", title: "название", format: "формат", paymentBasis: "модель оплаты",
  price: "цена", geoScope: "гео", geoExclude: "гео: кроме", startsAt: "начало", endsAt: "конец", billingPeriod: "период счёта", paymentTermsDays: "срок оплаты",
  counterSource: "счётчик", billedVia: "биллинг", notes: "заметки",
};

export default async function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [x, opts] = await Promise.all([dealDetail(id), dealFormOptions()]);
  if (!x) notFound();
  const { deal } = x;
  const pd = { id: deal.id, basis: deal.paymentBasis, price: Number(deal.price), termsDays: deal.paymentTermsDays, sites: deal.sites.map((s) => ({ id: s.siteId, domain: s.site.domain })) };
  const active = x.periods.filter((p) => !p.supersededById);
  const entered = active.filter((p) => p.status !== "OPEN").map((p) => ({ from: iso(p.from), to: iso(p.to) }));
  const pending = closedPeriods({ startsAt: iso(deal.startsAt), endsAt: deal.endsAt ? iso(deal.endsAt) : null, billingPeriod: deal.billingPeriod as BillingPeriod }, iso(new Date()))
    .filter((c) => !entered.some((e) => e.from <= c.to && c.from <= e.to));
  const hasReported = x.daily.some((d) => d.reported);
  const values = {
    id: deal.id, title: deal.title, advertiser: deal.advertiser.name, format: deal.format, paymentBasis: deal.paymentBasis, price: deal.price.toString(),
    siteIds: deal.sites.map((s) => s.siteId), zoneBySite: Object.fromEntries(deal.sites.map((s) => [s.siteId, s.zoneId])), geoScope: deal.geoScope.join(", "),
    geoExclude: deal.geoExclude, startsAt: iso(deal.startsAt), endsAt: deal.endsAt ? iso(deal.endsAt) : null, billingPeriod: deal.billingPeriod,
    paymentTermsDays: deal.paymentTermsDays, counterSource: deal.counterSource, billedVia: deal.billedVia, notes: deal.notes, hasPeriods: entered.length > 0,
  };
  return (
    <>
      <PageHeader crumbs={[{ href: "/deals", label: "Фикс-дилы" }]} title={`${deal.advertiser.name} · ${deal.title}`}
        badges={<><StatusBadge status={deal.status} />{deal.billedVia === "VIA_ASG" && <Badge>через AdSpyglass</Badge>}</>}
        sub={`${FORMAT_LABEL[deal.format]} · ${BASIS_LABEL[deal.paymentBasis]} · $${deal.price} · ${deal.sites.map((s) => s.site.domain).join(", ")}${deal.geoScope.length ? ` · ${deal.geoExclude ? "кроме " : ""}${deal.geoScope.slice(0, 8).join(", ")}${deal.geoScope.length > 8 ? "…" : ""}` : ""}`}
        actions={<><DealFormButton sites={opts.sites} advertisers={opts.advertisers} values={values} label="Редактировать условия" variant="secondary" />
          <DealStatusButtons id={deal.id} status={deal.status} title={deal.title} /></>} />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 2xl:grid-cols-6">
        <KpiCard label="Прогноз" value={x.forecast} format="moneyPrecise" sub="ставка × наш счётчик" />
        <KpiCard label="Выставлено" value={x.invoiced} format="moneyPrecise" />
        <KpiCard label="Подтверждено" value={x.confirmed} format="moneyPrecise" color="#16A34A" />
        <KpiCard label="Остаток к оплате" value={x.outstanding} format="moneyPrecise" color="#E11D48" />
        <KpiCard label="Множитель показов" value={x.multiplier} format="decimal" sub="показы рекл. / наши"
          warn={x.multiplier != null && x.multiplier > 1.5 ? `Рекламодатель засчитывает в ${x.multiplier.toFixed(1)} раза больше показов` : undefined} />
        <KpiCard label="Эффективный CPM" value={x.effectiveCpm} format="moneyPrecise" sub="подтверждено / наши показы × 1000" />
      </div>

      <Section title="По дням" sub="Столбцы — выручка по статусам, линии — наши показы и показы рекламодателя">
        <div className="grid gap-4 lg:grid-cols-2">
          <TrendChart data={x.daily} height={240} series={[
            { key: "confirmed", label: "Подтверждено", color: "#16A34A", type: "bar", stack: "r" },
            { key: "invoiced", label: "Выставлено", color: "#4F8DF7", type: "bar", stack: "r" },
            { key: "forecast", label: "Прогноз", color: "#CBD5E1", type: "bar", stack: "r" },
          ]} />
          <TrendChart data={x.daily} height={240} kind="int" series={[
            { key: "own", label: "Наши показы", color: "#4F8DF7", type: "line" },
            ...(hasReported ? [{ key: "reported", label: "Показы рекламодателя", color: "#F59E0B", type: "line" as const }] : []),
          ]} />
        </div>
      </Section>

      <Section title="Периоды биллинга" actions={<EnterPeriodButton deal={pd} values={pending[0] ?? { from: iso(deal.startsAt), to: iso(new Date()) }} label="Внести период" variant="secondary" />}>
        <div className="-mx-5 overflow-x-auto">
          <table className="num w-full text-[13px]">
            <thead><tr className="border-b border-border text-xs text-muted">
              {["Период", "Наш счётчик", "Счётчик рекл.", "Дискрепанси", "Расчёт", "Выставлено", "Оплачено", "Статус", ""].map((h, i) =>
                <th key={i} className={cn("h-8 px-3 font-medium", i === 0 ? "pl-5 text-left" : "text-right", i === 8 && "pr-5")}>{h}</th>)}
            </tr></thead>
            <tbody>
              {pending.map((c) => (
                <tr key={`p-${c.from}`} className="h-10 border-b border-border/60 bg-warning-soft/50">
                  <td className="pl-5">{fmtDate(c.from)} — {fmtDate(c.to)}</td>
                  <td colSpan={6} className="px-3 text-right text-xs text-warning">период закрыт, цифр рекламодателя нет</td>
                  <td className="px-3 text-right"><Badge tone="warning">к вводу</Badge></td>
                  <td className="pr-5 text-right"><EnterPeriodButton deal={pd} values={c} /></td>
                </tr>
              ))}
              {x.periods.map((p) => {
                const old = Boolean(p.supersededById);
                const disc = p.discrepancy;
                return (
                  <tr key={p.id} className={cn("h-10 border-b border-border/60", old && "text-faint line-through decoration-border-strong")}>
                    <td className="pl-5">{fmtDate(p.from)} — {fmtDate(p.to)}{p.version > 1 && <span className="ml-1 text-xs text-muted no-underline">v{p.version}</span>}
                      {p.siteId && <span className="ml-1 font-mono text-[11px] text-muted">{deal.sites.find((s) => s.siteId === p.siteId)?.site.domain}</span>}</td>
                    <td className="px-3 text-right">{fmtInt(p.own)}</td>
                    <td className="px-3 text-right">{fmtInt(p.impsReported)}</td>
                    <td className={cn("px-3 text-right", disc != null && Math.abs(disc) > 0.1 && !old && "text-warning")}>{fmtPercent(disc)}</td>
                    <td className="px-3 text-right text-muted">{fmtMoney(Number(p.amountCalculated ?? 0))}</td>
                    <td className="px-3 text-right">{fmtMoney(Number(p.amountInvoiced ?? 0))}{p.overrideReason && <span title={`переопределено: ${p.overrideReason}`}> ✎</span>}</td>
                    <td className="px-3 text-right">{p.amountPaid == null ? <span className="text-faint">—</span> : fmtMoney(Number(p.amountPaid))}</td>
                    <td className="px-3 text-right">{old ? "заменён" : <StatusBadge status={p.status} />}</td>
                    <td className="pr-5 text-right whitespace-nowrap">{!old && (
                      <span className="inline-flex gap-0.5">
                        {["INVOICED", "PARTIAL", "DISPUTED"].includes(p.status) && <PaymentButton dealId={deal.id} periodId={p.id} invoiced={Number(p.amountInvoiced ?? 0)} paid={Number(p.amountPaid ?? 0)} />}
                        {p.status === "INVOICED" && <DisputeButton dealId={deal.id} periodId={p.id} />}
                        <EnterPeriodButton deal={pd} label="Исправить" variant="ghost" values={{ periodId: p.id, from: iso(p.from), to: iso(p.to), siteId: p.siteId,
                          impsReported: p.impsReported, amountInvoiced: Number(p.amountInvoiced ?? 0), invoiceNo: p.invoiceNo, dueAt: p.dueAt ? iso(p.dueAt) : null }} />
                      </span>)}
                    </td>
                  </tr>
                );
              })}
              {!pending.length && !x.periods.length && <tr><td colSpan={9} className="py-8 text-center text-sm text-muted">Периоды ещё не закрывались — пока считается прогноз</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>

      <Section title="История">
        {x.history.length === 0 ? <p className="py-4 text-sm text-muted">Изменений нет</p> : (
          <ul className="divide-y divide-border text-[13px]">
            {x.history.map((h) => (
              <li key={String(h.id)} className="flex flex-wrap gap-x-3 py-2">
                <span className="w-32 shrink-0 text-muted">{fmtDate(h.at as Date)} {(h.at as Date).toISOString().slice(11, 16)}</span>
                <span className="font-medium">{FIELD_LABEL[String(h.field)] ?? String(h.field)}</span>
                {h.before != null && <span className="text-muted line-through">{String(h.before) || "—"}</span>}
                {h.after != null && <span>{String(h.after) || "—"}</span>}
                {h.reason != null && <span className="text-muted">· {String(h.reason)}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
