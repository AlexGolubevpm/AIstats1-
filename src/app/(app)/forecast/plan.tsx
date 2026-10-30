"use client";
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { HORIZONS } from "@/lib/forecast";
import { deletePlanItemAction, saveForecastPlanAction, savePlanItemAction } from "@/server/actions/forecast";
import { PLAN_ITEM_KINDS, PLAN_ITEM_LABEL, type ForecastPlan } from "@/server/services/forecast-plan";

const pctText = (v: number) => (v ? String(Math.round(v * 1000) / 10) : "");

/** «Сценарий»: horizon, growth of the rotation and of the traffic cost per month, drafts in or out. */
export function ScenarioForm({ plan }: { plan: ForecastPlan }) {
  return (
    <div data-testid="forecast-scenario">
      <ActionForm action={saveForecastPlanAction} submit="Сохранить сценарий" submitSize="sm" className="flex flex-wrap items-end gap-3 [&>div:last-child]:pt-0">
        <FormField name="horizon" label="Горизонт">
          <Select name="horizon" defaultValue={String(plan.horizon)} className="w-32">{HORIZONS.map((h) => <option key={h} value={h}>{h} мес.</option>)}</Select>
        </FormField>
        <FormField name="revenueGrowth" label="Рост ротации, %/мес"><Input name="revenueGrowth" inputMode="decimal" defaultValue={pctText(plan.revenueGrowth)} placeholder="0" className="num w-28" /></FormField>
        <FormField name="costGrowth" label="Рост расхода, %/мес"><Input name="costGrowth" inputMode="decimal" defaultValue={pctText(plan.costGrowth)} placeholder="0" className="num w-28" /></FormField>
        <label className="flex h-9 items-center gap-2 text-sm"><input type="checkbox" name="includeDrafts" value="1" defaultChecked={plan.includeDrafts} /> учитывать черновики дилов</label>
      </ActionForm>
    </div>
  );
}

export interface PlanItemValues { id?: string; month: string; kind: string; title: string; amount: number; siteId: string | null; note: string | null }

/** Add or edit a planned line of a month: a new site's revenue, a traffic purchase… */
export function PlanItemButton({ sites, values, defaultMonth, minMonth, label = "Добавить статью" }: {
  sites: { id: string; domain: string }[]; values?: PlanItemValues; defaultMonth: string; minMonth: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant={values ? "ghost" : "secondary"} onClick={() => setOpen(true)}>{label}</Button>
      <Sheet open={open} onOpenChange={setOpen} title={values ? "Изменить статью" : "Плановая статья"}
        description="Доход или расход, который вы ожидаете в месяце и которого нет в темпе: новый сайт, закупка трафика, разовый платёж. Попадает только в план, в факты не пишется.">
        <ActionForm action={savePlanItemAction} submit="Сохранить" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          {values?.id && <input type="hidden" name="id" value={values.id} />}
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField name="month" label="Месяц"><Input type="month" name="month" min={minMonth} defaultValue={values?.month ?? defaultMonth} required /></FormField>
            <FormField name="kind" label="Тип">
              <Select name="kind" defaultValue={values?.kind ?? "REVENUE"}>{PLAN_ITEM_KINDS.map((k) => <option key={k} value={k}>{PLAN_ITEM_LABEL[k]}</option>)}</Select>
            </FormField>
          </div>
          <FormField name="title" label="Что"><Input name="title" defaultValue={values?.title} placeholder="Новый сайт в бандле JAV" required /></FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField name="amount" label="Сумма за месяц, $"><Input name="amount" inputMode="decimal" defaultValue={values ? values.amount.toFixed(2) : ""} required className="num" /></FormField>
            <FormField name="siteId" label="Сайт" hint="Пусто — вся сеть">
              <Select name="siteId" defaultValue={values?.siteId ?? ""}><option value="">Вся сеть</option>{sites.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select>
            </FormField>
          </div>
          <FormField name="note" label="Заметка"><Textarea name="note" rows={2} defaultValue={values?.note ?? ""} /></FormField>
        </ActionForm>
      </Sheet>
    </>
  );
}

export function DeletePlanItem({ id }: { id: string }) {
  return (
    <ActionForm action={deletePlanItemAction} submit="Удалить" className="inline" submitVariant="ghost" submitSize="sm">
      <input type="hidden" name="id" value={id} />
    </ActionForm>
  );
}
