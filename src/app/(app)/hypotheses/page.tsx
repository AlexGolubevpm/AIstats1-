import Link from "next/link";
import { FlaskConical } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { Section } from "@/components/ui/card";
import { fmtDate, fmtMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import { db } from "@/server/db";
import { METRIC_LABEL, OWN_STATUS_LABEL, SCOPE_LABEL, SOURCE_LABEL, STATUS_LABEL, evidenceLine, type HypScope, type Metric, type OwnStatus } from "@/server/domain/hypotheses";
import { HYPOTHESES_PAGE, KIND_LABEL, KIND_TABS, TAB_LABEL, hypothesesList, hypothesisCounts, kindOf, topSiteIds, type HypothesisKind, type HypothesisTab } from "@/server/queries/hypotheses";
import { HypothesisActions, NewHypothesisButton, OwnStatusSwitch } from "./client";
import { fmtMetric, metricDelta } from "./format";

const SCOPES = Object.keys(SCOPE_LABEL) as HypScope[];
const TABS = Object.keys(TAB_LABEL) as HypothesisTab[];
const KINDS = Object.keys(KIND_TABS) as HypothesisKind[];
/** Where each kind opens: the system list on fresh proposals, ours on all of them with the status on every card. */
const KIND_HOME: Record<HypothesisKind, HypothesisTab> = { system: "proposed", own: "mine" };
const LEVEL: Record<string, string> = { CRITICAL: "bg-negative-soft text-negative", WARNING: "bg-warning-soft text-warning", INFO: "bg-accent-soft text-accent" };


export default async function Hypotheses({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const tab: HypothesisTab = TABS.includes(sp.tab as HypothesisTab) ? (sp.tab as HypothesisTab) : KINDS.includes(sp.kind as HypothesisKind) ? KIND_HOME[sp.kind as HypothesisKind] : "proposed";
  const kind = kindOf(tab);
  const scope = SCOPES.includes(sp.scope as HypScope) ? (sp.scope as HypScope) : null;
  const [bundles, sites] = await Promise.all([
    db.bundle.findMany({ orderBy: { title: "asc" }, include: { sites: true } }),
    db.site.findMany({ where: { status: { not: "ARCHIVED" } }, orderBy: { domain: "asc" }, include: { bundles: true } }),
  ]);
  const bundle = bundles.find((b) => b.slug === sp.bundle) ?? null;
  // `?site=domain` — one site (the site page link); `?top=10` — the week's top earners; `?group=site` — the list by site.
  const site = sp.site ? sites.find((s) => s.domain === sp.site) ?? null : null;
  const top = sp.top === "10";
  const group = sp.group === "site";
  const topIds = top ? await topSiteIds(10) : null;
  const filter = { bundleSiteIds: bundle ? bundle.sites.map((s) => s.siteId) : null, bundleId: bundle?.id ?? null, siteId: site?.id ?? null, siteIds: topIds };
  const pageNo = Math.max(1, Number(sp.page) || 1);
  const [list, counts] = await Promise.all([hypothesesList({ tab, scope, ...filter, page: pageNo }), hypothesisCounts(filter)]);
  const domainOf = new Map(sites.map((s) => [s.id, s.domain]));
  // Groups by site keep the page's order (critical first, then by effect): a site's block sits where its strongest hypothesis is.
  type Row = (typeof list)[number];
  const groups: [string, Row[]][] = group
    ? [...list.reduce((m, h) => { const k = h.siteId ?? ""; return m.set(k, [...(m.get(k) ?? []), h]); }, new Map<string, Row[]>())]
    : [["", [...list]]];
  const tabStatuses: Record<HypothesisTab, string[]> = {
    proposed: ["PROPOSED"], accepted: ["ACCEPTED"], done: ["DONE", "REJECTED"], all: ["PROPOSED", "ACCEPTED", "DONE", "REJECTED"],
    test: ["TESTING"], work: ["ACCEPTED"], ready: ["DONE"], rejected: ["REJECTED"], mine: ["TESTING", "ACCEPTED", "DONE", "REJECTED"],
  };
  const ofKind = (source: string) => (kind === "own") === (source === "MANUAL");
  const scopeCount = (s: HypScope) => counts.scopes.filter((x) => x.scope === s && ofKind(x.source) && tabStatuses[tab].includes(x.status)).reduce((a, x) => a + x._count._all, 0);
  const impact = list.reduce((a, h) => a + Math.max(0, Number(h.impactMonth ?? 0)), 0);
  const shown = list.total;
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) q.set(k, v);
    return `/hypotheses${q.size ? `?${q}` : ""}`;
  };
  const pageHref = (n: number) => href({ page: n > 1 ? String(n) : undefined });
  const chip = (active: boolean) => cn("rounded-full border px-3 py-1 text-sm", active ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover");
  const tag = "rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted";
  const SUB: Record<HypothesisTab, string> = {
    proposed: "Собираются каждую ночь из правил по дневной аналитике (бандлы, сайты, гео, сетки, форматы, источники, дилы) и из алертов. Сначала критичные, затем по ожидаемому эффекту в месяц",
    accepted: "Принятые: базовое значение метрики зафиксировано за 14 дней до принятия. «Завершить» измерит её снова и покажет дельту",
    done: "Проверенные и отклонённые — история, что пробовали и что вышло",
    all: "Все предложения системы, кроме неактуальных",
    test: "Наши гипотезы на тесте. База метрики — 14 дней до добавления; «Готово» измерит её снова и покажет дельту",
    work: "Наши гипотезы в работе",
    ready: "Наши готовые гипотезы с итогом по метрике",
    rejected: "Наши гипотезы, от которых отказались",
    mine: "Все наши гипотезы. Статус меняется прямо в карточке: Тест · В работе · Готово · Отклонена",
  };

  return (
    <>
      <PageHeader title="Гипотезы" sub={`Что могло бы заработать больше или перестать терять — по бандлам, сайтам, гео, зонам, сеткам, форматам, дилам и источникам. Система предлагает, человек принимает, делает и проверяет · ${shown} ${shown === 1 ? "гипотеза" : shown < 5 ? "гипотезы" : "гипотез"}${impact ? ` · эффект на странице до ${fmtMoney(impact)}/мес` : ""}`}
        actions={<NewHypothesisButton bundles={bundles.map((b) => ({ id: b.id, title: b.title }))} sites={sites.map((s) => ({ id: s.id, domain: s.domain, bundleIds: s.bundles.map((b) => b.bundleId) }))} formats={Object.keys(FORMAT_LABEL)} />} />
      <nav className="flex flex-wrap gap-1 border-b border-border" aria-label="Чьи гипотезы">
        {KINDS.map((k) => (
          <Link key={k} href={href({ tab: KIND_HOME[k], kind: undefined, scope: undefined, page: undefined })} data-kind={k}
            className={cn("-mb-px border-b-2 px-3 py-2 text-sm font-medium", kind === k ? "border-accent text-accent" : "border-transparent text-muted hover:text-text")}>
            {KIND_LABEL[k]} <span className="text-faint">{counts.tabs[KIND_HOME[k]]}</span>
          </Link>
        ))}
      </nav>
      <div className="flex flex-wrap items-center gap-2">
        {KIND_TABS[kind].map((t) => <Link key={t} href={href({ tab: t, kind: undefined, scope: undefined, page: undefined })} className={chip(tab === t)} data-tab={t}>{TAB_LABEL[t]} <span className="text-faint">{counts.tabs[t]}</span></Link>)}
        <span className="mx-1 text-faint">|</span>
        <Link href={href({ bundle: undefined })} className={chip(!bundle)}>Все бандлы</Link>
        {bundles.map((b) => <Link key={b.slug} href={href({ bundle: b.slug })} className={chip(bundle?.slug === b.slug)}>{b.title}</Link>)}
        <span className="mx-1 text-faint">|</span>
        <Link href={href({ top: top ? undefined : "10", site: undefined, page: undefined })} className={chip(top)} title="Сайты с наибольшей выручкой за 7 дней" data-chip="top">Топ-10 сайтов</Link>
        {site && <Link href={href({ site: undefined, page: undefined })} className={chip(true)} data-chip="site">{site.domain} ×</Link>}
        <Link href={href({ group: group ? undefined : "site" })} className={chip(group)} data-chip="group">По сайтам</Link>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Link href={href({ scope: undefined, page: undefined })} className={chip(!scope)}>Все разрезы</Link>
        {SCOPES.map((s) => scopeCount(s) > 0 && <Link key={s} href={href({ scope: s, page: undefined })} className={chip(scope === s)}>{SCOPE_LABEL[s]} <span className="text-faint">{scopeCount(s)}</span></Link>)}
      </div>
      <Section title={[KIND_LABEL[kind], TAB_LABEL[tab], scope && SCOPE_LABEL[scope], site?.domain, top && "топ-10 сайтов"].filter(Boolean).join(" · ")} sub={SUB[tab]}>
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted"><FlaskConical className="size-6 text-faint" />
            {tab === "proposed" ? "Предложений нет — всё в порядке или данных пока мало. Свою гипотезу можно добавить кнопкой выше" : kind === "own" ? "Своих гипотез здесь нет — добавьте кнопкой «Новая гипотеза»" : "Пока пусто"}</div>
        ) : groups.map(([siteKey, items]) => (
          <div key={siteKey || "_"} className="-mx-5 border-t border-border/60 first:border-0">
          {group && <h3 className="bg-surface-2/60 px-5 py-1.5 text-xs font-medium text-muted" data-group={siteKey || "network"}>{siteKey ? <Link href={`/sites/${domainOf.get(siteKey) ?? siteKey}`} className="hover:text-accent">{domainOf.get(siteKey) ?? siteKey}</Link> : "Сеть, бандлы и система"} <span className="text-faint">{items.length}</span></h3>}
          <ul className="divide-y divide-border/60">{items.map((h) => {
            const metric = h.metric as Metric | null;
            const base = h.baseline == null ? null : Number(h.baseline), res = h.result == null ? null : Number(h.result);
            const { delta, better } = metricDelta(metric, base, res);
            return (
              <li key={h.id} className="flex flex-col gap-3 px-5 py-3 transition-colors hover:bg-surface-hover sm:flex-row" data-scope={h.scope} data-status={h.status}>
                <div className="flex min-w-0 flex-1 gap-3">
                <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", LEVEL[h.level])}><FlaskConical className="size-3.5" /></span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link href={`/hypotheses/${h.id}`} className="text-sm font-medium hover:text-accent" data-open>{h.title}</Link>
                    <span className={tag}>{SCOPE_LABEL[h.scope as HypScope] ?? h.scope}</span>
                    <span className={tag}>{SOURCE_LABEL[h.source]}</span>
                    {h.source === "MANUAL" ? <span className={tag} data-own-status={h.status}>{OWN_STATUS_LABEL[h.status as OwnStatus] ?? STATUS_LABEL[h.status]}</span> : tab === "all" && <span className={tag}>{STATUS_LABEL[h.status]}</span>}
                    {h.bundle && <span className={tag}>{h.bundle.title}</span>}
                    {h.format && <span className={tag}>{FORMAT_LABEL[h.format] ?? h.format}</span>}
                    {h.countryCode && <span className={tag}>{h.countryCode}{typeof (h.evidence as Record<string, unknown> | null)?.tier === "number" ? ` · T${(h.evidence as Record<string, unknown>).tier}` : ""}</span>}
                  </div>
                  <p className="mt-1 text-sm">{h.hypothesis}</p>
                  {(() => { const line = h.ruleKey ? evidenceLine(h.ruleKey, h.evidence) : null; return line ? <p className="num mt-1 text-xs text-muted" data-evidence>{line}</p> : null; })()}
                  <p className="mt-1 text-xs text-faint">
                    {h.source === "MANUAL" ? `добавлена ${fmtDate(h.createdAt)}` : `замечена ${fmtDate(h.firstSeenAt)} · данные на ${fmtDate(h.lastSeenAt)}`}
                    {metric && <> · метрика: {METRIC_LABEL[metric]}</>}
                    {h.link !== "/hypotheses" && <> · <Link href={h.link} className="hover:text-accent">к объекту →</Link></>}
                    {h.acceptedAt && <> · {h.source === "MANUAL" ? "старт" : "в работе с"} {fmtDate(h.acceptedAt)}{base != null && <>, база {fmtMetric(metric, base)}</>}</>}
                    {h.status === "DONE" && <> · итог {fmtMetric(metric, res)}{delta != null && <span className={better ? "text-positive" : "text-negative"}> ({delta > 0 ? "+" : ""}{(delta * 100).toFixed(0)}%)</span>}{h.status === "DONE" && res == null && " (мало данных)"}</>}
                  </p>
                  {h.resultNote && <p className="mt-1 text-xs text-muted">{h.resultNote}</p>}
                </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:flex-col sm:items-end sm:justify-start">
                  <div className="num shrink-0 text-right text-sm">{Number(h.impactMonth ?? 0) > 0 ? <><span className="font-medium">{fmtMoney(Number(h.impactMonth))}</span><span className="ml-1 text-[11px] text-faint">{(h.evidence as Record<string, unknown> | null)?.debt ? "долг" : "в месяц"}</span></> : <span className="text-faint">—</span>}</div>
                  {h.source === "MANUAL" ? <OwnStatusSwitch id={h.id} status={h.status} /> : <HypothesisActions id={h.id} status={h.status} />}
                </div>
              </li>
            );
          })}</ul>
          </div>
        ))}
        {list.pages > 1 && (
          <nav className="mt-3 flex items-center justify-between border-t border-border pt-3 text-sm" aria-label="Страницы">
            <span className="text-muted">{(list.page - 1) * HYPOTHESES_PAGE + 1}–{Math.min(list.total, list.page * HYPOTHESES_PAGE)} из {list.total}</span>
            <span className="flex gap-1">
              {list.page > 1 && <Link href={pageHref(list.page - 1)} className="rounded-md border border-border px-3 py-1 hover:bg-surface-hover">← Назад</Link>}
              {list.page < list.pages && <Link href={pageHref(list.page + 1)} className="rounded-md border border-border px-3 py-1 hover:bg-surface-hover">Дальше →</Link>}
            </span>
          </nav>
        )}
      </Section>
    </>
  );
}
