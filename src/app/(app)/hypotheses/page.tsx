import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { Section } from "@/components/ui/card";
import { fmtDate, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import { db } from "@/server/db";
import { METRIC_LABEL, SCOPE_LABEL, SOURCE_LABEL, STATUS_LABEL, type HypScope, type Metric } from "@/server/domain/hypotheses";
import { TAB_LABEL, hypothesesList, hypothesisCounts, type HypothesisTab } from "@/server/queries/hypotheses";
import { HypothesisActions, NewHypothesisButton } from "./client";

const SCOPES = Object.keys(SCOPE_LABEL) as HypScope[];
const TABS = Object.keys(TAB_LABEL) as HypothesisTab[];
const LEVEL: Record<string, string> = { CRITICAL: "bg-negative-soft text-negative", WARNING: "bg-warning-soft text-warning", INFO: "bg-accent-soft text-accent" };

/** A metric value in the unit the owner reads it in. */
function fmtMetric(metric: Metric | null, v: number | null): string {
  if (v == null) return "—";
  if (metric === "view_rate" || metric === "cost_share") return `${(v * 100).toFixed(1)}%`;
  if (metric === "rev_per_1k" || metric === "rpm" || metric === "cost_per_1k") return `$${v.toFixed(4)}`;
  return fmtMoney(v);
}

export default async function Hypotheses({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab: HypothesisTab = TABS.includes(sp.tab as HypothesisTab) ? (sp.tab as HypothesisTab) : "proposed";
  const scope = SCOPES.includes(sp.scope as HypScope) ? (sp.scope as HypScope) : null;
  const [bundles, sites] = await Promise.all([
    db.bundle.findMany({ orderBy: { title: "asc" }, include: { sites: true } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" }, include: { bundles: true } }),
  ]);
  const bundle = bundles.find((b) => b.slug === sp.bundle) ?? null;
  const filter = { bundleSiteIds: bundle ? bundle.sites.map((s) => s.siteId) : null, bundleId: bundle?.id ?? null };
  const [list, counts] = await Promise.all([hypothesesList({ tab, scope, ...filter }), hypothesisCounts(filter)]);
  const tabStatuses: Record<HypothesisTab, string[]> = { proposed: ["PROPOSED"], accepted: ["ACCEPTED"], done: ["DONE", "REJECTED"], all: ["PROPOSED", "ACCEPTED", "DONE", "REJECTED"] };
  const scopeCount = (s: HypScope) => counts.scopes.filter((x) => x.scope === s && tabStatuses[tab].includes(x.status)).reduce((a, x) => a + x._count._all, 0);
  const impact = list.reduce((a, h) => a + Math.max(0, Number(h.impactMonth ?? 0)), 0);
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) q.set(k, v);
    return `/hypotheses${q.size ? `?${q}` : ""}`;
  };
  const chip = (active: boolean) => cn("rounded-full border px-3 py-1 text-sm", active ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover");
  const tag = "rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted";
  const SUB: Record<HypothesisTab, string> = {
    proposed: "Собираются каждую ночь из правил по дневной аналитике (бандлы, сайты, гео, сетки, форматы, источники, дилы) и из алертов. Сначала критичные, затем по ожидаемому эффекту в месяц",
    accepted: "Принятые: базовое значение метрики зафиксировано за 14 дней до принятия. «Завершить» измерит её снова и покажет дельту",
    done: "Проверенные и отклонённые — история, что пробовали и что вышло",
    all: "Все, кроме неактуальных",
  };

  return (
    <>
      <PageHeader title="Гипотезы" sub={`Что могло бы заработать больше или перестать терять — по бандлам, сайтам, гео, зонам, сеткам, форматам, дилам и источникам. Система предлагает, человек принимает, делает и проверяет · ${list.length} ${list.length === 1 ? "гипотеза" : list.length < 5 ? "гипотезы" : "гипотез"}${impact ? ` · эффект до ${fmtMoney(impact)}/мес` : ""}`}
        actions={<NewHypothesisButton bundles={bundles.map((b) => ({ id: b.id, title: b.title }))} sites={sites.map((s) => ({ id: s.id, domain: s.domain, bundleIds: s.bundles.map((b) => b.bundleId) }))} formats={Object.keys(FORMAT_LABEL)} />} />
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map((t) => <Link key={t} href={href({ tab: t, scope: undefined })} className={chip(tab === t)} data-tab={t}>{TAB_LABEL[t]} <span className="text-faint">{counts.tabs[t]}</span></Link>)}
        <span className="mx-1 text-faint">|</span>
        <Link href={href({ bundle: undefined })} className={chip(!bundle)}>Все бандлы</Link>
        {bundles.map((b) => <Link key={b.slug} href={href({ bundle: b.slug })} className={chip(bundle?.slug === b.slug)}>{b.title}</Link>)}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={href({ scope: undefined })} className={chip(!scope)}>Все разрезы</Link>
        {SCOPES.map((s) => scopeCount(s) > 0 && <Link key={s} href={href({ scope: s })} className={chip(scope === s)}>{SCOPE_LABEL[s]} <span className="text-faint">{scopeCount(s)}</span></Link>)}
      </div>
      <Section title={scope ? `${TAB_LABEL[tab]} · ${SCOPE_LABEL[scope]}` : TAB_LABEL[tab]} sub={SUB[tab]}>
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted"><FlaskConical className="size-6 text-faint" />
            {tab === "proposed" ? "Предложений нет — всё в порядке или данных пока мало. Свою гипотезу можно добавить кнопкой выше" : "Пока пусто"}</div>
        ) : (
          <ul className="-mx-5 divide-y divide-border/60">{list.map((h) => {
            const metric = h.metric as Metric | null;
            const base = h.baseline == null ? null : Number(h.baseline), res = h.result == null ? null : Number(h.result);
            const delta = base != null && res != null && base !== 0 ? (res - base) / Math.abs(base) : null;
            const better = delta != null && (metric === "cost_per_1k" || metric === "cost_share" ? delta < 0 : delta > 0);
            return (
              <li key={h.id} className="flex gap-3 px-5 py-3 hover:bg-surface-hover" data-scope={h.scope} data-status={h.status}>
                <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", LEVEL[h.level])}><FlaskConical className="size-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={h.link} className="text-sm font-medium hover:text-accent">{h.title}</Link>
                    <span className={tag}>{SCOPE_LABEL[h.scope as HypScope] ?? h.scope}</span>
                    <span className={tag}>{SOURCE_LABEL[h.source]}</span>
                    {tab === "all" && <span className={tag}>{STATUS_LABEL[h.status]}</span>}
                    {h.bundle && <span className={tag}>{h.bundle.title}</span>}
                    {h.format && <span className={tag}>{FORMAT_LABEL[h.format] ?? h.format}</span>}
                    {h.countryCode && <span className={tag}>{h.countryCode}</span>}
                  </div>
                  <p className="mt-1 text-sm">{h.hypothesis}</p>
                  <p className="mt-1 text-xs text-faint">
                    {h.source === "MANUAL" ? `добавлена ${fmtDate(h.createdAt)}` : `замечена ${fmtDate(h.firstSeenAt)} · данные на ${fmtDate(h.lastSeenAt)}`}
                    {metric && <> · метрика: {METRIC_LABEL[metric]}</>}
                    {h.acceptedAt && <> · в работе с {fmtDate(h.acceptedAt)}{base != null && <>, база {fmtMetric(metric, base)}</>}</>}
                    {h.status === "DONE" && <> · итог {fmtMetric(metric, res)}{delta != null && <span className={better ? "text-positive" : "text-negative"}> ({delta > 0 ? "+" : ""}{(delta * 100).toFixed(0)}%)</span>}{h.status === "DONE" && res == null && " (мало данных)"}</>}
                  </p>
                  {h.resultNote && <p className="mt-1 text-xs text-muted">{h.resultNote}</p>}
                </div>
                <div className="num shrink-0 text-right text-sm">{Number(h.impactMonth ?? 0) > 0 ? <><div className="font-medium">{fmtMoney(Number(h.impactMonth))}</div><div className="text-[11px] text-faint">в месяц</div></> : <span className="text-faint">—</span>}</div>
                <HypothesisActions id={h.id} status={h.status} />
              </li>
            );
          })}</ul>
        )}
      </Section>
    </>
  );
}
