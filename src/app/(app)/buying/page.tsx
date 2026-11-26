// «Окупаемость закупки» (ADR 0023): which tiers, by which formats, on which sites earned how much
// and what their traffic cost over the period. One tree: site → tier → format.
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { FORMAT_LABEL } from "@/lib/labels";
import { periodFromParams } from "@/lib/period";
import { buyingSites, buyingTable } from "@/server/queries/buying";
import { ALL_FORMATS, TIER_LIST } from "@/server/services/buying";
import { Bids, BuyingFilters, BuyingTree, CheckFilters, ComputeAll } from "./client";

const CHECK_SITE = "hentaismile.com";

export default async function Buying({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const p = periodFromParams(sp, "30d");
  const picked = (sp.tiers ?? "").split(",").map(Number).filter((t) => TIER_LIST.includes(t));
  const tiers = picked.length ? picked : TIER_LIST;
  const fmt = sp.fmt ? sp.fmt.split(",").filter((f) => (ALL_FORMATS as readonly string[]).includes(f)) : [];
  const formats = fmt.length ? fmt : null;
  const sites = await buyingSites();
  const site = sites.find((s) => s.domain === sp.site) ?? null;
  const r = await buyingTable(p, { siteIds: site ? [site.id] : null, tiers, formats });
  const checkSite = site ?? sites.find((s) => s.domain === CHECK_SITE) ?? sites[0];
  return (
    <>
      <PageHeader title="Окупаемость закупки" sub="Какие тиры по каким форматам на каких сайтах сколько принесли и сколько на их трафик потратили" period={p} />
      <BuyingFilters sites={sites} site={site?.domain ?? null} formats={formats} tiers={tiers} formatOptions={ALL_FORMATS.map((f) => ({ id: f, label: FORMAT_LABEL[f] ?? f }))} />
      <Section title="Доход и расход" actions={<ComputeAll period={{ from: p.from, to: p.to }} done={r.computed.done} of={r.computed.of} />}
        sub="Доход — выручка AdSpyglass. Расход — что заплатили источникам за трафик тира (по форматам не делится: платим за трафик, а не за формат). CPM — доход на 1000 показов. «Оценка» — формат и расход разложены по тирам как у сайта в среднем; «Посчитать точно» берёт их из ADOK">
        <BuyingTree key={`${site?.id ?? "all"}|${tiers.join()}|${formats?.join() ?? ""}`} period={{ from: p.from, to: p.to }} total={r.total}
          rows={r.rows.map((s) => ({ ...s, tiers: s.tiers.map((t) => ({ ...t, formats: t.formats.map((f) => ({ ...f, label: FORMAT_LABEL[f.format] ?? f.format })) })) }))} />
      </Section>
      <details className="card p-5" data-testid="buying-bids-block">
        <summary className="cursor-pointer text-sm font-medium">Ставки источников трафика ({r.bids.length}) — из них считается расход</summary>
        <p className="mt-2 mb-4 text-xs text-muted">Бид CPM по источнику и тиру: в ADOK его нет, поэтому задаётся здесь. Берётся ставка, действующая на конец периода; ставка сайта важнее общей. Источник без ставки считается по ревшаре.</p>
        <Bids bids={r.bids} sources={r.allSources} sites={sites} site={site?.domain ?? null} today={new Date().toISOString().slice(0, 10)} />
      </details>
      <details className="card p-5" data-testid="buying-filters-block">
        <summary className="cursor-pointer text-sm font-medium">Фильтры ADOK для точного расчёта — {r.filters.spots || r.filters.countries ? "найдены" : "не найдены"}</summary>
        <p className="mt-2 mb-4 text-xs text-muted">Точный расчёт — отчёты ADOK с фильтрами по зонам формата и по странам тира. Проверка подбирает имена фильтров на одном дне сайта {checkSite?.domain} (≈12 запросов).</p>
        <div className="grid gap-3 text-sm sm:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-1" data-testid="buying-filters">
            <span>По форматам (зоны): {r.filters.spots ? <b className="font-mono">{r.filters.spots.param}</b> : <span className="text-muted">фильтр не найден</span>}</span>
            <span>По тирам (страны): {r.filters.countries ? <b className="font-mono">{r.filters.countries.param}</b> : <span className="text-muted">фильтр не найден</span>}</span>
            {r.filters.checkedAt && <span className="text-xs text-muted">проверено {r.filters.checkedAt.slice(0, 10)} на {r.filters.site} за {r.filters.day}</span>}
          </div>
          {checkSite && <CheckFilters siteId={checkSite.id} />}
        </div>
      </details>
    </>
  );
}
