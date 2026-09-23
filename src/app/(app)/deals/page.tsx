import Link from "next/link";
import { DataTable } from "@/components/data/data-table";
import { PageHeader } from "@/components/layout/page-header";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { DealFormButton } from "@/components/pages/deal-form";
import { EnterPeriodButton, PaymentButton } from "@/components/pages/period-forms";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/card";
import { cn } from "@/lib/cn";
import { fmtDate, fmtMoney } from "@/lib/format";
import { periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { dealFormOptions } from "@/server/queries/deal-form";
import { BASIS_LABEL, dealsList, paymentsRegister, todoQueue } from "@/server/queries/deals";

const TABS = [["deals", "Дилы"], ["todo", "Нужно внести"], ["payments", "Оплаты"]] as const;

export default async function Deals({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab = TABS.some(([t]) => t === sp.tab) ? sp.tab! : "deals";
  const p = periodFromParams(sp, "mtd");
  const [opts, todo] = await Promise.all([dealFormOptions(), todoQueue()]);
  const q = (patch: Record<string, string | undefined>) => ({ query: { ...sp, ...patch } });

  return (
    <>
      <PageHeader title="Фикс-дилы" sub="Прямые сделки вне аукциона AdSpyglass: что идёт, сколько принесло, кто нам должен"
        period={tab === "deals" ? p : undefined} actions={<DealFormButton sites={opts.sites} advertisers={opts.advertisers} label="Новый дил" />} />
      <nav className="flex gap-1 border-b border-border">
        {TABS.map(([t, label]) => (
          <Link key={t} href={q({ tab: t === "deals" ? undefined : t })} className={cn("-mb-px border-b-2 px-3 py-2 text-sm", tab === t ? "border-accent font-medium text-accent" : "border-transparent text-muted hover:text-text")}>
            {label}{t === "todo" && todo.length > 0 && <Badge tone="warning" className="ml-1.5">{todo.length}</Badge>}
          </Link>
        ))}
      </nav>
      {tab === "deals" && <DealsTab sp={sp} p={p} q={q} />}
      {tab === "todo" && <TodoTab todo={todo} />}
      {tab === "payments" && <PaymentsTab />}
    </>
  );
}

async function DealsTab({ sp, p, q }: { sp: Record<string, string | undefined>; p: ReturnType<typeof periodFromParams>; q: (x: Record<string, string | undefined>) => object }) {
  const deals = await dealsList(p, sp.status);
  const adv = sp.adv;
  const rows = deals.filter((d) => !adv || d.advertiser === adv).map((d) => ({
    ...d, _key: d.id, _href: `/deals/${d.id}`, name: `${d.advertiser} · ${d.title}`, formatLabel: FORMAT_LABEL[d.format] ?? d.format,
    terms: `${BASIS_LABEL[d.basis]} · $${d.price}`, sitesLabel: d.sites.slice(0, 3).join(", ") + (d.sites.length > 3 ? ` +${d.sites.length - 3}` : ""),
    statusLabel: { ACTIVE: "активен", PAUSED: "на паузе", ENDED: "завершён", DRAFT: "черновик" }[d.status],
    _dashed: { forecast: true }, _warn: d.multiplier != null && d.multiplier > 1.5,
    _badges: d.billedVia === "VIA_ASG" ? { name: [{ label: "через ASG", tone: "neutral" as const }] } : undefined,
  }));
  const statuses = [["", "Текущие"], ["ACTIVE", "Активные"], ["PAUSED", "На паузе"], ["DRAFT", "Черновики"], ["archive", "Архив"]];
  const advertisers = [...new Set(deals.map((d) => d.advertiser))].sort();
  return (
    <Section title="Все дилы" actions={
      <div className="flex flex-wrap gap-1 text-xs">
        {statuses.map(([v, l]) => <Link key={v} href={q({ status: v || undefined })} className={cn("rounded-full border px-2.5 py-1", (sp.status ?? "") === v ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}>{l}</Link>)}
      </div>}>
      {advertisers.length > 1 && (
        <div className="flex flex-wrap gap-1 text-xs">
          <span className="py-1 pr-1 text-muted">Рекламодатель:</span>
          {[undefined, ...advertisers].map((a) => <Link key={a ?? "all"} href={q({ adv: a })} className={cn("rounded-full border px-2.5 py-1", adv === a ? "border-accent bg-accent-soft text-accent" : "border-border text-muted")}>{a ?? "все"}</Link>)}
        </div>
      )}
      <DataTable id="deals" exportName="deals" defaultSort={{ id: "forecast", dir: "desc" }} empty="Дилов пока нет — создайте первый"
        columns={[
          { id: "name", header: "Рекламодатель · дил", kind: "text" }, { id: "formatLabel", header: "Формат", kind: "text" }, { id: "terms", header: "Модель · цена", kind: "text" },
          { id: "sitesLabel", header: "Сайты", kind: "mono" }, { id: "forecast", header: "Прогноз", kind: "money" }, { id: "invoiced", header: "Выставлено", kind: "money" },
          { id: "confirmed", header: "Подтверждено", kind: "money" },
          { id: "multiplier", header: "Множитель", kind: "multiplier", tooltip: "Показы рекламодателя / наши. Больше 1.5× — рекламодатель засчитывает заметно больше" },
          { id: "statusLabel", header: "Статус", kind: "text" },
        ]} rows={rows} />
    </Section>
  );
}

async function TodoTab({ todo }: { todo: Awaited<ReturnType<typeof todoQueue>> }) {
  const deals = await db.deal.findMany({ where: { id: { in: [...new Set(todo.map((t) => t.dealId))] } }, include: { sites: { include: { site: true } } } });
  const byId = new Map(deals.map((d) => [d.id, { id: d.id, basis: d.paymentBasis, price: Number(d.price), termsDays: d.paymentTermsDays, sites: d.sites.map((s) => ({ id: s.siteId, domain: s.site.domain })) }]));
  return (
    <Section title="Очередь" sub="Закрытые периоды без цифр рекламодателя и счета без оплаты после срока">
      {todo.length === 0 ? <p className="py-10 text-center text-sm text-muted">Всё внесено 🎉</p> : (
        <ul className="-mx-5 divide-y divide-border">
          {todo.map((t) => (
            <li key={`${t.kind}-${t.dealId}-${t.from}`} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <span className={cn("size-2 rounded-full", t.kind === "overdue" ? "bg-negative" : t.overdueDays > 0 ? "bg-warning" : "bg-accent")} />
              <div className="min-w-0 flex-1">
                <Link href={`/deals/${t.dealId}`} className="text-sm font-medium hover:text-accent">{t.advertiser} · {t.title}</Link>
                <div className="text-xs text-muted">{fmtDate(t.from)} — {fmtDate(t.to)} · {t.kind === "overdue" ? `счёт не оплачен, просрочка ${t.overdueDays} дн.` : t.overdueDays > 0 ? `цифры ждём уже ${t.overdueDays + 7} дн.` : "период закрыт"}</div>
              </div>
              <span className="num text-sm">{t.kind === "overdue" ? <>остаток {fmtMoney(t.outstanding)}</> : <span className="rounded border border-dashed border-border-strong px-1 text-muted">{fmtMoney(t.forecast)}</span>}</span>
              {t.kind === "enter" && byId.get(t.dealId) && <EnterPeriodButton deal={byId.get(t.dealId)!} values={{ from: t.from, to: t.to }} />}
              {t.kind === "overdue" && t.periodId && <PaymentButton dealId={t.dealId} periodId={t.periodId} invoiced={t.forecast} paid={t.forecast - (t.outstanding ?? 0)} />}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

async function PaymentsTab() {
  const { rows, advertisers } = await paymentsRegister();
  return (
    <>
      <Section title="Итог по рекламодателям">
        <DataTable id="adv" columns={[{ id: "advertiser", header: "Рекламодатель", kind: "text" }, { id: "invoiced", header: "Выставлено", kind: "money" },
          { id: "paid", header: "Оплачено", kind: "money" }, { id: "outstanding", header: "Остаток", kind: "money" }, { id: "b30", header: "0–30 дн.", kind: "money" },
          { id: "b60", header: "31–60 дн.", kind: "money" }, { id: "b60p", header: "60+ дн.", kind: "money", heat: "sign" }]}
          rows={advertisers.map((a) => ({ ...a, _key: a.advertiser, b60p: a.b60p ? -a.b60p : 0 }))} defaultSort={{ id: "outstanding", dir: "desc" }} />
      </Section>
      <Section title="Реестр счетов">
        <DataTable id="pay" exportName="payments" defaultSort={{ id: "overdue", dir: "desc" }}
          columns={[{ id: "advertiser", header: "Рекламодатель", kind: "text" }, { id: "deal", header: "Дил", kind: "text" }, { id: "period", header: "Период", kind: "mono" },
            { id: "invoiced", header: "Выставлено", kind: "money" }, { id: "paid", header: "Оплачено", kind: "money" }, { id: "outstanding", header: "Остаток", kind: "money" },
            { id: "dueAt", header: "Срок", kind: "mono" }, { id: "overdue", header: "Просрочка, дн.", kind: "int" }, { id: "statusLabel", header: "Статус", kind: "text" }]}
          filters={[{ id: "open", label: "Только неоплаченные", column: "outstanding", op: "gt", value: 0 }, { id: "late", label: "Просроченные", column: "overdue", op: "gt", value: 0 }]}
          rows={rows.map((r) => ({ ...r, _key: r.id, _href: `/deals/${r.dealId}`, _warn: r.overdue > 30,
            statusLabel: ({ INVOICED: "выставлено", PAID: "оплачено", PARTIAL: "частично", DISPUTED: "спор", WRITTEN_OFF: "списано" } as Record<string, string>)[r.status] ?? r.status }))} />
      </Section>
    </>
  );
}

