import Link from "next/link";
import { DataTable } from "@/components/data/data-table";
import type { Column } from "@/components/data/format-cell";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { fmtMoney } from "@/lib/format";
import { periodFromParams } from "@/lib/period";
import { db } from "@/server/db";
import { USE_LABEL, cellText, daysLeft } from "@/server/domain/inventory";
import { attachableDeals, inventoryDeals, inventoryGrid, type InventoryGrid } from "@/server/queries/inventory";
import { AddPlacement, BundleSelect, PlaceButton, ZonesButton } from "./client";

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
  const p = periodFromParams(sp, "7d");
  const onlyFree = sp.free === "1";
  const groupByBundle = sp.group === "bundle";
  const today = new Date().toISOString().slice(0, 10);
  const [grid, deals, bundles, networks, attachable] = await Promise.all([inventoryGrid(today, p), inventoryDeals(today), db.bundle.findMany({ orderBy: { title: "asc" } }),
    db.network.findMany({ where: { showInLegend: true }, orderBy: [{ sortOrder: "asc" }, { title: "asc" }], select: { id: true, title: true, kind: true } }), attachableDeals()]);
  const bundle = sp.bundle && bundles.find((b) => b.slug === sp.bundle) ? sp.bundle : "";
  let sites = grid.sites;
  if (bundle) sites = sites.filter((s) => s.bundles.includes(bundle));
  if (onlyFree) sites = sites.filter((s) => s.free > 0);
  const totalFree = grid.sites.reduce((a, s) => a + s.free, 0);
  const running = deals.filter((d) => d.status !== "ENDED");
  const endingSoon = running.filter((d) => d.daysLeft != null && d.daysLeft <= 7).length;
  const unmapped = grid.sites.reduce((a, s) => a + s.unmapped, 0);
  const href = (over: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...sp, ...over })) if (v) q.set(k, v);
    const s = q.toString();
    return `/inventory${s ? `?${s}` : ""}`;
  };
  const placeTitle = Object.fromEntries(grid.places.map((pl) => [pl.slug, pl.title]));

  // Blocks: one per bundle (a site in two bundles is in both) + sites outside every bundle; or one block.
  const blocks: { key: string; title: string | null; sites: InventoryGrid["sites"] }[] = groupByBundle
    ? [
      ...bundles.filter((b) => !bundle || b.slug === bundle).map((b) => ({ key: b.slug, title: b.title, sites: sites.filter((s) => s.bundles.includes(b.slug)) })).filter((b) => b.sites.length),
      ...(bundle ? [] : [{ key: "_none", title: "Без бандла", sites: sites.filter((s) => !s.bundles.length) }].filter((b) => b.sites.length)),
    ]
    : [{ key: "all", title: null, sites }];
  const sum = (rows: InventoryGrid["sites"], slug: string) => rows.reduce((a, r) => a + r.cells[slug].revenue, 0);
  const shown = new Map(sites.map((s) => [s.id, s]));
  const shownTotal = [...shown.values()].reduce((a, s) => a + s.revenue, 0);

  return (
    <>
      <PageHeader title="Форматы" period={p}
        sub={`Выручка по форматам за период ${fmtMoney(grid.revenue)} · свободно ${totalFree} из ${grid.sites.length * grid.places.length} мест · фикс-дилов ${running.length}${endingSoon ? ` · заканчиваются за неделю: ${endingSoon}` : ""}${unmapped ? ` · зон без формата: ${unmapped}` : ""}`} />
      <Section title="Места × сайты"
        sub="В ячейке — выручка формата на сайте за период (зоны AdSpyglass с этим форматом + фикс-дилы); цвет — чем занято. Клик по ячейке — подробности и ручная отметка. «N зон» у сайта — привязать зоны без формата"
        actions={<div className="flex flex-wrap items-center gap-2">
          <BundleSelect value={bundle} bundles={bundles.map((b) => ({ slug: b.slug, title: b.title }))} />
          <Link href={href({ group: groupByBundle ? undefined : "bundle" })} className={`rounded-md border px-3 py-1.5 text-sm hover:bg-surface-hover ${groupByBundle ? "border-accent text-accent" : "border-border"}`}>
            {groupByBundle ? "Без группировки" : "Группировать по бандлам"}</Link>
          <Link href={href({ free: onlyFree ? undefined : "1" })} className={`rounded-md border px-3 py-1.5 text-sm hover:bg-surface-hover ${onlyFree ? "border-accent text-accent" : "border-border"}`}>
            {onlyFree ? "Все сайты" : "Только со свободными"}</Link>
          <AddPlacement />
        </div>}>
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-muted">
          {(Object.keys(USE_LABEL) as (keyof typeof USE_LABEL)[]).map((u) => <span key={u} className="flex items-center gap-1.5"><span className={`size-2.5 rounded-sm ${TONE[u]}`} />{USE_LABEL[u]}</span>)}
        </div>
        <div className="-mx-5 overflow-x-auto">
          <table className="tbl num w-full border-separate border-spacing-0 text-[12px]">
            <thead>
              <tr className="text-xs text-muted">
                <th className="sticky left-0 z-10 h-10 border-b border-border bg-surface pl-5 pr-3 text-left font-medium">Сайт</th>
                {grid.places.map((pl) => (
                  <th key={pl.slug} className="h-10 min-w-24 border-b border-border px-2 text-left font-medium">
                    <div className="leading-4">{pl.title}</div>
                    <div className="text-[11px] font-normal text-faint">{fmtMoney(sum([...shown.values()], pl.slug))} · своб. {pl.free}{pl.zones ? ` · зон ${pl.zones}` : ""}</div>
                  </th>
                ))}
                <th className="h-10 border-b border-border px-3 text-right font-medium">Итого</th>
              </tr>
            </thead>
            <tbody>
              {blocks.map((b) => (
                <BlockRows key={b.key} block={b} grid={grid} today={today} placeTitle={placeTitle} sum={sum} networks={networks} attachable={attachable} />
              ))}
              {sites.length === 0 && <tr><td colSpan={grid.places.length + 2} className="py-8 text-center text-sm text-muted">{onlyFree ? "Свободных мест нет" : "Нет активных сайтов"}</td></tr>}
            </tbody>
            {sites.length > 0 && (
              <tfoot>
                <tr className="font-medium">
                  <td className="sticky left-0 z-10 h-9 border-t border-border bg-surface pl-5 pr-3">Итого по сайтам{bundle ? " бандла" : ""}</td>
                  {grid.places.map((pl) => <td key={pl.slug} className="h-9 border-t border-border px-3">{fmtMoney(sum([...shown.values()], pl.slug))}</td>)}
                  <td className="h-9 border-t border-border px-3 text-right">{fmtMoney(shownTotal)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </Section>
      <Section title="Фикс-дилы" sub="Все дилы из раздела «Фикс-дилы»: место, кто стоит, за сколько и до какого числа. Закончившиеся за последние 30 дней — серым. Клик по дилу — его карточка">
        <DataTable id="fd" exportName="fix-deals" defaultSort={{ id: "left", dir: "asc" }} columns={DEAL_COLS}
          empty="Дилов нет — добавьте в разделе «Фикс-дилы»"
          rows={deals.map((d) => ({
            ...d, sitesCount: d.sites.length, placement: d.placements.join(", ") || "—", statusLabel: STATUS[d.status] ?? d.status,
            left: d.status === "ENDED" ? null : d.daysLeft, endsAt: d.endsAt ?? "бессрочно", noPlace: d.placements.length ? 0 : 1,
            soon: d.status !== "ENDED" && d.daysLeft != null && d.daysLeft <= 7 ? 1 : 0,
            _key: d.id, _href: `/deals/${d.id}`, _warn: d.status !== "ENDED" && d.daysLeft != null && d.daysLeft <= 3,
            _badges: {
              placement: d.placements.length ? [] : [{ label: "не указано", tone: "warning" as const }],
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

type Networks = { id: string; title: string; kind: string }[];
type Attachable = Awaited<ReturnType<typeof attachableDeals>>;
function BlockRows({ block, grid, today, placeTitle, sum, networks, attachable }: {
  block: { key: string; title: string | null; sites: InventoryGrid["sites"] }; grid: InventoryGrid; today: string;
  placeTitle: Record<string, string>; sum: (rows: InventoryGrid["sites"], slug: string) => number; networks: Networks; attachable: Attachable;
}) {
  return (
    <>
      {block.title && (
        <tr className="bg-surface-2 text-xs font-medium text-muted">
          <td className="sticky left-0 z-10 h-8 border-b border-border/60 bg-surface-2 pl-5 pr-3">{block.title} · {block.sites.length} {block.sites.length === 1 ? "сайт" : "сайтов"}</td>
          {grid.places.map((pl) => <td key={pl.slug} className="h-8 border-b border-border/60 px-3">{fmtMoney(sum(block.sites, pl.slug))}</td>)}
          <td className="h-8 border-b border-border/60 px-3 text-right">{fmtMoney(block.sites.reduce((a, s) => a + s.revenue, 0))}</td>
        </tr>
      )}
      {block.sites.map((s) => (
        <tr key={s.id}>
          <td className="sticky left-0 z-10 h-9 border-b border-border/60 bg-surface pl-5 pr-3">
            <div className="flex items-center gap-2">
              <Link href={`/sites/${s.domain}`} className="font-mono hover:underline">{s.domain}</Link>
              <ZonesButton siteId={s.id} domain={s.domain} zones={s.zones} unmapped={s.unmapped} places={grid.places.map((pl) => ({ slug: pl.slug, title: pl.title }))} />
            </div>
          </td>
          {grid.places.map((pl) => {
            const c = s.cells[pl.slug];
            const soonest = c.deals.map((d) => daysLeft(d.endsAt, today)).filter((x): x is number => x != null).sort((a, b) => a - b)[0];
            return (
              <td key={pl.slug} className="border-b border-border/60 px-1 py-1">
                <PlaceButton siteId={s.id} domain={s.domain} slug={pl.slug} place={placeTitle[pl.slug]} cell={c} today={today}
                  ending={soonest != null && soonest <= 7} className={TONE[c.use]} networks={networks} attachable={attachable}
                  text={cellText(c, c.revenue > 0 ? fmtMoney(c.revenue) : null, SHORT)} />
              </td>
            );
          })}
          <td className="h-9 border-b border-border/60 px-3 text-right font-medium">{fmtMoney(s.revenue)}</td>
        </tr>
      ))}
    </>
  );
}

const TONE: Record<keyof typeof USE_LABEL, string> = {
  ROTATION: "bg-accent-soft text-accent", OWN_DEAL: "bg-violet-soft text-violet", FIX: "bg-positive-soft text-positive",
  CPA: "bg-warning-soft text-warning", FREE: "border border-dashed border-border-strong text-muted", NONE: "bg-surface-2 text-faint",
};
const SHORT: Record<keyof typeof USE_LABEL, string> = { ROTATION: "ASG", OWN_DEAL: "Own", FIX: "Фикс", CPA: "CPA", FREE: "свободно", NONE: "—" };
