"use client";
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { deleteOpexAction, saveOpexAction } from "@/server/actions/opex";
import { OPEX_CATEGORIES, OPEX_LABEL } from "@/server/services/opex";

export interface OpexFormValues { id?: string; month: string; title: string; category: string; amount: number; siteId: string | null; note: string | null }

/** Add or edit an operating expense of a calendar month. */
export function OpexButton({ sites, values, label = "Добавить расход", defaultMonth }: {
  sites: { id: string; domain: string }[]; values?: OpexFormValues; label?: string; defaultMonth: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={values ? "ghost" : "secondary"} onClick={() => setOpen(true)}>{label}</Button>
      <Sheet open={open} onOpenChange={setOpen} title={values ? "Изменить расход" : "Операционный расход"}
        description="Сумма за месяц делится поровну на дни этого месяца и уходит в маржу. Без сайта — расход всей сети: в P&L он раскладывается по сайтам пропорционально выручке.">
        <ActionForm action={saveOpexAction} submit="Сохранить" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          {values?.id && <input type="hidden" name="id" value={values.id} />}
          <FormField name="month" label="Месяц"><Input type="month" name="month" defaultValue={values?.month ?? defaultMonth} required /></FormField>
          <FormField name="title" label="Что"><Input name="title" defaultValue={values?.title} placeholder="Серверы Hetzner" required /></FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField name="category" label="Категория">
              <Select name="category" defaultValue={values?.category ?? "HOSTING"}>{OPEX_CATEGORIES.map((c) => <option key={c} value={c}>{OPEX_LABEL[c]}</option>)}</Select>
            </FormField>
            <FormField name="amount" label="Сумма за месяц, $"><Input name="amount" inputMode="decimal" defaultValue={values ? values.amount.toFixed(2) : ""} required className="num" /></FormField>
          </div>
          <FormField name="siteId" label="Сайт" hint="Пусто — вся сеть">
            <Select name="siteId" defaultValue={values?.siteId ?? ""}><option value="">Вся сеть</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select>
          </FormField>
          <FormField name="note" label="Заметка"><Textarea name="note" rows={2} defaultValue={values?.note ?? ""} /></FormField>
        </ActionForm>
      </Sheet>
    </>
  );
}

export function DeleteOpex({ id }: { id: string }) {
  return (
    <ActionForm action={deleteOpexAction} submit="Удалить" className="inline">
      <input type="hidden" name="id" value={id} />
    </ActionForm>
  );
}
