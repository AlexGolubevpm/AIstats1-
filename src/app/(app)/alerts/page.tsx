import Link from "next/link";
import { AlertBadge } from "@/components/data/misc";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { Select } from "@/components/ui/input";
import { fmtDate, fmtMoney } from "@/lib/format";
import { db } from "@/server/db";
import { SnoozeButton } from "./snooze";

const RULE_LABEL: Record<string, string> = {
  loss_geo: "Убыточное гео", waterfall_inversion: "Инверсия waterfall", discrepancy: "Дискрепанси", invisible_zone: "Невидимая зона",
  dead_zone: "Мёртвая зона", low_fill: "Низкий фил", deal_no_numbers: "Дил без цифр", overdue_payment: "Просроченная оплата", ingest_down: "Ингест",
};

export default async function Alerts({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const now = new Date();
  const bundle = sp.bundle ? await db.bundle.findUnique({ where: { slug: sp.bundle }, include: { sites: true } }) : null;
  const alerts = await db.alert.findMany({
    where: {
      resolvedAt: null,
      ...(sp.hidden ? {} : { OR: [{ snoozedUntil: null }, { snoozedUntil: { lt: now } }] }),
      ...(sp.rule ? { rule: sp.rule } : {}),
      ...(bundle ? { siteId: { in: bundle.sites.map((s) => s.siteId) } } : {}),
    },
    orderBy: [{ moneyAtRisk: "desc" }, { lastSeenAt: "desc" }],
  });
  const bundles = await db.bundle.findMany({ orderBy: { title: "asc" } });
  const groups = [["CRITICAL", "Critical"], ["WARNING", "Warning"]] as const;
  const days = (a: Date, b: Date) => Math.max(1, Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1);
  return (
    <>
      <PageHeader title="Алерты" sub="Что требует действия. Правила считаются каждую ночь после загрузки данных" />
      <form className="flex flex-wrap items-center gap-2 text-sm">
        <Select name="rule" defaultValue={sp.rule ?? ""} className="w-52"><option value="">Все правила</option>
          {Object.entries(RULE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select name="bundle" defaultValue={sp.bundle ?? ""} className="w-44"><option value="">Все бандлы</option>
          {bundles.map((b) => <option key={b.slug} value={b.slug}>{b.title}</option>)}</Select>
        <label className="flex items-center gap-2 text-muted"><input type="checkbox" name="hidden" value="1" defaultChecked={Boolean(sp.hidden)} /> Показать скрытые</label>
        <button className="h-9 rounded-md border border-border px-3 hover:bg-surface-hover">Применить</button>
        {(sp.rule || sp.bundle || sp.hidden) && <Link href="/alerts" className="text-accent">Сбросить</Link>}
      </form>
      {groups.map(([level, title]) => {
        const list = alerts.filter((a) => a.level === level);
        if (!list.length) return null;
        return (
          <Section key={level} title={`${title} · ${list.length}`}>
            {[...list.reduce((m, a) => m.set(a.rule, [...(m.get(a.rule) ?? []), a]), new Map<string, typeof list>())].map(([rule, items]) => {
              const all = items ?? [];
              const risk = all.reduce((x, a) => x + Number(a.moneyAtRisk), 0);
              const row = (a: (typeof all)[number]) => {
                const snoozed = Boolean(a.snoozedUntil && a.snoozedUntil > now);
                return (
                  <li key={a.id} className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <AlertBadge level={a.level} title={a.title} message={a.message} link={a.link}
                        meta={<>с {fmtDate(a.firstSeenAt)} · {days(a.firstSeenAt, a.lastSeenAt)} дн. подряд
                          {Number(a.moneyAtRisk) > 0 && <> · под риском {fmtMoney(Number(a.moneyAtRisk))}</>}{snoozed && <> · скрыт до {fmtDate(a.snoozedUntil)}</>}</>} />
                    </div>
                    <div className="pt-2.5"><SnoozeButton id={a.id} snoozed={snoozed} /></div>
                  </li>
                );
              };
              return (
                <div key={rule} className="border-t border-border pt-2 first:border-0 first:pt-0">
                  <div className="flex items-baseline justify-between text-sm"><span className="font-medium">{RULE_LABEL[rule] ?? rule} · {all.length}</span>
                    {risk > 0 && <span className="num text-xs text-muted">под риском {fmtMoney(risk)}</span>}</div>
                  <ul className="-mx-2 divide-y divide-border">{all.slice(0, 5).map(row)}</ul>
                  {all.length > 5 && (
                    <details className="group">
                      <summary className="cursor-pointer py-1 text-sm text-accent">Ещё {all.length - 5}</summary>
                      <ul className="-mx-2 divide-y divide-border">{all.slice(5).map(row)}</ul>
                    </details>
                  )}
                </div>
              );
            })}
          </Section>
        );
      })}
      {!alerts.length && <section className="card py-12 text-center text-sm text-muted">Активных алертов нет</section>}
    </>
  );
}
