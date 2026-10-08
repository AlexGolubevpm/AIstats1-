"use client";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { fmtMoney } from "@/lib/format";
import { addPlacementAction, attachDealPlacesAction, detachDealPlaceAction, setPlacementUseAction, setZonePlacementAction } from "@/server/actions/inventory";
import { useToast } from "@/components/ui/toast";
import type { ZoneRow } from "@/server/queries/inventory";
import { USE_LABEL, daysLeft, type PlaceCell, type PlaceDeal, type PlaceUse } from "@/server/domain/inventory";

const BY: Record<string, string> = { deal: "занято дилом", manual: "отмечено вручную", zone: "зона AdSpyglass", default: "нет дила, зоны и отметки" };

const left = (d: PlaceDeal, today: string) => {
  const n = daysLeft(d.endsAt, today);
  return n == null ? "бессрочно" : n < 0 ? `закончился ${-n} дн. назад` : `осталось ${n} дн.`;
};

export function PlaceButton({ siteId, domain, slug, place, cell, today, ending, className, text, networks, attachable }: {
  siteId: string; domain: string; slug: string; place: string; cell: PlaceCell; today: string; ending: boolean; className: string; text: string;
  networks: { id: string; title: string; kind: string }[];
  attachable: { id: string; title: string; advertiser: string; billedVia: string; siteIds: string[] }[];
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [pending, start] = useTransition();
  const toast = useToast();
  const { use, by, label, deals, network } = cell;
  const tip = deals.length
    ? deals.map((d) => `${d.advertiser} — ${d.title}: $${d.price} ${d.basis}, с ${d.startsAt} по ${d.endsAt ?? "бессрочно"}, ${left(d, today)}`).join("\n")
    : `${USE_LABEL[use]} · ${BY[by]}${label ? `: ${label}` : ""}`;
  const onCell = new Set(deals.map((d) => d.id));
  const candidates = attachable.filter((d) => !onCell.has(d.id) && (!q || `${d.advertiser} ${d.title}`.toLowerCase().includes(q.toLowerCase())));
  const detach = (dealId: string) => start(async () => {
    const r = await detachDealPlaceAction(siteId, slug, dealId);
    r.error ? toast(r.error, "error") : toast(r.message ?? "Готово");
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={tip}
        className={cn("relative block h-7 w-full truncate rounded px-2 text-left text-[11px] font-medium", className)}>
        {text}{ending && <span aria-label="заканчивается в течение недели" className="absolute right-1 top-1 size-1.5 rounded-full bg-warning" />}
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={`${place} · ${domain}`} width="max-w-xl"
        description={`Сейчас: ${USE_LABEL[use]} (${BY[by]}${label ? `: ${label}` : ""})`}>
        <div className="flex flex-col gap-6 text-sm">
          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Фикс-дилы на этом месте · {deals.length}</h3>
            {deals.length ? (
              <ul className="divide-y divide-border">{deals.map((d) => (
                <li key={d.id} className="flex items-start justify-between gap-3 py-2">
                  <div className="flex flex-col gap-0.5">
                    <Link className="font-medium text-accent hover:underline" href={`/deals/${d.id}`}>{d.advertiser} — {d.title}</Link>
                    <span className="num text-muted">${d.price} {d.basis} · {d.billedVia === "DIRECT" ? "напрямую нам" : "через AdSpyglass"}</span>
                    <span className="num text-muted">с {d.startsAt} по {d.endsAt ?? "бессрочно"} · {left(d, today)}</span>
                  </div>
                  <Button size="sm" variant="secondary" disabled={pending} onClick={() => detach(d.id)}>Убрать с места</Button>
                </li>
              ))}</ul>
            ) : <p className="text-muted">Дилов нет. Несколько дилов на одном месте — нормально, например по тирам гео.</p>}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Добавить фикс-дил</h3>
            <ActionForm action={attachDealPlacesAction} submit="Привязать" onDone={() => setQ("")} className="flex flex-col gap-2">
              <input type="hidden" name="siteId" value={siteId} />
              <input type="hidden" name="slug" value={slug} />
              <div className="rounded-lg border border-border">
                <Input placeholder="Поиск по рекламодателю или названию" value={q} onChange={(e) => setQ(e.target.value)} className="rounded-b-none border-0 border-b" aria-label="Поиск дила" />
                <div className="max-h-44 overflow-y-auto p-1">
                  {candidates.length ? candidates.map((d) => (
                    <label key={d.id} className="flex items-center gap-2 rounded px-2 py-1 text-xs hover:bg-surface-hover">
                      <input type="checkbox" name="dealIds" value={d.id} />
                      <span className="flex-1">{d.advertiser} — {d.title}</span>
                      <span className="text-muted">{d.billedVia === "DIRECT" ? "напрямую" : "через ASG"}{d.siteIds.includes(siteId) ? "" : " · сайт добавится"}</span>
                    </label>
                  )) : <p className="px-2 py-1 text-xs text-muted">Нет подходящих дилов</p>}
                </div>
              </div>
            </ActionForm>
            <Link href={`/deals?new=1&place=${encodeURIComponent(`${siteId}|${slug}`)}`} className="text-xs text-accent hover:underline">Новый дил на этом месте →</Link>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Состояние и сетка</h3>
            <ActionForm action={setPlacementUseAction} submit="Сохранить" onDone={() => setOpen(false)} className="flex flex-col gap-3">
              <input type="hidden" name="siteId" value={siteId} />
              <input type="hidden" name="slug" value={slug} />
              <FormField name="networkId" label="Место выкупает сетка" hint="Прямая сетка — own deal в AdSpyglass, медиация — ротация; пусто — не отмечать">
                <Select name="networkId" defaultValue={network?.id ?? ""}>
                  <option value="">— не указана —</option>
                  {networks.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}
                </Select>
              </FormField>
              <FormField name="use" label="Состояние" hint="«Авто» — решают дилы, сетка и зоны AdSpyglass">
                <Select name="use" defaultValue={by === "manual" && !network ? use : "AUTO"}>
                  <option value="AUTO">Авто</option>
                  {(Object.keys(USE_LABEL) as PlaceUse[]).map((u) => <option key={u} value={u}>{USE_LABEL[u]}</option>)}
                </Select>
              </FormField>
              <FormField name="note" label="Заметка" hint="Например, CPA-оффер или кто занимает место"><Input name="note" defaultValue={by === "manual" ? (cell.label !== network?.title ? label ?? "" : "") : ""} /></FormField>
            </ActionForm>
          </section>
        </div>
      </Sheet>
    </>
  );
}

export function AddPlacement() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Добавить формат</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Новый формат (место на сайте)" description="Появится колонкой у всех сайтов. Зоны AdSpyglass с этим названием привяжутся сами.">
        <ActionForm action={addPlacementAction} submit="Добавить" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          <FormField name="title" label="Название"><Input name="title" required placeholder="Header banner" /></FormField>
        </ActionForm>
      </Sheet>
    </>
  );
}

/** Bundle filter: writes ?bundle= into the URL, keeping the rest. */
export function BundleSelect({ value, bundles }: { value: string; bundles: { slug: string; title: string }[] }) {
  const router = useRouter(); const path = usePathname(); const sp = useSearchParams();
  return (
    <Select value={value} aria-label="Бандл" className="w-44" onChange={(e) => {
      const q = new URLSearchParams(sp.toString());
      if (e.target.value) q.set("bundle", e.target.value); else q.delete("bundle");
      router.push(`${path}${q.size ? `?${q}` : ""}`);
    }}>
      <option value="">Все бандлы</option>
      {bundles.map((b) => <option key={b.slug} value={b.slug}>{b.title}</option>)}
    </Select>
  );
}

const FORMAT_WORD: Record<string, string> = { POPUNDER: "Popunder", BANNER: "Баннер", NATIVE: "Нативка", SLIDER: "Слайдер", OUTSTREAM: "Outstream", INVIDEO: "In-video", INPAGEPUSH: "In-page push", OTHER: "Другое" };

/** Zones of a site and the place each one fills; the mapping is saved per zone and remembered. */
export function ZonesButton({ siteId, domain, zones, unmapped, places }: {
  siteId: string; domain: string; zones: ZoneRow[]; unmapped: number; places: { slug: string; title: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const toast = useToast();
  if (!zones.length) return null;
  const save = (zoneId: string, slug: string) => start(async () => {
    const f = new FormData(); f.set("zoneId", zoneId); f.set("slug", slug); f.set("domain", domain);
    const r = await setZonePlacementAction({ ok: true }, f);
    r.error ? toast(r.error, "error") : toast(r.message ?? "Сохранено");
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={`Зоны AdSpyglass сайта: ${zones.length}, без формата: ${unmapped}`}
        className={cn("rounded px-1.5 py-0.5 text-[11px] font-medium", unmapped ? "bg-warning-soft text-warning" : "bg-surface-hover text-muted")}>
        {unmapped ? `${unmapped} зон без формата` : `${zones.length} зон`}
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={`Зоны · ${domain}`} width="max-w-2xl"
        description="Какой формат заполняет каждая зона AdSpyglass. По названию привязываются только зоны с названием формата внутри («Tablink 1»); остальные — здесь, вручную. Выручка — за выбранный период.">
        <div className="overflow-x-auto"><table className="num w-full text-[13px]">
          <thead><tr className="border-b border-border text-xs text-muted">
            <th className="h-8 text-left font-medium">Зона</th><th className="h-8 text-left font-medium">Тип ADOK</th>
            <th className="h-8 text-right font-medium">Выручка</th><th className="h-8 text-left font-medium">Формат</th></tr></thead>
          <tbody>{zones.map((z) => (
            <tr key={z.id} className="border-b border-border/60">
              <td className="py-1.5 pr-3 font-mono text-xs">{z.name}</td>
              <td className="py-1.5 pr-3 text-muted">{FORMAT_WORD[z.format] ?? z.format}</td>
              <td className="py-1.5 pr-3 text-right">{fmtMoney(z.revenue)}</td>
              <td className="py-1.5">
                <Select defaultValue={z.placementSlug ?? ""} disabled={pending} aria-label={`Формат зоны ${z.name}`} onChange={(e) => save(z.id, e.target.value)}>
                  <option value="">— без формата —</option>
                  {places.map((p) => <option key={p.slug} value={p.slug}>{p.title}</option>)}
                </Select>
              </td>
            </tr>
          ))}</tbody>
        </table></div>
      </Sheet>
    </>
  );
}
