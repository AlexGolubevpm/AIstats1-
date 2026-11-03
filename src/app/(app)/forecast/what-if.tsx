"use client";
import { useState } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { deleteWhatIfAction, saveWhatIfAction, toggleWhatIfAction, whatIfToPlanAction } from "@/server/actions/forecast";
import type { WhatIfOption } from "@/server/queries/forecast";
import { WHAT_IF_KINDS, WHAT_IF_LABEL } from "@/server/services/what-if";

const usd = (v: number) => `$${v.toLocaleString("ru-RU", { maximumFractionDigits: 0 })}`;

/** «Добавить вариант»: pick what to change (it fills what it costs now), say what it becomes and from which month. */
export function WhatIfButton({ options, defaultMonth, minMonth }: { options: WhatIfOption[]; defaultMonth: string; minMonth: string }) {
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState("");
  const [kind, setKind] = useState("OPEX");
  const [current, setCurrent] = useState("");
  const [title, setTitle] = useState("");
  const [ref, setRef] = useState("");
  const choose = (v: string) => {
    setPick(v);
    const o = options[Number(v)];
    if (!v || !o) return;
    setKind(o.kind); setRef(o.ref ?? ""); setCurrent(o.current.toFixed(2)); setTitle(o.label);
  };
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Добавить вариант</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Что если"
        description="Вариант оптимизации: что меняем, сколько это стоит сейчас и сколько будет. Считается только здесь — в план и в статистику не попадает, пока не нажать «В план».">
        <ActionForm action={saveWhatIfAction} submit="Посчитать" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          <FormField name="pick" label="Что меняем" hint="Сумма «сейчас» подставится из данных — её можно поправить">
            <Select value={pick} onChange={(e) => choose(e.target.value)} data-testid="what-if-pick">
              <option value="">Своё…</option>{options.map((o, i) => <option key={i} value={i}>{o.label} · {usd(o.current)}/мес</option>)}
            </Select>
          </FormField>
          <input type="hidden" name="ref" value={ref} />
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField name="kind" label="Тип"><Select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>{WHAT_IF_KINDS.map((k) => <option key={k} value={k}>{WHAT_IF_LABEL[k]}</option>)}</Select></FormField>
            <FormField name="fromMonth" label="С месяца"><Input type="month" name="fromMonth" min={minMonth} defaultValue={defaultMonth} required /></FormField>
          </div>
          <FormField name="title" label="Название"><Input name="title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Хостинг: переезд на дешёвые серверы" /></FormField>
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField name="current" label="Сейчас, $/мес"><Input name="current" inputMode="decimal" value={current} onChange={(e) => setCurrent(e.target.value)} required className="num" /></FormField>
            <FormField name="target" label="Станет, $/мес"><Input name="target" inputMode="decimal" required className="num" placeholder="3000" /></FormField>
          </div>
        </ActionForm>
      </Sheet>
    </>
  );
}

export function WhatIfControls({ id, active, inPlan }: { id: string; active: boolean; inPlan: boolean }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {!inPlan && (
        <ActionForm action={toggleWhatIfAction} submit={active ? "Выключить" : "Включить"} className="inline" submitVariant="ghost" submitSize="sm">
          <input type="hidden" name="id" value={id} /><input type="hidden" name="active" value={active ? "0" : "1"} />
        </ActionForm>
      )}
      {!inPlan && (
        <ActionForm action={whatIfToPlanAction} submit="В план" className="inline" submitVariant="secondary" submitSize="sm">
          <input type="hidden" name="id" value={id} />
        </ActionForm>
      )}
      <ActionForm action={deleteWhatIfAction} submit="Удалить" className="inline" submitVariant="ghost" submitSize="sm">
        <input type="hidden" name="id" value={id} />
      </ActionForm>
    </span>
  );
}
