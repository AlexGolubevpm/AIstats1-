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
import { addPlacementAction, setPlacementUseAction, setZonePlacementAction } from "@/server/actions/inventory";
import { useToast } from "@/components/ui/toast";
import type { ZoneRow } from "@/server/queries/inventory";
import { USE_LABEL, daysLeft, type PlaceDeal, type PlaceUse } from "@/server/domain/inventory";

const BY: Record<string, string> = { deal: "занято дилом", manual: "отмечено вручную", zone: "зона AdSpyglass", default: "нет дила, зоны и отметки" };

const left = (d: PlaceDeal, today: string) => {
  const n = daysLeft(d.endsAt, today);
  return n == null ? "бессрочно" : n < 0 ? `закончился ${-n} дн. назад` : `осталось ${n} дн.`;
};

export function PlaceButton({ siteId, domain, slug, place, use, by, label, deals, today, ending, className, text }: {
  siteId: string; domain: string; slug: string; place: string; use: PlaceUse; by: string; label: string | null; deals: PlaceDeal[]; today: string;
  ending: boolean; className: string; text: string;
}) {
  const [open, setOpen] = useState(false);
  const tip = deals.length
    ? deals.map((d) => `${d.advertiser} — ${d.title}: $${d.price} ${d.basis}, с ${d.startsAt} по ${d.endsAt ?? "бессрочно"}, ${left(d, today)}`).join("\n")
    : `${USE_LABEL[use]} · ${BY[by]}${label ? `: ${label}` : ""}`;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={tip}
        className={cn("relative block h-7 w-full truncate rounded px-2 text-left text-[11px] font-medium", className)}>
        {text}{ending && <span aria-label="заканчивается в течение недели" className="absolute right-1 top-1 size-1.5 rounded-full bg-warning" />}
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={`${place} · ${domain}`} description={`Сейчас: ${USE_LABEL[use]} (${BY[by]}${label ? `: ${label}` : ""})`}>
        {by === "deal" ? (
          <div className="flex flex-col gap-3 text-sm">
            <ul className="divide-y divide-border">{deals.map((d) => (
              <li key={d.id} className="flex flex-col gap-0.5 py-2">
                <Link className="font-medium text-accent hover:underline" href={`/deals/${d.id}`}>{d.advertiser} — {d.title}</Link>
                <span className="num text-muted">${d.price} {d.basis} · {d.billedVia === "DIRECT" ? "напрямую нам" : "через AdSpyglass"}</span>
                <span className="num text-muted">с {d.startsAt} по {d.endsAt ?? "бессрочно"} · {left(d, today)}</span>
              </li>
            ))}</ul>
            <p className="text-muted">Чтобы освободить место, уберите его в условиях дила или завершите дил.</p>
          </div>
        ) : (
          <ActionForm action={setPlacementUseAction} submit="Сохранить" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
            <input type="hidden" name="siteId" value={siteId} />
            <input type="hidden" name="slug" value={slug} />
            <FormField name="use" label="Состояние" hint="«Авто» — решают дилы и зоны AdSpyglass">
              <Select name="use" defaultValue={by === "manual" ? use : "AUTO"}>
                <option value="AUTO">Авто</option>
                {(Object.keys(USE_LABEL) as PlaceUse[]).map((u) => <option key={u} value={u}>{USE_LABEL[u]}</option>)}
              </Select>
            </FormField>
            <FormField name="note" label="Заметка" hint="Например, CPA-оффер или кто занимает место"><Input name="note" defaultValue={by === "manual" ? label ?? "" : ""} /></FormField>
          </ActionForm>
        )}
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
        <table className="num w-full text-[13px]">
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
        </table>
      </Sheet>
    </>
  );
}
