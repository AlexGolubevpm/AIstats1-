import Link from "next/link";
import { Lightbulb } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { fmtMoney } from "@/lib/format";
import { cn } from "@/lib/cn";
import { db } from "@/server/db";
import { SCOPE_LABEL, type RecScope } from "@/server/domain/recommendations";
import { recommendations } from "@/server/queries/recommendations";

const SCOPES = Object.keys(SCOPE_LABEL) as RecScope[];

export default async function Recommendations({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const scope = SCOPES.includes(sp.scope as RecScope) ? (sp.scope as RecScope) : null;
  const [all, bundles] = await Promise.all([recommendations(), db.bundle.findMany({ orderBy: { title: "asc" }, include: { sites: true } })]);
  const bundle = bundles.find((b) => b.slug === sp.bundle);
  const inBundle = bundle ? new Set(bundle.sites.map((s) => s.siteId)) : null;
  const list = all.filter((r) => (!scope || r.scope === scope) && (!inBundle || (r.site && inBundle.has(r.site.id))));
  const counts = Object.fromEntries(SCOPES.map((s) => [s, all.filter((r) => r.scope === s && (!inBundle || (r.site && inBundle.has(r.site.id)))).length]));
  const impact = list.reduce((a, r) => a + Math.max(0, r.impact), 0);
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) q.set(k, v);
    return `/recommendations${q.size ? `?${q}` : ""}`;
  };
  const chip = (active: boolean) => cn("rounded-full border px-3 py-1 text-sm", active ? "border-accent bg-accent-soft text-accent" : "border-border text-muted hover:bg-surface-hover");
  const LEVEL: Record<string, string> = { CRITICAL: "bg-negative-soft text-negative", WARNING: "bg-warning-soft text-warning", INFO: "bg-accent-soft text-accent" };

  return (
    <>
      <PageHeader title="Рекомендации" sub={`Что сделать по сайтам, зонам, гео, сеткам, дилам и источникам. Система рекомендует, руками ставит человек · ${list.length} ${list.length === 1 ? "пункт" : list.length < 5 ? "пункта" : "пунктов"}${impact ? ` · под риском ${fmtMoney(impact)}` : ""}`} />
      <div className="flex flex-wrap items-center gap-2">
        <Link href={href({ scope: undefined })} className={chip(!scope)}>Все <span className="text-faint">{all.filter((r) => !inBundle || (r.site && inBundle.has(r.site.id))).length}</span></Link>
        {SCOPES.map((s) => counts[s] > 0 && <Link key={s} href={href({ scope: s })} className={chip(scope === s)}>{SCOPE_LABEL[s]} <span className="text-faint">{counts[s]}</span></Link>)}
        <span className="mx-1 text-faint">|</span>
        <Link href={href({ bundle: undefined })} className={chip(!bundle)}>Все бандлы</Link>
        {bundles.map((b) => <Link key={b.slug} href={href({ bundle: b.slug })} className={chip(bundle?.slug === b.slug)}>{b.title}</Link>)}
      </div>
      <Section title={scope ? SCOPE_LABEL[scope] : "Все рекомендации"} sub="Сначала критичные, затем по сумме под риском. Алерты (ночные правила) и рекомендации из таблиц за 7 и 30 дней">
        {list.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted"><Lightbulb className="size-6 text-faint" />Рекомендаций нет — всё в порядке или данных пока мало</div>
        ) : (
          <ul className="-mx-5 divide-y divide-border/60">{list.map((r) => (
            <li key={r.id} className="flex gap-3 px-5 py-3 hover:bg-surface-hover" data-scope={r.scope}>
              <span className={cn("mt-0.5 grid size-7 shrink-0 place-items-center rounded-full", LEVEL[r.level])}><Lightbulb className="size-3.5" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={r.link} className="text-sm font-medium hover:text-accent">{r.title}</Link>
                  <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{SCOPE_LABEL[r.scope]}</span>
                  {r.source === "alert" && <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">алерт</span>}
                </div>
                {r.why && <p className="mt-0.5 text-xs text-muted">{r.why}</p>}
                <p className="mt-1 text-sm"><span className="font-medium">Что сделать:</span> {r.action}</p>
              </div>
              <div className="num shrink-0 text-right text-sm">{r.impact > 0 ? <><div className="font-medium">{fmtMoney(r.impact)}</div><div className="text-[11px] text-faint">под риском</div></> : <span className="text-faint">—</span>}</div>
            </li>
          ))}</ul>
        )}
      </Section>
    </>
  );
}
