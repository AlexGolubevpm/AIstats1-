// «Закупка T1/T2» (ADR 0023): may the bid for T1/T2 traffic go up? Popunder revenue on T1/T2 traffic
// against the price of 1000 bought T1/T2 loads, by day, country and source.
import { DataTable } from "@/components/data/data-table";
import { KpiCard } from "@/components/data/kpi-card";
import type { Column } from "@/components/data/format-cell";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { fmtCpm, fmtPercent } from "@/lib/format";
import { periodFromParams } from "@/lib/period";
import { buyingReport, buyingSites } from "@/server/queries/buying";
import { BuyingControls, CheckFilters } from "./client";

const DEFAULT_SITE = "hentaismile.com";

const DAY_COLS: Column[] = [
  { id: "date", header: "День", kind: "mono" }, { id: "loads", header: "Загрузки T1/T2", kind: "int" }, { id: "paidLoads", header: "Из них куплено", kind: "int" },
  { id: "cost", header: "Расход T1/T2", kind: "money" }, { id: "costPer1k", header: "Цена 1000 загрузок", kind: "cpm" },
  { id: "popRevenue", header: "Попсы T1/T2", kind: "money" }, { id: "popPer1k", header: "Попсы / 1000 загрузок", kind: "cpm" },
  { id: "popMargin", header: "Попсы − цена, / 1000", kind: "cpm", heat: "sign" }, { id: "src", header: "Данные", kind: "text" },
];
const CC_COLS: Column[] = [
  { id: "country", header: "Страна", kind: "country" }, { id: "tierLabel", header: "Тир", kind: "text" }, { id: "loads", header: "Загрузки", kind: "int" },
  { id: "popRevenue", header: "Попсы", kind: "money" }, { id: "popPer1k", header: "Попсы / 1000 загрузок", kind: "cpm" },
  { id: "allPer1k", header: "Все форматы / 1000", kind: "cpm" }, { id: "vsPrice", header: "Попсы − средняя цена", kind: "cpm", heat: "sign" },
];
const SRC_COLS: Column[] = [
  { id: "title", header: "Источник", kind: "text" }, { id: "loads", header: "Загрузки T1/T2", kind: "int" }, { id: "share", header: "Доля", kind: "share" },
  { id: "cost", header: "Расход", kind: "money" }, { id: "costPer1k", header: "Цена 1000 загрузок", kind: "cpm" }, { id: "revShareLabel", header: "Ревшара", kind: "text" },
];

const VERDICT: Record<string, { text: string; tone: string }> = {
  raise: { text: "Можно поднимать бид", tone: "border-positive/50 bg-positive/10" },
  edge: { text: "На грани: бид поднимать некуда", tone: "border-warning/50 bg-warning-soft" },
  hold: { text: "Не поднимать: попсы не окупают текущую цену", tone: "border-negative/50 bg-negative/10" },
  no_data: { text: "Недостаточно данных", tone: "border-border" },
};

export default async function Buying({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const p = periodFromParams(sp, "30d");
  const margin = Math.min(90, Math.max(0, Number(sp.margin ?? 20) || 0));
  const sites = await buyingSites();
  const site = sites.find((s) => s.domain === sp.site) ?? sites.find((s) => s.domain === DEFAULT_SITE) ?? sites[0];
  if (!site) return <PageHeader title="Закупка T1/T2" sub="Нет сайтов" />;
  const r = await buyingReport(site.id, p, margin / 100);
  const a = r.advice, el = r.elasticity, v = VERDICT[a.verdict];
  const estimated = r.exact.pop < r.exact.days || r.exact.cost < r.exact.days;
  return (
    <>
      <PageHeader title="Закупка T1/T2" sub="Окупают ли попсы на T1/T2 цену закупки трафика и до какого бида можно поднимать" period={p}
        actions={<BuyingControls sites={sites} site={site.domain} margin={margin} />} />
      <div className={`card flex flex-col gap-1 p-4 ${v.tone}`} data-testid="buying-verdict">
        <div className="text-lg font-semibold">{v.text}</div>
        {a.verdict !== "no_data" && (
          <div className="text-sm">
            Сейчас 1000 загрузок T1/T2 стоят <b>{fmtCpm(a.costPer1k)}</b>, попсы приносят с них <b>{fmtCpm(a.popPer1k)}</b>.
            {" "}С целевой маржой {margin}% предел — <b data-testid="buying-maxbid">{fmtCpm(a.maxBid)}</b> за 1000 загрузок
            {a.headroom != null && <> ({a.headroom >= 0 ? "+" : ""}{fmtPercent(a.headroom)} к текущей цене)</>}.
            {" "}Все форматы вместе дают {fmtCpm(a.allPer1k)} — это запас, если баннеры на доп. трафике держат доход.
          </div>
        )}
        {el && el.priceChange != null && (
          <div className="text-sm text-muted" data-testid="buying-elasticity">
            История: в дни, когда 1000 загрузок стоили на {fmtPercent(el.priceChange)} дороже, загрузок было {el.loadsChange != null && el.loadsChange >= 0 ? "больше" : "меньше"} на {fmtPercent(Math.abs(el.loadsChange ?? 0))},
            {" "}а попсы на 1000 загрузок {el.popPer1kChange != null && el.popPer1kChange >= 0 ? "выше" : "ниже"} на {fmtPercent(Math.abs(el.popPer1kChange ?? 0))} ({el.days} дн.).
          </div>
        )}
        {estimated && (
          <div className="text-xs text-warning" data-testid="buying-estimate">
            Оценка: точные попсы по странам — {r.exact.pop} из {r.exact.days} дн., точный расход T1/T2 — {r.exact.cost} из {r.exact.days} дн.
            {" "}В остальные дни попсы — доля попсов в выручке сайта, расход — расход источников, разложенный по странам.
          </div>
        )}
      </div>
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Цена 1000 загрузок T1/T2" value={a.costPer1k} format="moneyPrecise" sub={`${r.total.paidLoads.toLocaleString("ru-RU")} купленных загрузок`} />
        <KpiCard label="Попсы / 1000 загрузок T1/T2" value={a.popPer1k} format="moneyPrecise" sub={`$${r.total.popRevenue.toFixed(0)} за период`} />
        <KpiCard label="Попсы − цена, на 1000" value={a.popMarginPer1k} format="moneyPrecise" />
        <KpiCard label={`Предел бида (маржа ${margin}%)`} value={a.maxBid} format="moneyPrecise" color="#16A34A" />
      </div>
      <Section title="Фильтры ADOK" sub="ADOK не отдаёт «формат × страна» и «источник × страна» одним отчётом: нужны фильтры по зонам попсов и по странам T1/T2. Проверка подбирает их на одном дне этого сайта (≈10 запросов) и включает разрезы в плане запросов">
        <div className="grid gap-3 text-sm sm:grid-cols-[1fr_auto]">
          <div className="flex flex-col gap-1" data-testid="buying-filters">
            <span>Попсы по странам: {r.filters.spots ? <b className="font-mono">{r.filters.spots.param}</b> : <span className="text-muted">фильтр не найден</span>} · разрез {r.cutsOn.pop ? "включён" : "выключен"}</span>
            <span>Источники на T1/T2: {r.filters.countries ? <b className="font-mono">{r.filters.countries.param}</b> : <span className="text-muted">фильтр не найден</span>} · разрез {r.cutsOn.cost ? "включён" : "выключен"}</span>
            {r.filters.checkedAt && <span className="text-xs text-muted">проверено {r.filters.checkedAt.slice(0, 10)} на {r.filters.site} за {r.filters.day}. Прошлые дни — «Бэкфилл AdSpyglass» в Интеграциях с этим сайтом</span>}
          </div>
          <CheckFilters siteId={site.id} />
        </div>
      </Section>
      <Section title="По дням" sub="Загрузки и попсы — по странам T1/T2; цена — расход платных источников на их загрузки T1/T2">
        <DataTable id="buying-days" exportName="buying-days" defaultSort={{ id: "date", dir: "desc" }} columns={DAY_COLS}
          rows={r.days.map((d) => ({ ...d, _key: d.date, popMargin: d.popPer1k != null && d.costPer1k != null ? d.popPer1k - d.costPer1k : null,
            src: `${d.popExact ? "попсы точно" : "попсы оценка"} · ${d.costExact ? "расход точно" : "расход оценка"}` }))} />
      </Section>
      <Section title="Страны T1/T2" sub="Где попсы окупают среднюю цену закупки, а где нет — кандидаты на понижение бида по стране">
        <DataTable id="buying-cc" exportName="buying-countries" defaultSort={{ id: "loads", dir: "desc" }} columns={CC_COLS}
          rows={r.countries.map((c) => ({ ...c, _key: c.country, tierLabel: `T${c.tier}${c.exact ? "" : " · оценка"}`, vsPrice: c.popPer1k != null && a.costPer1k != null ? c.popPer1k - a.costPer1k : null }))} />
      </Section>
      <Section title="Источники на T1/T2" sub="Только по дням с разрезом «Источники на T1/T2»">
        {r.sources.length === 0 ? <p className="text-sm text-muted">Нет данных: разрез ещё не загружался</p> :
          <DataTable id="buying-src" exportName="buying-sources" defaultSort={{ id: "loads", dir: "desc" }} columns={SRC_COLS}
            rows={r.sources.map((s) => ({ ...s, _key: s.slug, revShareLabel: s.revShare > 0 ? `${Math.round(s.revShare * 100)}%` : "бесплатный" }))} />}
      </Section>
    </>
  );
}
