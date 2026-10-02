import Link from "next/link";
import { DataTable } from "@/components/data/data-table";
import type { Column } from "@/components/data/format-cell";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { USE_LABEL, daysLeft } from "@/server/domain/inventory";
import { inventoryDeals, inventoryGrid } from "@/server/queries/inventory";
import { AddPlacement, PlaceButton } from "./client";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

const DEAL_COLS: Column[] = [
  { id: "placement", header: "Место", kind: "text" }, { id: "title", header: "Дил", kind: "text" }, { id: "advertiser", header: "Кто стоит", kind: "text" },
  { id: "sitesCount", header: "Сайтов", kind: "int" }, { id: "price", header: "За сколько, $", kind: "decimal" }, { id: "basis", header: "Модель", kind: "text" },
  { id: "startsAt", header: "С", kind: "text" }, { id: "endsAt", header: "По", kind: "text" }, { id: "left", header: "Осталось дней", kind: "int" },
  { id: "statusLabel", header: "Статус", kind: "text" },
];
const STATUS: Record<string, string> = { ACTIVE: "активен", PAUSED: "пауза", ENDED: "закончился", DRAFT: "черновик" };

export default async function Inventory({ searchParams }: Props) {
  const sp = await searchParams;
  const onlyFree = sp.free === "1";
  const today = new Date().toISOString().slice(0, 10);
  const [grid, deals] = await Promise.all([inventoryGrid(today), inventoryDeals(today)]);
  const sites = onlyFree ? grid.sites.filter((s) => s.free > 0) : grid.sites;
  const totalFree = grid.sites.reduce((a, s) => a + s.free, 0);
  const running = deals.filter((d) => d.status !== "ENDED");
  const endingSoon = running.filter((d) => d.daysLeft != null && d.daysLeft <= 7).length;
  return (
    <>
      <PageHeader title="Форматы"
        sub={`Места на сайтах и чем они заняты · свободно ${totalFree} из ${grid.sites.length * grid.places.length} · фикс-дилов ${running.length}${endingSoon ? ` · заканчиваются за неделю: ${endingSoon}` : ""}`} />
      <Section title="Места × сайты"
        sub="Фикс и own deal — из дилов с указанным местом, ротация ASG — из зон AdSpyglass с этим местом в названии; остальное можно отметить вручную (клик по ячейке). Точка — дил заканчивается в течение недели"
        actions={<div className="flex items-center gap-2">
          <Link href={onlyFree ? "/inventory" : "/inventory?free=1"} className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-surface-hover">
            {onlyFree ? "Все сайты" : "Только со свободными"}</Link>
          <AddPlacement />
        </div>}>
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-muted">
          {(Object.keys(USE_LABEL) as (keyof typeof USE_LABEL)[]).map((u) => <span key={u} className="flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${TONE[u]}`} />{USE_LABEL[u]}</span>)}
        </div>
        <div className="-mx-5 overflow-x-auto">
          <table className="num w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-xs text-muted">
                <th className="sticky left-0 z-10 h-9 border-b border-border bg-surface pl-5 pr-3 text-left font-medium">Сайт</th>
                {grid.places.map((p) => (
                  <th key={p.slug} className="h-9 min-w-24 border-b border-border px-2 text-left font-medium">
                    <div className="leading-4">{p.title}</div><div className="text-[11px] font-normal text-faint">свободно {p.free}</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sites.map((s) => (
                <tr key={s.id}>
                  <td className="sticky left-0 z-10 h-9 border-b border-border/60 bg-surface pl-5 pr-3 font-mono">
                    <Link href={`/sites/${s.domain}`} className="hover:underline">{s.domain}</Link>
                  </td>
                  {grid.places.map((p) => {
                    const c = s.cells[p.slug];
                    const soonest = c.deals.map((d) => daysLeft(d.endsAt, today)).filter((x): x is number => x != null).sort((a, b) => a - b)[0];
                    return (
                      <td key={p.slug} className="border-b border-border/60 px-1 py-1">
                        <PlaceButton siteId={s.id} domain={s.domain} slug={p.slug} place={p.title} use={c.use} by={c.by} label={c.label} deals={c.deals}
                          today={today} ending={soonest != null && soonest <= 7} className={TONE[c.use]}
                          text={c.deals.length ? c.deals.map((d) => d.advertiser).join(", ") : SHORT[c.use]} />
                      </td>
                    );
                  })}
                </tr>
              ))}
              {sites.length === 0 && <tr><td colSpan={grid.places.length + 1} className="py-8 text-center text-sm text-muted">{onlyFree ? "Свободных мест нет" : "Нет активных сайтов"}</td></tr>}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Фикс-дилы" sub="Все дилы из раздела «Фикс-дилы»: место, кто стоит, за сколько и до какого числа. Закончившиеся за последние 30 дней — серым. Клик по дилу — его карточка">
        <DataTable id="fd" exportName="fix-deals" defaultSort={{ id: "left", dir: "asc" }} columns={DEAL_COLS}
          empty="Дилов нет — добавьте в разделе «Фикс-дилы»"
          rows={deals.map((d) => ({
            ...d, sitesCount: d.sites.length, placement: d.placement ?? "—", statusLabel: STATUS[d.status] ?? d.status,
            left: d.status === "ENDED" ? null : d.daysLeft, endsAt: d.endsAt ?? "бессрочно", noPlace: d.placement ? 0 : 1,
            soon: d.status !== "ENDED" && d.daysLeft != null && d.daysLeft <= 7 ? 1 : 0,
            _key: d.id, _href: `/deals/${d.id}`, _warn: d.status !== "ENDED" && d.daysLeft != null && d.daysLeft <= 3,
            _badges: {
              placement: d.placement ? [] : [{ label: "не указано", tone: "warning" as const }],
              title: d.sites.length ? [{ label: d.sites.length === 1 ? d.sites[0] : `${d.sites.length} сайтов`, tone: "neutral" as const }] : [],
              endsAt: d.status === "ENDED" ? [{ label: "закончился", tone: "neutral" as const }]
                : d.daysLeft != null && d.daysLeft < 0 ? [{ label: "просрочен", tone: "negative" as const }]
                : d.daysLeft != null && d.daysLeft <= 7 ? [{ label: `${d.daysLeft} дн.`, tone: d.daysLeft <= 3 ? "negative" as const : "warning" as const }] : [],
            },
          }))}
          filters={[{ id: "soon", label: "Заканчиваются за 7 дней", column: "soon", op: "truthy" }, { id: "noplace", label: "Без места", column: "noPlace", op: "truthy" }]} />
      </Section>
    </>
  );
}

const TONE: Record<keyof typeof USE_LABEL, string> = {
  ROTATION: "bg-accent-soft text-accent", OWN_DEAL: "bg-violet-soft text-violet", FIX: "bg-positive-soft text-positive",
  CPA: "bg-warning-soft text-warning", FREE: "border border-dashed border-border-strong text-muted", NONE: "bg-surface-2 text-faint",
};
const SHORT: Record<keyof typeof USE_LABEL, string> = { ROTATION: "ASG", OWN_DEAL: "Own", FIX: "Фикс", CPA: "CPA", FREE: "свободно", NONE: "—" };
