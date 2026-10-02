"use client";
import Link from "next/link";
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { addPlacementAction, setPlacementUseAction } from "@/server/actions/inventory";
import { USE_LABEL, type PlaceUse } from "@/server/domain/inventory";

const BY: Record<string, string> = { deal: "занято дилом", manual: "отмечено вручную", zone: "зона AdSpyglass", default: "нет дила, зоны и отметки" };

export function PlaceButton({ siteId, domain, slug, place, use, by, label, dealId, className, text }: {
  siteId: string; domain: string; slug: string; place: string; use: PlaceUse; by: string; label: string | null; dealId: string | null; className: string; text: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} title={`${USE_LABEL[use]} · ${BY[by]}${label ? `: ${label}` : ""}`}
        className={cn("block h-7 w-full truncate rounded px-2 text-left text-[11px] font-medium", className)}>{text}</button>
      <Sheet open={open} onOpenChange={setOpen} title={`${place} · ${domain}`} description={`Сейчас: ${USE_LABEL[use]} (${BY[by]}${label ? `: ${label}` : ""})`}>
        {by === "deal" ? (
          <p className="text-sm">Место занято дилом — чтобы освободить, уберите место в условиях дила или завершите его.{" "}
            {dealId && <Link className="text-accent hover:underline" href={`/deals/${dealId}`}>Открыть дил</Link>}</p>
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
