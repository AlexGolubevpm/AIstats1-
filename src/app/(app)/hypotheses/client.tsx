"use client";
import Link from "next/link";
import { useState, useTransition } from "react";
import { ActionForm, FormField } from "@/components/forms/action-form";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { FORMAT_LABEL } from "@/components/pages/columns";
import { createHypothesisAction, hypothesisFromAlertAction, hypothesisStatusAction, ownHypothesisStatusAction, updateHypothesisAction } from "@/server/actions/hypotheses";
import { METRIC_LABEL, METRICS, OWN_STATUS_LABEL, OWN_STATUSES } from "@/server/domain/hypotheses";

export interface SiteOption { id: string; domain: string; bundleIds: string[] }
export interface BundleOption { id: string; title: string }

export interface HypothesisValues { bundleId?: string | null; siteId?: string | null; format?: string | null; countryCode?: string | null; title?: string; hypothesis?: string; impactMonth?: string | null; metric?: string | null }

/** The fields of an own hypothesis — the same for «Новая гипотеза» and the edit form on its page. */
function HypothesisFields({ sites, bundles, formats, v = {} }: { sites: SiteOption[]; bundles: BundleOption[]; formats: string[]; v?: HypothesisValues }) {
  const [bundleId, setBundleId] = useState(v.bundleId ?? "");
  const shown = bundleId ? sites.filter((s) => s.bundleIds.includes(bundleId)) : sites;
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField name="bundleId" label="Бандл" hint="Пусто — конкретный сайт">
          <Select name="bundleId" value={bundleId} onChange={(e) => setBundleId(e.target.value)}><option value="">—</option>{bundles.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</Select>
        </FormField>
        <FormField name="siteId" label="Сайт" hint="Пусто — весь бандл">
          <Select name="siteId" defaultValue={v.siteId ?? ""}><option value="">—</option>{shown.map((s) => <option key={s.id} value={s.id}>{s.domain}</option>)}</Select>
        </FormField>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField name="format" label="Формат"><Select name="format" defaultValue={v.format ?? ""}><option value="">Любой</option>{formats.map((f) => <option key={f} value={f}>{FORMAT_LABEL[f] ?? f}</option>)}</Select></FormField>
        <FormField name="countryCode" label="Гео" hint="ISO-код, например JP"><Input name="countryCode" maxLength={2} placeholder="—" className="uppercase" defaultValue={v.countryCode ?? ""} /></FormField>
      </div>
      <FormField name="title" label="Заголовок"><Input name="title" placeholder="Поднять флор баннеров на japan-tube" required defaultValue={v.title ?? ""} /></FormField>
      <FormField name="hypothesis" label="Гипотеза"><Textarea name="hypothesis" rows={3} placeholder="Если …, то …" required defaultValue={v.hypothesis ?? ""} /></FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField name="impactMonth" label="Ожидаемый эффект, $/мес"><Input name="impactMonth" inputMode="decimal" className="num" placeholder="0" defaultValue={v.impactMonth ?? ""} /></FormField>
        <FormField name="metric" label="Чем проверяем"><Select name="metric" defaultValue={v.metric === undefined ? "rev_per_1k" : v.metric ?? ""}><option value="">—</option>{METRICS.map((k) => <option key={k} value={k}>{METRIC_LABEL[k]}</option>)}</Select></FormField>
      </div>
    </>
  );
}

/** «Новая гипотеза»: bundle and/or site, optional format and geo, the sentence, the expected effect and the metric to check it by. */
export function NewHypothesisButton({ sites, bundles, formats }: { sites: SiteOption[]; bundles: BundleOption[]; formats: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>Новая гипотеза</Button>
      <Sheet open={open} onOpenChange={setOpen} title="Новая гипотеза"
        description="Что попробовать и где. Гипотеза сразу попадает в «Наши» со статусом «Тест»; метрика за 14 дней до сегодня фиксируется как база, «Готово» измерит её снова.">
        <ActionForm action={createHypothesisAction} submit="Добавить" onDone={() => setOpen(false)} cancel={() => setOpen(false)}>
          <HypothesisFields sites={sites} bundles={bundles} formats={formats} />
        </ActionForm>
      </Sheet>
    </>
  );
}

/** The hypothesis page: own ones — every field and the note; system ones — the note only (the nightly run owns their text). */
export function EditHypothesisForm({ id, own, values, note, sites, bundles, formats }: { id: string; own: boolean; values: HypothesisValues; note: string | null; sites: SiteOption[]; bundles: BundleOption[]; formats: string[] }) {
  return (
    <div data-testid="hypothesis-edit">
    <ActionForm action={updateHypothesisAction} submit="Сохранить">
      <input type="hidden" name="id" value={id} />
      {own ? <HypothesisFields sites={sites} bundles={bundles} formats={formats} v={values} /> : (
        // the object and the text of a system proposal come from the rules; keep them so the action sees the same values
        <>{(["title", "hypothesis"] as const).map((k) => <input key={k} type="hidden" name={k} value={values[k] ?? ""} />)}</>
      )}
      <FormField name="note" label="Заметка" hint="Что сделали, что увидели, ссылки"><Textarea name="note" rows={3} defaultValue={note ?? ""} placeholder="Подняли флор до $1.2 на баннерах, сетка ушла вниз" /></FormField>
    </ActionForm>
    </div>
  );
}

/** «Тест · В работе · Готово · Отклонена» — the status of an own hypothesis, one click. */
export function OwnStatusSwitch({ id, status }: { id: string; status: string }) {
  return (
    <div className="inline-flex flex-wrap gap-1 rounded-lg border border-border p-0.5" role="group" aria-label="Статус" data-testid="own-status">
      {OWN_STATUSES.map((s) => (
        <ActionForm key={s} action={ownHypothesisStatusAction} submit={OWN_STATUS_LABEL[s]} className="inline" submitSize="sm"
          submitVariant={status === s ? "primary" : "ghost"}>
          <input type="hidden" name="id" value={id} /><input type="hidden" name="to" value={s} />
        </ActionForm>
      ))}
    </div>
  );
}

/** Accept / reject / reopen in one click; finishing asks for a note and shows the measured result afterwards. */
export function HypothesisActions({ id, status }: { id: string; status: string }) {
  const [finish, setFinish] = useState(false);
  const quick = (to: string, label: string, variant: "primary" | "secondary" | "ghost" = "secondary") => (
    <ActionForm key={to} action={hypothesisStatusAction} submit={label} className="inline" submitVariant={variant} submitSize="sm">
      <input type="hidden" name="id" value={id} /><input type="hidden" name="to" value={to} />
    </ActionForm>
  );
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5 sm:shrink-0">
      {(status === "PROPOSED" || status === "EXPIRED") && <>{quick("ACCEPTED", "Принять", "primary")}{quick("REJECTED", "Отклонить", "ghost")}</>}
      {status === "ACCEPTED" && <>
        <Button size="sm" variant="primary" onClick={() => setFinish(true)}>Завершить</Button>
        {quick("REJECTED", "Отклонить", "ghost")}
        <Sheet open={finish} onOpenChange={setFinish} title="Завершить гипотезу" description="Метрика измеряется за последние 14 дней (не раньше дня принятия) и сравнивается с базой. Что сделали и что вышло — своими словами.">
          <ActionForm action={hypothesisStatusAction} submit="Завершить" onDone={() => setFinish(false)} cancel={() => setFinish(false)}>
            <input type="hidden" name="id" value={id} /><input type="hidden" name="to" value="DONE" />
            <FormField name="note" label="Что сделали и результат"><Textarea name="note" rows={3} placeholder="Подняли флор до $1.2, сетка ушла вниз, выручка выросла" /></FormField>
          </ActionForm>
        </Sheet>
      </>}
      {(status === "DONE" || status === "REJECTED") && quick("PROPOSED", "Вернуть", "ghost")}
    </div>
  );
}

/** On /alerts: the alert becomes a hypothesis right away (the nightly run would do it too). */
export function ToHypothesisButton({ alertId, exists }: { alertId: string; exists: boolean }) {
  const [pending, start] = useTransition();
  if (exists) return <Link href="/hypotheses" className="text-xs text-accent hover:underline">в гипотезах</Link>;
  return <Button size="sm" variant="ghost" disabled={pending} onClick={() => start(() => hypothesisFromAlertAction(alertId))}>В гипотезу</Button>;
}
