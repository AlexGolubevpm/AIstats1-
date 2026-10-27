import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { PageHeader } from "@/components/layout/page-header";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { Badge } from "@/components/ui/badge";
import { Section } from "@/components/ui/card";
import { fmtDate, fmtMoney } from "@/lib/format";
import { db } from "@/server/db";
import { METRIC_LABEL, OWN_STATUS_LABEL, SCOPE_LABEL, SOURCE_LABEL, STATUS_LABEL, evidenceLine, type HypScope, type Metric, type OwnStatus } from "@/server/domain/hypotheses";
import { hypothesisDetail } from "@/server/queries/hypotheses";
import { EditHypothesisForm, HypothesisActions, OwnStatusSwitch } from "../client";
import { fmtMetric, metricDelta } from "../format";

const FIELD_LABEL: Record<string, string> = {
  status: "статус", title: "заголовок", hypothesis: "гипотеза", bundleId: "бандл", siteId: "сайт", format: "формат", countryCode: "гео",
  impactMonth: "эффект, $/мес", metric: "метрика", resultNote: "заметка",
};

/** A hypothesis on its own page: what, where, the numbers, the status, the edit form and the history. */
export default async function HypothesisPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [h, bundles, sites] = await Promise.all([
    hypothesisDetail(id),
    db.bundle.findMany({ orderBy: { title: "asc" } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" }, include: { bundles: true } }),
  ]);
  if (!h) notFound();
  const own = h.source === "MANUAL";
  const metric = h.metric as Metric | null;
  const base = h.baseline == null ? null : Number(h.baseline), res = h.result == null ? null : Number(h.result);
  const { delta, better } = metricDelta(metric, base, res);
  const name = new Map<string, string>([...bundles.map((b) => [b.id, b.title] as const), ...sites.map((s) => [s.id, s.domain] as const)]);
  const statusName = (s: string) => (own ? OWN_STATUS_LABEL[s as OwnStatus] : undefined) ?? STATUS_LABEL[s as keyof typeof STATUS_LABEL] ?? s;
  const value = (field: string, v: string | null) =>
    v == null || v === "" ? "—" : field === "status" ? statusName(v) : field === "siteId" || field === "bundleId" ? name.get(v) ?? v
      : field === "format" ? FORMAT_LABEL[v] ?? v : field === "metric" ? METRIC_LABEL[v as Metric] ?? v : v;
  const evidence = h.ruleKey ? evidenceLine(h.ruleKey, h.evidence) : null;
  const fact = (label: string, v: ReactNode) => <div><dt className="text-xs text-muted">{label}</dt><dd className="num mt-0.5 text-sm">{v}</dd></div>;

  return (
    <>
      <PageHeader crumbs={[{ href: own ? "/hypotheses?tab=mine" : "/hypotheses", label: own ? "Наши гипотезы" : "Гипотезы системы" }]} title={h.title}
        badges={<><Badge data-testid="hypothesis-status">{statusName(h.status)}</Badge><Badge>{SOURCE_LABEL[h.source]}</Badge><Badge>{SCOPE_LABEL[h.scope as HypScope] ?? h.scope}</Badge></>}
        sub={[h.bundle?.title, h.site?.domain, h.format && (FORMAT_LABEL[h.format] ?? h.format), h.countryCode].filter(Boolean).join(" · ") || "вся сеть"}
        actions={own ? <OwnStatusSwitch id={h.id} status={h.status} /> : <HypothesisActions id={h.id} status={h.status} />} />

      <Section title="Гипотеза">
        <p className="text-sm" data-testid="hypothesis-text">{h.hypothesis}</p>
        {evidence && <p className="num mt-2 text-xs text-muted">{evidence}</p>}
        {h.link !== "/hypotheses" && <p className="mt-2 text-sm"><Link href={h.link} className="text-accent hover:underline">Открыть объект →</Link></p>}
        <dl className="mt-4 grid gap-4 sm:grid-cols-3 lg:grid-cols-6">
          {fact("Ожидаемый эффект", Number(h.impactMonth ?? 0) > 0 ? `${fmtMoney(Number(h.impactMonth))}/мес` : "—")}
          {fact("Метрика", metric ? METRIC_LABEL[metric] : "—")}
          {fact("База (14 дней до старта)", fmtMetric(metric, base))}
          {fact("Итог", h.status === "DONE" ? <>{fmtMetric(metric, res)}{delta != null && <span className={better ? "text-positive" : "text-negative"}> ({delta > 0 ? "+" : ""}{(delta * 100).toFixed(0)}%)</span>}{res == null && " (мало данных)"}</> : "—")}
          {fact(own ? "Добавлена" : "Замечена", fmtDate(own ? h.createdAt : h.firstSeenAt))}
          {fact(own ? "Старт" : "В работе с", h.acceptedAt ? fmtDate(h.acceptedAt) : "—")}
        </dl>
      </Section>

      <Section title={own ? "Редактировать" : "Заметка"} sub={own ? "Новый объект или метрика пересчитают базу от того же дня старта" : "Текст и объект предложения ведёт система — они обновляются каждую ночь. Своя заметка сохраняется"}>
        <EditHypothesisForm id={h.id} own={own} note={h.resultNote}
          values={{ title: h.title, hypothesis: h.hypothesis, bundleId: h.bundleId, siteId: h.siteId, format: h.format, countryCode: h.countryCode, impactMonth: h.impactMonth == null ? null : String(Number(h.impactMonth)), metric: h.metric }}
          bundles={bundles.map((b) => ({ id: b.id, title: b.title }))} sites={sites.map((s) => ({ id: s.id, domain: s.domain, bundleIds: s.bundles.map((b) => b.bundleId) }))} formats={Object.keys(FORMAT_LABEL)} />
      </Section>

      <Section title="История">
        {h.history.length === 0 ? <p className="py-4 text-sm text-muted">Изменений нет</p> : (
          <ul className="divide-y divide-border text-[13px]" data-testid="hypothesis-history">
            {h.history.map((a) => (
              <li key={a.id} className="flex flex-wrap gap-x-3 py-2">
                <span className="w-32 shrink-0 text-muted">{fmtDate(a.at)} {a.at.toISOString().slice(11, 16)}</span>
                <span className="font-medium">{FIELD_LABEL[a.field] ?? a.field}</span>
                {a.before != null && <span className="text-muted line-through">{value(a.field, a.before)}</span>}
                {a.after != null && <span>{value(a.field, a.after)}</span>}
                {a.reason != null && a.field === "status" && a.before == null && <span className="text-muted">· {a.reason}</span>}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
