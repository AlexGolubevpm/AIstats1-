"use client";
import Link from "next/link";
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { addPlacementAction, setPlacementUseAction } from "@/server/actions/inventory";
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
