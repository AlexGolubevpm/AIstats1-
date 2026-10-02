import Link from "next/link";
import { PageHeader } from "@/components/layout/page-header";
import { Section } from "@/components/ui/card";
import { USE_LABEL } from "@/server/domain/inventory";
import { inventoryGrid } from "@/server/queries/inventory";
import { AddPlacement, PlaceButton } from "./client";

type Props = { searchParams: Promise<Record<string, string | undefined>> };

export default async function Inventory({ searchParams }: Props) {
  const sp = await searchParams;
  const onlyFree = sp.free === "1";
  const grid = await inventoryGrid();
  const sites = onlyFree ? grid.sites.filter((s) => s.free > 0) : grid.sites;
  const totalFree = grid.sites.reduce((a, s) => a + s.free, 0);
  return (
    <>
      <PageHeader title="Форматы" sub={`Места на сайтах и чем они заняты · свободно ${totalFree} из ${grid.sites.length * grid.places.length}`} />
      <Section title="Места × сайты"
        sub="Фикс и own deal — из дилов с указанным местом, ротация ASG — из зон AdSpyglass с этим местом в названии; остальное можно отметить вручную (клик по ячейке)"
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
                    return (
                      <td key={p.slug} className="border-b border-border/60 px-1 py-1">
                        <PlaceButton siteId={s.id} domain={s.domain} slug={p.slug} place={p.title} use={c.use} by={c.by} label={c.label}
                          dealId={c.dealIds[0] ?? null} className={TONE[c.use]} text={SHORT[c.use]} />
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
    </>
  );
}

const TONE: Record<keyof typeof USE_LABEL, string> = {
  ROTATION: "bg-accent-soft text-accent", OWN_DEAL: "bg-violet-soft text-violet", FIX: "bg-positive-soft text-positive",
  CPA: "bg-warning-soft text-warning", FREE: "border border-dashed border-border-strong text-muted", NONE: "bg-surface-2 text-faint",
};
const SHORT: Record<keyof typeof USE_LABEL, string> = { ROTATION: "ASG", OWN_DEAL: "Own", FIX: "Фикс", CPA: "CPA", FREE: "свободно", NONE: "—" };
