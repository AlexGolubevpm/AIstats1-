// «Окупаемость закупки» (ADR 0023): pick a site, formats and tiers — what the bought traffic earns per
// 1000 loads, what it costs per 1000 loads, and whether the bid may go up.
import { DataTable } from "@/components/data/data-table";
import { KpiCard } from "@/components/data/kpi-card";
import type { Column } from "@/components/data/format-cell";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { fmtCpm, fmtPercent } from "@/lib/format";
import { FORMAT_LABEL } from "@/lib/labels";
import { periodFromParams } from "@/lib/period";
import { buyingSites, buyingView } from "@/server/queries/buying";
import { ALL_FORMATS } from "@/server/services/buying";
import { Bids, BuyingControls, CheckFilters, ComputeSlice } from "./client";

const DEFAULT_SITE = "hentaismile.com";

const VERDICT: Record<string, { text: string; tone: string; short: string }> = {
  raise: { text: "Ставку можно поднимать", tone: "border-positive/50 bg-positive/10", short: "можно поднимать" },
  edge: { text: "На грани: поднимать некуда", tone: "border-warning/50 bg-warning-soft", short: "на грани" },
  hold: { text: "Не поднимать: доход не окупает текущую цену", tone: "border-negative/50 bg-negative/10", short: "не поднимать" },
  no_data: { text: "Недостаточно данных", tone: "border-border", short: "нет данных" },
};
const COST_KIND = { bid: "бид", revshare: "ревшара", mixed: "бид + ревшара", free: "бесплатный" };

const TIER_COLS: Column[] = [
  { id: "label", header: "Тир", kind: "text" }, { id: "loads", header: "Загрузки источника", kind: "int" }, { id: "revenue", header: "Доход", kind: "money" },
  { id: "revPer1k", header: "Доход / 1000", kind: "cpm" }, { id: "costPer1k", header: "Расход / 1000", kind: "cpm" }, { id: "marginPer1k", header: "Маржа / 1000", kind: "cpm", heat: "sign" },
  { id: "maxBid", header: "Предел / 1000 загрузок", kind: "cpm" }, { id: "bidLabel", header: "Ставка → предел", kind: "text" }, { id: "verdictLabel", header: "Ставка", kind: "text" },
  { id: "revPer1kUsers", header: "Доход / 1000 юзеров", kind: "cpm", tooltip: "Весь трафик тира, выбранные форматы, уники Метрики; без Метрики — пусто" }, { id: "src", header: "Данные", kind: "text" },
];
const CC_COLS: Column[] = [
  { id: "country", header: "Страна", kind: "country" }, { id: "tierLabel", header: "Тир", kind: "text" }, { id: "loads", header: "Загрузки", kind: "int" },
  { id: "revenue", header: "Доход", kind: "money" }, { id: "revPer1k", header: "Доход / 1000", kind: "cpm" }, { id: "allPer1k", header: "Все форматы / 1000", kind: "cpm" },
  { id: "vsCost", header: "Доход − расход, / 1000", kind: "cpm", heat: "sign" },
];

export default async function Buying({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const p = periodFromParams(sp, "30d");
  const margin = Math.min(90, Math.max(0, Number(sp.margin ?? 20) || 0));
  const tiers = (sp.tiers ?? "1,2").split(",").map(Number).filter((t) => t >= 1 && t <= 5);
  const formats = sp.fmt ? sp.fmt.split(",").filter((f) => (ALL_FORMATS as readonly string[]).includes(f)) : null;
  const sites = await buyingSites();
  const site = sites.find((s) => s.domain === sp.site) ?? sites.find((s) => s.domain === DEFAULT_SITE) ?? sites[0];
  if (!site) return <PageHeader title="Окупаемость закупки" sub="Нет сайтов" />;
  const source = sp.src ?? "paid";
  const r = await buyingView(site.id, p, { formats: formats?.length ? formats : null, tiers: tiers.length ? tiers : [1, 2], source, margin: margin / 100 });
  const a = r.advice, v = VERDICT[a.verdict];
  const fmtText = r.sel.formats ? r.sel.formats.map((f) => FORMAT_LABEL[f] ?? f).join(" + ") : "все форматы";
  const tierText = r.sel.tiers.map((t) => `T${t}`).join(" + ");
  const srcTitle = source === "paid" ? "платных источников" : r.allSources.find((s) => s.slug === source)?.title ?? source;
  return (
    <>
      <PageHeader title="Окупаемость закупки" sub="Формат → тиры → доход и расход на 1000 загрузок купленного трафика → можно ли поднимать ставку" period={p} />
      <BuyingControls sites={sites} site={site.domain} sources={r.allSources} source={source} formats={r.sel.formats} tiers={r.sel.tiers} margin={margin}
        formatOptions={ALL_FORMATS.map((f) => ({ id: f, label: FORMAT_LABEL[f] ?? f }))} />
      <div className={`card flex flex-col gap-1 p-4 ${v.tone}`} data-testid="buying-verdict">
        <div className="text-lg font-semibold">{v.text}</div>
        <div className="text-sm text-muted" data-testid="buying-scope">{site.domain} · трафик {srcTitle} · {fmtText} · {tierText}</div>
        {a.verdict !== "no_data" && (
          <div className="text-sm">
            1000 загрузок этого трафика приносят <b>{fmtCpm(a.popPer1k)}</b> и стоят <b>{fmtCpm(a.costPer1k)}</b>.
            {" "}С целевой маржой {margin}% предел — <b data-testid="buying-maxbid">{fmtCpm(a.maxBid)}</b> за 1000 загрузок
            {a.headroom != null && <> ({a.headroom >= 0 ? "+" : "−"}{fmtPercent(Math.abs(a.headroom))} к текущей цене)</>}.
            {r.sel.formats && <> Все форматы вместе дают {fmtCpm(a.allPer1k)}.</>}
          </div>
        )}
        {a.verdict === "no_data" && <div className="text-sm">Нет загрузок или расхода у выбранного источника в этих тирах. Задайте ставку ниже или выберите другой источник.</div>}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <ComputeSlice sel={r.sel} cached={r.slice.cached} />
          <span className={r.slice.exact && r.slice.fmtExact ? "text-xs text-muted" : "text-xs text-warning"} data-testid="buying-estimate">
            {r.slice.cached
              ? `${r.slice.exact && r.slice.fmtExact ? "Точно" : "Частично оценка"}: посчитано в ADOK ${r.slice.computedAt?.slice(0, 10)} (${r.slice.requests} запр.)${r.slice.notes.length ? ` · ${r.slice.notes.join("; ")}` : ""}`
              : "Оценка: трафик источника разложен по тирам и форматам как у сайта в среднем. Точный расчёт — кнопкой, до 12 запросов к ADOK"}
          </span>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Доход / 1000 загрузок" value={a.popPer1k} format="moneyPrecise" sub={`$${r.total.popRevenue.toFixed(0)} за период`} />
        <KpiCard label="Расход / 1000 загрузок" value={a.costPer1k} format="moneyPrecise" sub={`${Math.round(r.total.loads).toLocaleString("ru-RU")} загрузок · $${r.total.cost.toFixed(0)}`} />
        <KpiCard label="Маржа / 1000 загрузок" value={a.popMarginPer1k} format="moneyPrecise" />
        <KpiCard label={`Предел ставки (маржа ${margin}%)`} value={a.maxBid} format="moneyPrecise" color="#16A34A" sub="за 1000 загрузок" />
      </div>
      <Section title="По тирам" sub="Каждый выбранный тир отдельно: где ставку можно поднять, а где она уже выше дохода">
        <DataTable id="buying-tiers" exportName="buying-tiers" defaultSort={{ id: "label", dir: "asc" }} columns={TIER_COLS}
          rows={r.tiers.map((t) => ({ ...t, _key: String(t.tier), label: `T${t.tier}`, verdictLabel: VERDICT[t.verdict].short + (t.headroom != null && t.verdict !== "no_data" ? ` (${t.headroom >= 0 ? "+" : "−"}${fmtPercent(Math.abs(t.headroom))})` : ""),
            bidLabel: t.bid != null ? `$${t.bid.toFixed(2)} → $${(t.maxCpm ?? 0).toFixed(2)} за 1000 визитов` : COST_KIND[t.costKind],
            src: t.exact ? "ADOK" : "оценка" }))} />
      </Section>
      <Section title="Страны выбранных тиров" sub="Доход выбранных форматов со всего трафика страны против среднего расхода на 1000 — где поднимать, а где резать">
        <DataTable id="buying-cc" exportName="buying-countries" defaultSort={{ id: "loads", dir: "desc" }} columns={CC_COLS}
          rows={r.countries.map((c) => ({ ...c, _key: c.country, tierLabel: `T${c.tier}`, vsCost: c.revPer1k != null && a.costPer1k != null ? c.revPer1k - a.costPer1k : null }))} />
      </Section>
      <Section title="Ставки источников" sub="Бид CPM по тирам: в ADOK его нет, поэтому задаётся здесь. Берётся ставка, действующая на конец периода; своя для сайта важнее общей">
        <Bids bids={r.bids} sources={r.allSources} siteId={site.id} site={site.domain} source={source} today={new Date().toISOString().slice(0, 10)} />
      </Section>
      <Section title="Фильтры ADOK" sub="Точный расчёт — это отчёт ADOK по источникам с фильтрами по странам тира и по зонам формата. Проверка подбирает имена фильтров на одном дне этого сайта (≈12 запросов)">
        <div className="grid gap-3 text-sm sm:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-1" data-testid="buying-filters">
            <span>По форматам (зоны): {r.filters.spots ? <b className="font-mono">{r.filters.spots.param}</b> : <span className="text-muted">фильтр не найден</span>}</span>
            <span>По тирам (страны): {r.filters.countries ? <b className="font-mono">{r.filters.countries.param}</b> : <span className="text-muted">фильтр не найден</span>}</span>
            {r.filters.checkedAt && <span className="text-xs text-muted">проверено {r.filters.checkedAt.slice(0, 10)} на {r.filters.site} за {r.filters.day}</span>}
          </div>
          <CheckFilters siteId={site.id} />
        </div>
      </Section>
    </>
  );
}
